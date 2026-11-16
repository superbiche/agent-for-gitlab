import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePiUsage, parsePiText, piRunFailure, parsePiRiskEvents, deliveredLines } from "../src/pi-events.js";
import { decideToolCall, globInventory, RISK_TOOLS } from "../src/pi-guard.js";
import { piRiskInvocation, piGenericArgs, runPi } from "../src/pi.js";
import { runAgent } from "../src/harness.js";
import { buildContext } from "../src/context.js";
import { validateConfig } from "../src/config.js";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { summarizeUsage } from "../src/usage.js";

const fixture = name => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const ok = fixture("pi-events-ok.jsonl");       // recorded from Pi 1.5.2 with the local coder model
const failed = fixture("pi-events-error.jsonl"); // recorded from Pi 1.5.2, provider unreachable (exit status 0)

test("usage from a recorded Pi run keeps the OpenCode step/token meaning", () => {
  assert.deepEqual(parsePiUsage(ok), { steps: 2, cost: 0, input: 1521, output: 152, reasoning: 23, cache_read: 800, cache_write: 0 });
  assert.match(parsePiText(ok), /add\(\)/);
});

test("a failed provider call is read from the stream, because Pi exits 0", () => {
  assert.equal(piRunFailure(ok), null);
  assert.match(piRunFailure(failed), /stopReason error/);
  // A stream cut before the run settled is not a result.
  assert.match(piRunFailure(ok.split("\n").filter(l => !l.includes('"agent_settled"')).join("\n")), /did not settle/);
  assert.match(piRunFailure(ok.replace('"agent_settled","aborted":false', '"agent_settled","aborted":true')), /aborted/);
  // Only the documented normal terminal reason completes a run.
  const lastStop = stop => ok.replace(/("role":"assistant"[^\n]*"stopReason":)"stop"/g, `$1"${stop}"`);
  for (const stop of ["length", "toolUse", "pending", "deferred", "somethingNew", "aborted"]) assert.match(piRunFailure(lastStop(stop)), new RegExp(`stopReason ${stop}`), stop);
});

