import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePiUsage, parsePiText, piRunFailure, parsePiRiskEvents } from "../src/pi-events.js";
import { decideToolCall, globInventory, RISK_TOOLS } from "../src/pi-guard.js";
import { piRiskInvocation, piGenericArgs, runPi } from "../src/pi.js";
import { runAgent } from "../src/harness.js";
import { buildContext } from "../src/context.js";
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
});

// --- risk evidence -----------------------------------------------------------------
const policy = { repo: "/scratch", workdir: "/work", allowed: ["add.js", "README.md"] };
const ids = [...ok.matchAll(/"type":"tool_execution_start","toolCallId":"([^"]+)"/g)].map(m => m[1]);
const goodGuard = () => [
  { type: "ready", tools: [...RISK_TOOLS].sort() },
  { type: "guard", toolCallId: ids[0], tool: "read", allow: true, effective: "/scratch/add.js" },
  { type: "guard", toolCallId: ids[1], tool: "read", allow: true, effective: "/scratch/README.md" },
  { type: "guard", toolCallId: ids[2], tool: "read", allow: false, effective: null },
];
test("source reads are certified by guard decision plus tool result, never by the model", () => {
  const result = parsePiRiskEvents(ok, policy, goodGuard(), RISK_TOOLS);
  assert.deepEqual(result.reads.sort(), ["README.md", "add.js"]);
  assert.deepEqual(result.failedReads, ["../nonexistent/file.txt"]);
  assert.match(result.text, /add\(\)/);
});
test("risk evidence is refused when the guard is absent, misconfigured or bypassed", () => {
  const throws = (guard, pattern, tools = RISK_TOOLS, output = ok) => assert.throws(() => parsePiRiskEvents(output, policy, guard, tools), pattern);
  throws([], /guard did not load/);
  throws([{ type: "ready", tools: ["bash", "read"] }, ...goodGuard().slice(1)], /guard did not load/);
  throws(goodGuard().filter(r => r.toolCallId !== ids[0]), /without a guard decision/);
  throws(goodGuard().map(r => r.toolCallId === ids[0] ? { ...r, effective: "/etc/hostname" } : r.toolCallId === ids[1] ? { ...r, allow: false } : r), /no successful allowlisted/);
  throws([{ type: "ready", tools: ["write"] }, ...goodGuard().slice(1)], /unexpected tool/, ["write"]);
  throws(goodGuard(), /stopReason error/, RISK_TOOLS, failed);
  // Text that only claims inspection certifies nothing.
  const textOnly = ok.split("\n").filter(l => !l.includes("tool_execution")).join("\n");
  throws(goodGuard().slice(0, 1), /no successful allowlisted/, RISK_TOOLS, textOnly);
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
    for (const flag of ["--no-extensions", "--no-approve", "--offline", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-mcp"]) assert(args.includes(flag), flag);
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
  assert(args.includes("--no-extensions") && args.includes("--no-approve") && args.includes("--offline") && !args.includes("--tools"));
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
    process.env.AGENT_HARNESS = "pie"; assert.throws(() => buildContext(), /Unknown AGENT_HARNESS/);
  } finally { saved === undefined ? delete process.env.AGENT_HARNESS : (process.env.AGENT_HARNESS = saved); }
});
test("runAgent routes to the configured CLI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-both-"));
  writeFileSync(join(dir, "opencode"), `#!/bin/sh\nif [ "$1" = models ]; then echo anthropic/claude-sonnet-5-5; exit 0; fi\ncat >/dev/null\necho '{"type":"text","part":{"type":"text","text":"from-opencode"}}'\n`);
  chmodSync(join(dir, "opencode"), 0o755);
  const path = process.env.PATH;
  const pi = fakePi({ stream: ok });
  process.env.PATH = `${dir}:${pi}:${path}`;
  try {
    assert.match(await runAgent({ ...genericContext(), harness: "opencode" }, "x", { captureOutput: true }), /from-opencode/);
    assert.match(await runAgent(genericContext(), "x", { captureOutput: true }), /add\(\)/);
  } finally { process.env.PATH = path; }
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
  } finally { delete process.env.REVIEW_TOOL_POLICY; dispose(); }
});