// --- risk evidence -----------------------------------------------------------------
// The recorded run read add.js and README.md; the temporary repository holds the same bytes.
const ids = [...ok.matchAll(/"type":"tool_execution_start","toolCallId":"([^"]+)"/g)].map(m => m[1]);
function evidenceWorld() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-evidence-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "add.js"), "export function add(a, b) {\n  return a - b;\n}\n");
  writeFileSync(join(repo, "README.md"), "# scratch\nTiny repo for recording Pi events.\n");
  const policy = { repo, workdir: join(root, "work"), allowed: ["add.js", "README.md"] };
  const range = { offset: 1, limit: null };
  const guard = () => [
    { type: "ready", tools: [...RISK_TOOLS].sort(), envKeys: ["PATH", "HOME"] },
    { type: "guard", toolCallId: ids[0], tool: "read", allow: true, effective: join(repo, "add.js"), range },
    { type: "guard", toolCallId: ids[1], tool: "read", allow: true, effective: join(repo, "README.md"), range },
    { type: "guard", toolCallId: ids[2], tool: "read", allow: false, effective: null, range: null },
  ];
  return { root, repo, policy, guard, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
test("source reads are certified by guard decision plus delivered content, never by the model", () => {
  const w = evidenceWorld();
  try {
    const result = parsePiRiskEvents(ok, w.policy, w.guard(), RISK_TOOLS);
    assert.deepEqual(result.reads.sort(), ["README.md", "add.js"]);
    assert.deepEqual(result.partialReads, []);
    assert.deepEqual(result.failedReads, ["../../../nonexistent/file.txt".replace(/^(\.\.\/)+/, "") && relative(w.repo, "/nonexistent/file.txt")]);
    assert.match(result.text, /add\(\)/);
  } finally { w.dispose(); }
});
test("risk evidence is refused when the guard is absent, misconfigured or bypassed", () => {
  const w = evidenceWorld();
  try {
    const throws = (guard, pattern, tools = RISK_TOOLS, output = ok) => assert.throws(() => parsePiRiskEvents(output, w.policy, guard, tools), pattern);
    const g = w.guard();
    throws([], /guard did not load/);
    throws([{ type: "ready", tools: ["bash", "read"] }, ...g.slice(1)], /guard did not load/);
    throws(g.filter(r => r.toolCallId !== ids[0]), /without a guard decision/);
    throws(g.map(r => r.toolCallId === ids[0] ? { ...r, effective: "/etc/hostname" } : r.toolCallId === ids[1] ? { ...r, allow: false } : r), /no successful allowlisted/);
    throws([{ type: "ready", tools: ["write"] }, ...g.slice(1)], /unexpected tool/, ["write"]);
    throws(g, /stopReason error/, RISK_TOOLS, failed);
    // Text that only claims inspection certifies nothing.
    throws(g.slice(0, 1), /no successful allowlisted/, RISK_TOOLS, ok.split("\n").filter(l => !l.includes("tool_execution")).join("\n"));
  } finally { w.dispose(); }
});
test("a Pi process that holds a variable the runner did not pass is refused, whatever the guard did", () => {
  const w = evidenceWorld();
  try {
    const allowed = ["PATH", "HOME"];
    assert.doesNotThrow(() => parsePiRiskEvents(ok, w.policy, w.guard(), RISK_TOOLS, allowed));
    const widened = w.guard(); widened[0] = { ...widened[0], envKeys: ["PATH", "HOME", "GITLAB_TOKEN"] };
    assert.throws(() => parsePiRiskEvents(ok, w.policy, widened, RISK_TOOLS, allowed), /not given \(GITLAB_TOKEN\)/);
    const unreported = w.guard(); delete unreported[0].envKeys;
    assert.throws(() => parsePiRiskEvents(ok, w.policy, unreported, RISK_TOOLS, allowed), /unreported/);
  } finally { w.dispose(); }
});
test("a read of a file that is not in the inventory certifies nothing, even when its content is delivered", () => {
  const w = evidenceWorld();
  try {
    writeFileSync(join(w.repo, "extra.js"), "export function add(a, b) {\n  return a - b;\n}\n");
    const g = w.guard().map(r => r.toolCallId === ids[0] ? { ...r, effective: join(w.repo, "extra.js") } : r);
    const result = parsePiRiskEvents(ok, w.policy, g, RISK_TOOLS);
    assert.deepEqual(result.reads, ["README.md"]);
    assert.ok(result.failedReads.includes("extra.js"));
  } finally { w.dispose(); }
});
test("output-token exhaustion after a valid output file is a failed run, not a review", () => {
  const w = evidenceWorld();
  try {
    const exhausted = ok.replace(/("role":"assistant"[^\n]*"stopReason":)"stop"/g, '$1"length"');
    assert.match(piRunFailure(exhausted), /stopReason length/);
    assert.throws(() => parsePiRiskEvents(exhausted, w.policy, w.guard(), RISK_TOOLS), /stopReason length/);
  } finally { w.dispose(); }
});

// --- what a read delivered, against Pi's own read tool ---------------------------------------
test("partial coverage is reported as partial with its lines; full coverage needs every line", () => {
  const w = evidenceWorld();
  try {
    const mk = (id, file, offset, limit, text, details) => [
      { type: "tool_execution_start", toolCallId: id, toolName: "read", args: {} },
      { type: "tool_execution_end", toolCallId: id, toolName: "read", isError: false, result: { content: [{ type: "text", text }], details } },
    ];
    const settle = [{ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "{}" }], usage: {} } }, { type: "agent_settled", aborted: false }];
    const stream = events => events.map(e => JSON.stringify(e)).join("\n");
    const g = (id, offset, limit) => ({ type: "guard", toolCallId: id, tool: "read", allow: true, effective: join(w.repo, "add.js"), range: { offset, limit } });
    const ready = { type: "ready", tools: [...RISK_TOOLS].sort() };
    const first = "export function add(a, b) {\n\n[3 more lines in file. Use offset=2 to continue.]";
    const head = stream([...mk("a", "add.js", 1, 1, first, {}), ...settle]);
    // add.js has 4 "lines" (trailing newline): only line 1 delivered.
    const partial = parsePiRiskEvents(head, w.policy, [ready, g("a", 1, 1)], RISK_TOOLS);
    assert.deepEqual(partial.reads, []);
    assert.deepEqual(partial.partialReads, ["add.js (lines 1-1 of 4)"]);
    const both = stream([...mk("a", "add.js", 1, 1, first, {}), ...mk("b", "add.js", 2, null, "  return a - b;\n}\n", {}), ...settle]);
    const full = parsePiRiskEvents(both, w.policy, [ready, g("a", 1, 1), g("b", 2, null)], RISK_TOOLS);
    assert.deepEqual(full.reads, ["add.js"]);
    assert.deepEqual(full.partialReads, []);
    // Disjoint reads stay disjoint: lines 1 and 3-4 are not the whole file.
    const gap = stream([...mk("a", "add.js", 1, 1, first, {}), ...mk("c", "add.js", 3, null, "}\n", {}), ...settle]);
    const gapped = parsePiRiskEvents(gap, w.policy, [ready, g("a", 1, 1), g("c", 3, null)], RISK_TOOLS);
    assert.deepEqual(gapped.reads, []);
    assert.deepEqual(gapped.partialReads, ["add.js (lines 1-1, 3-4 of 4)"]);
    // Zero-content or notice-only reads are not evidence at all.
    const zero = stream([...mk("a", "add.js", 1, 0, "\n\n[4 more lines in file. Use offset=1 to continue.]", {}), ...settle]);
    assert.throws(() => parsePiRiskEvents(zero, w.policy, [ready, g("a", 1, 0)], RISK_TOOLS), /no successful allowlisted/);
  } finally { w.dispose(); }
});

// --- guard policy ------------------------------------------------------------------
function world() {
  const root = mkdtempSync(join(tmpdir(), "pi-guard-"));
  const repo = join(root, "repo"), work = join(root, "work");
  mkdirSync(repo); mkdirSync(work);
  writeFileSync(join(repo, "safe.js"), "x"); writeFileSync(join(repo, "denied.js"), "y"); writeFileSync(join(root, "outside.txt"), "z");
  symlinkSync(join(root, "outside.txt"), join(repo, "link.js"));
  symlinkSync(join(root, "outside.txt"), join(work, "findings.json"));
  const outputs = [join(root, "review-findings.json"), join(work, "findings.json")];
  return { root, p: { repo, workdir: work, allowed: ["safe.js", "link.js"], outputs }, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
test("guard allows only inventory reads and the two output writes", () => {
  const { root, p, dispose } = world();
  try {
    const call = (toolName, input) => decideToolCall(p, { toolName, input });
    assert.equal(call("read", { path: join(p.repo, "safe.js") }).allow, true);
    assert.equal(call("read", { path: "../repo/safe.js" }).allow, true);
    assert.equal(call("read", { path: "../repo/safe.js" }).input.path, join(p.repo, "safe.js"), "executes the canonical path it checked");
    for (const path of [join(p.repo, "denied.js"), join(root, "outside.txt"), "/etc/hostname", "/proc/self/environ", "../outside.txt", "~/x", "@safe.js", "", join(p.repo, "link.js"), join(p.repo, "..", "outside.txt"), "safe.js\0"]) assert.equal(call("read", { path }).allow, false, String(path));
    assert.equal(call("read", { path: join(p.repo, "safe.js"), extra: 1 }).allow, false);
    assert.equal(call("write", { path: p.outputs[0], content: "{}" }).allow, true);
    assert.equal(call("write", { path: join(root, "elsewhere.json"), content: "{}" }).allow, false);
    assert.equal(call("write", { path: p.outputs[1], content: "{}" }).allow, false, "a link planted at the output path redirects nothing");
    for (const toolName of ["bash", "edit", "grep", "find", "ls", "webfetch", "task", "codemode", "tool_search", "mcp__x__y", ""]) assert.equal(call(toolName, {}).allow, false, toolName);
    for (const toolName of ["glob", "source_search", "public_fetch", "dependency_read"]) assert.equal(call(toolName, {}).allow, true, toolName);
  } finally { dispose(); }
});
test("the reviewer's case: two files differing by one Unicode space, one excluded, never reach the excluded one", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-twin-"));
  const repo = join(root, "repo"), work = join(root, "work");
  mkdirSync(repo); mkdirSync(work);
  const harmless = join(repo, "a\u00A0b.txt"), excluded = join(repo, "a b.txt");
  writeFileSync(harmless, "HARMLESS"); writeFileSync(excluded, "EXCLUDED_SECRET");
  const p = { repo, workdir: work, allowed: ["a\u00A0b.txt", "ok.txt"] };
  writeFileSync(join(repo, "ok.txt"), "fine");
  try {
    const read = (path, extra = {}) => decideToolCall(p, { toolName: "read", input: { path, ...extra } });
    // Pi rewrites the no-break space to a plain one: the approved file is not the file opened.
    assert.equal(read(harmless).allow, false);
    assert.equal(read(excluded).allow, false);
    assert.equal(read(`@${join(repo, "ok.txt")}`).allow, false, "a spelling Pi rewrites is refused outright");
    assert.equal(read(`file://${join(repo, "ok.txt")}`).allow, false);
    assert.equal(read("../repo/ok.txt").allow, true);
    assert.equal(read(join(repo, "ok.txt"), { limit: 0 }).allow, false, "a zero limit delivers nothing");
    assert.equal(read(join(repo, "ok.txt"), { offset: 0 }).allow, false);
    assert.equal(read(join(repo, "ok.txt"), { offset: 1.5 }).allow, false);
    const range = read(join(repo, "ok.txt"), { offset: 2, limit: 3 });
    assert.deepEqual(range.range, { offset: 2, limit: 3 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("every spelling Pi may open must be approved, and the executed path must survive Pi's own rewriting", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-cand-"));
  const repo = join(root, "repo"), work = join(root, "work"), odd = join(root, "re\u00A0po");
  mkdirSync(repo); mkdirSync(work); mkdirSync(odd);
  try {
    // "café.txt" in NFC is approved; its NFD twin (a spelling `read` tries) exists and is not.
    writeFileSync(join(repo, "caf\u00E9.txt"), "approved"); writeFileSync(join(repo, "cafe\u0301.txt"), "twin");
    writeFileSync(join(repo, "plain.txt"), "ok");
    const p = { repo, workdir: work, allowed: ["caf\u00E9.txt", "plain.txt"] };
    assert.equal(decideToolCall(p, { toolName: "read", input: { path: join(repo, "plain.txt") } }).allow, true);
    assert.equal(decideToolCall(p, { toolName: "read", input: { path: join(repo, "caf\u00E9.txt") } }).allow, false, "an unapproved spelling Pi may open makes the read refused");
    // A link in the work directory to a directory whose real name holds a no-break space: the argument
    // is plain, but the canonical path Pi would be handed is not, and Pi would open a different file.
    writeFileSync(join(odd, "ok.txt"), "fine");
    symlinkSync(odd, join(work, "link"));
    const q = { repo: odd, workdir: work, allowed: ["ok.txt"] };
    const call = decideToolCall(q, { toolName: "read", input: { path: "link/ok.txt" } });
    assert.equal(call.allow, false);
    assert.match(call.reason, /cannot be addressed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("a base directory whose name holds a Unicode space is that directory, not its ASCII twin", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-base-"));
  const repo = join(root, "repo"), nb = join(root, "w\u00A0d"), plain = join(root, "w d");
  mkdirSync(repo); mkdirSync(nb); mkdirSync(plain);
  writeFileSync(join(repo, "ok.txt"), "fine");
  symlinkSync(repo, join(nb, "r")); // NOT in the inventory as a link
  try {
    const p = { repo, workdir: nb, allowed: ["ok.txt"] };
    assert.equal(decideToolCall(p, { toolName: "read", input: { path: "../repo/ok.txt" } }).allow, true);
    // from the twin base the relative spelling points elsewhere and is judged as such
    assert.equal(decideToolCall({ ...p, workdir: plain }, { toolName: "read", input: { path: "../repo/ok.txt" } }).effective, join(repo, "ok.txt"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("glob lists only the approved inventory", () => {
  const allowed = ["src/a.js", "src/deep/b.js", "README.md", ".hidden/c.txt"];
  assert.deepEqual(globInventory(allowed, "*.js").matches, ["src/a.js", "src/deep/b.js"]);
  assert.deepEqual(globInventory(allowed, "src/*.js").matches, ["src/a.js"]);
  assert.deepEqual(globInventory(allowed, "**/*.js").matches, ["src/a.js", "src/deep/b.js"]);
  assert.deepEqual(globInventory(allowed, "*.php").matches, []);
  assert.deepEqual(globInventory(allowed, "**").matches, allowed, "nothing outside the inventory can be listed");
  assert.throws(() => globInventory(allowed, ""));
});

// --- invocation -----------------------------------------------------------------------
const riskContext = (extra = {}) => ({ opencodeModel: "deepseek/deepseek-flash", sourcePolicy: { repo: process.cwd(), allowed: ["src/pi.js"], excluded: [] }, ...extra });
test("risk invocation: tool selection, no project resources, no network side channels, minimal environment", () => {
  const saved = { gitlab: process.env.GITLAB_TOKEN, github: process.env.GITHUB_TOKEN, ci: process.env.CI_JOB_TOKEN, ds: process.env.DEEPSEEK_API_KEY };
  Object.assign(process.env, { GITLAB_TOKEN: "x", GITHUB_TOKEN: "x", CI_JOB_TOKEN: "x", DEEPSEEK_API_KEY: "model-key" });
  const invocation = piRiskInvocation(riskContext());
  try {
    const args = invocation.args;
    const value = flag => args[args.indexOf(flag) + 1];
    assert.equal(value("--tools"), RISK_TOOLS.join(","));
    assert.equal(value("--model"), "deepseek/deepseek-flash");
    for (const flag of ["--no-extensions", "--no-approve", "--offline", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp"]) assert(args.includes(flag), flag);
    assert(!args.includes("--approve"));
    assert.match(value("-e"), /src\/pi-extension\.js$/);
    assert.equal(existsSync(value("-e")), true);
    assert.equal(existsSync(join(invocation.options.cwd, ".git")), false);
    const env = invocation.options.env;
    assert.deepEqual(Object.keys(env).sort(), ["DEEPSEEK_API_KEY", "HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "REVIEW_TOOL_POLICY"]);
    assert.equal(env.PI_OFFLINE, "1");
    assert.notEqual(env.HOME, process.env.HOME);
    assert(env.PI_CODING_AGENT_DIR.startsWith(invocation.isolationRoot));
    const written = JSON.parse(readFileSync(env.REVIEW_TOOL_POLICY, "utf8"));
    assert.deepEqual(written.policy.allowed, ["src/pi.js"]);
    assert.equal(written.workdir, invocation.options.cwd);
  } finally {
    rmSync(invocation.isolationRoot, { recursive: true, force: true });
    for (const [key, name] of [["gitlab", "GITLAB_TOKEN"], ["github", "GITHUB_TOKEN"], ["ci", "CI_JOB_TOKEN"], ["ds", "DEEPSEEK_API_KEY"]]) saved[key] === undefined ? delete process.env[name] : (process.env[name] = saved[key]);
  }
});
test("risk invocation refuses other providers and a temporary directory inside a Git worktree", () => {
  assert.throws(() => piRiskInvocation(riskContext({ opencodeModel: "anthropic/x" })), /DeepSeek/);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = process.cwd();
  try { assert.throws(() => piRiskInvocation(riskContext()), /outside any Git worktree/); }
  finally { previous === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = previous); }
});
test("generic invocation matches OpenCode's --pure --auto: default tools, no extension, no project approval", () => {
  const args = piGenericArgs({ opencodeModel: "anthropic/claude-sonnet-5-5" });
  assert(args.includes("--no-extensions") && args.includes("--no-approve") && args.includes("--offline") && args.includes("--no-mcp") && !args.includes("--tools"));
  assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-sonnet-5-5");
});

// --- runner with a fake pi on PATH ----------------------------------------------------
function fakePi({ stream, exit = 0, models = "anthropic  claude-sonnet-5-5  200K  64K  yes  yes" }) {
  const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
  writeFileSync(join(dir, "stream.jsonl"), stream);
  writeFileSync(join(dir, "pi"), `#!/bin/sh
if [ "$1" = --list-models ]; then echo "provider  model"; echo "${models}"; exit 0; fi
printf '%s\\n' "$@" > "${dir}/argv"
cat > "${dir}/stdin"
cat "${dir}/stream.jsonl"
exit ${exit}
`);
  chmodSync(join(dir, "pi"), 0o755);
  return dir;
}
async function withFake(opts, fn) {
  const dir = fakePi(opts), path = process.env.PATH, bin = process.env.PI_BIN;
  process.env.PATH = `${dir}:${path}`; delete process.env.PI_BIN;
  try { return await fn(dir); } finally { process.env.PATH = path; if (bin !== undefined) process.env.PI_BIN = bin; }
}
const genericContext = () => ({ opencodeModel: "anthropic/claude-sonnet-5-5", reviewProfile: "standard", agentPrompt: "", usage: [], harness: "pi" });

test("a successful Pi call returns the text and records per-call usage", async () => {
  await withFake({ stream: ok }, async dir => {
    const context = genericContext();
    const text = await runPi(context, "x", { captureOutput: true, label: "prompt" });
    assert.match(text, /add\(\)/);
    const { total, calls } = summarizeUsage(context.usage);
    assert.equal(calls.length, 1);
    assert.deepEqual([total.input, total.output, total.reasoning, total.cache_read, total.complete], [1521, 152, 23, 800, true]);
    assert.match(readFileSync(join(dir, "stdin"), "utf8"), /^\nx/);
  });
});
test("a Pi call that fails with exit status 0 still fails the run and is accounted as a lower bound", async () => {
  await withFake({ stream: failed }, async () => {
    const context = genericContext();
    await assert.rejects(runPi(context, "x", { captureOutput: true, label: "findings" }), /pi CLI failed: Pi run ended with stopReason error/);
    assert.equal(summarizeUsage(context.usage).total.complete, false);
  });
});
test("a non-zero exit fails the run and keeps the steps already paid for", async () => {
  await withFake({ stream: ok, exit: 1 }, async () => {
    const context = genericContext();
    await assert.rejects(runPi(context, "x", { captureOutput: true, label: "findings" }), /pi CLI failed/);
    const { total } = summarizeUsage(context.usage);
    assert.deepEqual([total.input, total.complete], [1521, false]);
  });
});
test("a model Pi does not know fails before any model call, naming the cause", async () => {
  await withFake({ stream: ok, models: "anthropic  other-model" }, async dir => {
    await assert.rejects(runPi({ ...genericContext(), opencodeModel: "anthropic/claude-sonnet-4-20250514" }, "x", { captureOutput: true }), /pi does not know model anthropic\/claude-sonnet-4-20250514/);
    assert.equal(existsSync(join(dir, "argv")), false);
  });
});

// --- selection ----------------------------------------------------------------------
test("the harness is selected by configuration; OpenCode stays the default and a typo is an error", () => {
  const saved = process.env.AGENT_HARNESS;
  try {
    delete process.env.AGENT_HARNESS; assert.equal(buildContext().harness, "opencode");
    process.env.AGENT_HARNESS = ""; assert.equal(buildContext().harness, "opencode");
    process.env.AGENT_HARNESS = " Pi "; assert.equal(buildContext().harness, "pi");
    // Building the context never throws; validation (inside the runner's error path) does.
    process.env.AGENT_HARNESS = "pie";
    const context = buildContext();
    assert.throws(() => validateConfig({ ...context, dryRun: true }), /Unknown AGENT_HARNESS "pie"/);
    assert.throws(() => runAgent(context, "x"), /Unknown AGENT_HARNESS/);
  } finally { saved === undefined ? delete process.env.AGENT_HARNESS : (process.env.AGENT_HARNESS = saved); }
});
test("PI_MODEL overrides the webhook's OPENCODE_MODEL for Pi only", () => {
  const saved = { h: process.env.AGENT_HARNESS, m: process.env.OPENCODE_MODEL, p: process.env.PI_MODEL };
  try {
    process.env.OPENCODE_MODEL = "deepseek/deepseek-v4-flash"; process.env.PI_MODEL = "deepseek/deepseek-flash";
    delete process.env.AGENT_HARNESS; assert.equal(buildContext().opencodeModel, "deepseek/deepseek-v4-flash");
    process.env.AGENT_HARNESS = "opencode"; assert.equal(buildContext().opencodeModel, "deepseek/deepseek-v4-flash");
    process.env.AGENT_HARNESS = "pi"; assert.equal(buildContext().opencodeModel, "deepseek/deepseek-flash");
    delete process.env.PI_MODEL; assert.equal(buildContext().opencodeModel, "deepseek/deepseek-v4-flash");
  } finally { for (const [k, v] of [["AGENT_HARNESS", saved.h], ["OPENCODE_MODEL", saved.m], ["PI_MODEL", saved.p]]) v === undefined ? delete process.env[k] : (process.env[k] = v); }
});
test("an unknown harness ends in the runner's error path: exit 1, a fresh failed artifact, no stack trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "bad-harness-"));
  const artifact = join(dir, "ai-output.json");
  writeFileSync(artifact, JSON.stringify({ success: true, stale: true }));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../ai-runner.js", import.meta.url))], {
      cwd: dir, encoding: "utf8",
      env: { PATH: process.env.PATH, AGENT_HARNESS: "bogus", AI_DRY_RUN: "1", AI_OUTPUT_PATH: artifact, DIRECT_PROMPT: "review" },
    });
    assert.equal(result.status, 1);
    const output = JSON.parse(readFileSync(artifact, "utf8"));
    assert.equal(output.success, false);
    assert.equal(output.stale, undefined, "the earlier artifact was replaced, not reused");
    assert.match(output.error, /Unknown AGENT_HARNESS "bogus"/);
    assert.doesNotMatch(result.stderr, /Fatal error|\n\s+at /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("a Pi run cut off by output-token exhaustion fails even though the output file was written first", async () => {
  const exhausted = ok.replace(/("role":"assistant"[^\n]*"stopReason":)"stop"/g, '$1"length"');
  await withFake({ stream: exhausted }, async () => {
    const context = genericContext();
    const output = join(mkdtempSync(join(tmpdir(), "written-output-")), "review-findings.json");
    writeFileSync(output, '{"issues":[],"inspected":["a.js"],"limitations":[]}');   // valid output, written before the exhaustion
    await assert.rejects(runPi(context, "x", { captureOutput: true, label: "findings" }), /pi CLI failed: Pi run ended with stopReason length/);
    assert.equal(existsSync(output), true);
    assert.equal(summarizeUsage(context.usage).total.complete, false);
  });
});
test("runAgent routes to the configured CLI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-both-"));
  writeFileSync(join(dir, "opencode"), `#!/bin/sh\nif [ "$1" = models ]; then echo anthropic/claude-sonnet-5-5; exit 0; fi\ncat >/dev/null\necho '{"type":"text","part":{"type":"text","text":"from-opencode"}}'\n`);
  chmodSync(join(dir, "opencode"), 0o755);
  const path = process.env.PATH, bin = process.env.PI_BIN;
  const pi = fakePi({ stream: ok });
  process.env.PATH = `${dir}:${pi}:${path}`; delete process.env.PI_BIN;
  try {
    assert.match(await runAgent({ ...genericContext(), harness: "opencode" }, "x", { captureOutput: true }), /from-opencode/);
    assert.match(await runAgent(genericContext(), "x", { captureOutput: true }), /add\(\)/);
  } finally { process.env.PATH = path; if (bin !== undefined) process.env.PI_BIN = bin; }
});

// --- the extension loaded into Pi ---------------------------------------------------
test("the extension registers the image-owned tools, narrows the active set and guards every call", async () => {
  const { root, p, dispose } = world();
  const policyPath = join(root, "policy.json");
  writeFileSync(policyPath, JSON.stringify({ policy: { repo: p.repo, allowed: p.allowed }, workdir: p.workdir, evidencePath: join(root, "evidence.jsonl"), guardPath: join(root, "guard.jsonl"), outputs: p.outputs }));
  process.env.REVIEW_TOOL_POLICY = policyPath;
  try {
    const { default: extension } = await import("../src/pi-extension.js");
    const registered = [], handlers = {}, active = [];
    extension({ registerTool: t => registered.push(t.name), on: (name, handler) => { handlers[name] = handler; }, setActiveTools: t => active.splice(0, active.length, ...t), getActiveTools: () => active });
    assert.deepEqual(registered.sort(), ["dependency_read", "glob", "public_fetch", "source_search"]);
    await handlers.session_start();
    assert.deepEqual(active, [...RISK_TOOLS]);
    const bash = await handlers.tool_call({ toolName: "bash", toolCallId: "c1", input: { command: "id" } });
    assert.equal(bash.block, true);
    const input = { path: "../repo/safe.js" };
    assert.equal(await handlers.tool_call({ toolName: "read", toolCallId: "c2", input }), undefined);
    assert.equal(input.path, join(p.repo, "safe.js"));
    const records = readFileSync(join(root, "guard.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(records.map(r => [r.type, r.allow ?? r.tools.length]), [["ready", RISK_TOOLS.length], ["guard", false], ["guard", true]]);
    assert.ok(records[0].envKeys.includes("REVIEW_TOOL_POLICY") && records[0].envKeys.every(k => typeof k === "string"), "the ready record names the process's variables (never their values)");
  } finally { delete process.env.REVIEW_TOOL_POLICY; dispose(); }
});
