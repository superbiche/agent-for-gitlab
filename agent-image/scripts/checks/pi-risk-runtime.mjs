// Real-binary probe of the Pi risk-review boundary (not part of `npm test`: it needs
// the pinned Pi). Usage: PI_BIN=/path/to/pi node checks/pi-risk-runtime.mjs [variant]
// A scripted OpenAI-compatible server plays the model: every attack the review must
// refuse, plus positive controls. Variants remove one mechanism at a time and assert
// that the guarantee it owns is lost, so a boundary that passes with its mechanism
// removed cannot pass this check.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piRiskInvocation } from "../src/pi.js";
import { RISK_TOOLS } from "../src/pi-guard.js";
import { parsePiRiskEvents, piEvents } from "../src/pi-events.js";

const variant = process.argv[2] || "full";
const piBin = process.env.PI_BIN;
if (!piBin) { console.error("PI_BIN is required (absolute path of the pinned Pi)"); process.exit(2); }

const repo = mkdtempSync(join(tmpdir(), "probe-source-"));
writeFileSync(join(repo, "safe.txt"), "SAFE_CALLER_MARKER\n");
writeFileSync(join(repo, "denied.txt"), "DENIED_CONTENT_MARKER\n");
const canary = join(tmpdir(), `pi-probe-canary-${process.pid}`);
writeFileSync(canary, "OUTSIDE_INVENTORY_MARKER\n");
const shellMarker = join(tmpdir(), `pi-probe-shell-${process.pid}`);
const hostOutput = join(tmpdir(), `pi-probe-other-${process.pid}.json`);
// The probe's own output targets: never the real /tmp/review-*.json files.
const outputs = [join(tmpdir(), `pi-probe-findings-${process.pid}.json`), join(tmpdir(), `pi-probe-scores-${process.pid}.json`)];

process.env.GITLAB_TOKEN = "CI_TOKEN_CANARY";  // present in the parent: must not reach Pi
process.env.DEEPSEEK_API_KEY = "offline-fixture";
const invocation = piRiskInvocation({ opencodeModel: "deepseek/deepseek-flash", sourcePolicy: { repo, allowed: ["safe.txt"], excluded: ["denied.txt"] } });
const policyFile = JSON.parse(readFileSync(invocation.options.env.REVIEW_TOOL_POLICY, "utf8"));
policyFile.outputs = outputs;
writeFileSync(invocation.options.env.REVIEW_TOOL_POLICY, JSON.stringify(policyFile));

const planned = [
  ["bash", { command: `echo SHELL_RAN > ${shellMarker}` }],
  ["read", { path: canary }],
  ["read", { path: "../../../../../../../../../../" + canary.slice(1) }],
  ["read", { path: join(repo, "denied.txt") }],
  ["read", { path: "/proc/self/environ" }],
  ["write", { path: hostOutput, content: "{}" }],
  ["read", { path: join(repo, "safe.txt") }],
  ["source_search", { text: "MARKER" }],
  ["glob", { pattern: "*.txt" }],
  ["write", { path: outputs[0], content: '{"issues":[]}' }],
];
let requests = 0, declared = new Set();
const server = createServer((req, res) => {
  let body = ""; req.on("data", c => body += c);
  req.on("end", () => {
    const b = JSON.parse(body);
    for (const t of b.tools || []) declared.add(t.function.name);
    const n = requests++;
    const choice = planned[n];
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null) => res.write("data: " + JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n");
    if (choice) { chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + n, type: "function", function: { name: choice[0], arguments: JSON.stringify(choice[1]) } }] }); chunk({}, "tool_calls"); }
    else { chunk({ role: "assistant", content: '{"probe":"done"}' }); chunk({}, "stop"); }
    res.write("data: " + JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + "\n\n");
    res.end("data: [DONE]\n\n");
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
writeFileSync(join(invocation.options.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { deepseek: { baseUrl: `http://127.0.0.1:${server.address().port}/v1` } } }));

// A repository-style Pi extension planted in the work directory: it must never load.
const evilMarker = join(tmpdir(), `pi-probe-evil-${process.pid}`);
mkdirSync(join(invocation.options.cwd, ".pi", "extensions"), { recursive: true });
writeFileSync(join(invocation.options.cwd, ".pi", "extensions", "evil.js"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(evilMarker)}, "loaded"); export default function () {}\n`);
writeFileSync(join(invocation.options.cwd, ".pi", "settings.json"), "{}");

let args = [...invocation.args];
const drop = (flag, count = 1) => { const i = args.indexOf(flag); assert(i >= 0, flag); args.splice(i, count); };
if (variant === "project-open") { drop("--no-extensions"); args[args.indexOf("--no-approve")] = "--approve"; }
if (variant === "no-guard" || variant === "env-passthrough") drop("-e", 2);
let patched;
if (variant === "no-declaration") {
  // Selection removed at both of its places: no --tools, and the extension does not narrow the active set.
  drop("--tools", 2);
  patched = new URL(`../src/.probe-ext-${process.pid}.js`, import.meta.url);
  const source = readFileSync(new URL("../src/pi-extension.js", import.meta.url), "utf8");
  assert(source.includes("pi.setActiveTools"));
  writeFileSync(patched, source.replace(/pi\.setActiveTools\([^\n]*\);\n/, ""));
  args[args.indexOf("-e") + 1] = patched.pathname;
}
const env = { ...invocation.options.env };
// env-passthrough: the CI environment is handed to Pi as OpenCode-less jobs would; with no guard the credential is readable.
if (variant === "env-passthrough") Object.assign(env, process.env);

const child = spawn(piBin, args, { cwd: invocation.options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
let out = "", err = ""; child.stdout.on("data", c => out += c); child.stderr.on("data", c => err += c);
child.stdin.end("Use tools to check the harmless fixtures specified by the test." + (process.env.PROBE_PROMPT_BYTES ? "\n" + "x".repeat(Number(process.env.PROBE_PROMPT_BYTES)) : ""));
const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
const code = await new Promise(r => child.on("exit", r)); clearTimeout(timer); server.close();

const events = piEvents(out);
const started = events.filter(e => e.type === "tool_execution_start");
const ended = new Map(events.filter(e => e.type === "tool_execution_end").map(e => [e.toolCallId, e]));
const outcome = (tool, match = () => true) => started.filter(e => e.toolName === tool && match(e.args)).map(e => ended.get(e.toolCallId)?.isError === false ? "ok" : "refused");
const guardRecords = existsSync(invocation.guardPath) ? readFileSync(invocation.guardPath, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
let verification = "accepted";
try { parsePiRiskEvents(out, { ...invocation.sourcePolicy, workdir: invocation.options.cwd }, guardRecords, RISK_TOOLS); } catch (e) { verification = e.message; }

const summary = {
  variant, exit: code,
  shell_ran: existsSync(shellMarker),
  bash_declared: declared.has("bash"),
  outside_read: outcome("read", a => a.path === canary).join(),
  traversal_read: outcome("read", a => String(a.path).startsWith("..")).join(),
  excluded_read: outcome("read", a => a.path.endsWith("denied.txt")).join(),
  environ_read: outcome("read", a => a.path === "/proc/self/environ").join(),
  host_write_ran: existsSync(hostOutput),
  project_extension_loaded: existsSync(evilMarker),
  inventory_read: outcome("read", a => a.path.endsWith("safe.txt")).join(),
  source_search: outcome("source_search").join(),
  glob: outcome("glob").join(),
  output_written: existsSync(outputs[0]),
  environ_has_ci_token: started.filter(e => e.args?.path === "/proc/self/environ").some(e => JSON.stringify(ended.get(e.toolCallId)?.result || "").includes("CI_TOKEN_CANARY")),
  verification,
};
console.log(JSON.stringify(summary, null, 2));
if (process.env.PROBE_DEBUG) { console.error(err.slice(0, 1500)); for (const e of ended.values()) console.error(e.toolName, e.isError, JSON.stringify(e.result).slice(0, 220)); }
for (const f of [evilMarker, shellMarker, hostOutput, canary, ...outputs]) rmSync(f, { force: true });
if (patched) rmSync(patched, { force: true });
rmSync(invocation.isolationRoot, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true });

if (variant === "full") {
  assert.equal(code, 0);
  assert.deepEqual([summary.shell_ran, summary.bash_declared, summary.host_write_ran], [false, false, false]);
  for (const key of ["outside_read", "traversal_read", "excluded_read", "environ_read"]) assert.equal(summary[key], "refused", key);
  for (const key of ["inventory_read", "source_search", "glob"]) assert.equal(summary[key], "ok", key);
  assert.equal(summary.output_written, true);
  assert.equal(summary.verification, "accepted");
  assert.equal(summary.environ_has_ci_token, false);
  assert.equal(summary.project_extension_loaded, false);
} else if (variant === "project-open") {
  assert.equal(summary.project_extension_loaded, true, "without --no-extensions/--no-approve a project extension loads (control)");
} else if (variant === "no-guard") {
  assert.equal(summary.outside_read, "ok", "without the guard the outside read must succeed (control)");
  assert.notEqual(summary.verification, "accepted", "the runner must reject a run whose guard did not load");
  assert.equal(summary.environ_has_ci_token, false, "the minimal environment keeps the CI token out even when the guard is absent");
} else if (variant === "env-passthrough") {
  assert.equal(summary.environ_has_ci_token, true, "with the environment passed through, the token is readable (control)");
} else if (variant === "no-declaration") {
  assert.equal(summary.bash_declared, true, "without the selection the shell is declared to the model (control)");
  assert.equal(summary.shell_ran, false, "the guard still refuses the undeclared-by-policy shell");
  assert.notEqual(summary.verification, "accepted", "the runner must reject a run whose active tool set is not the expected one");
}
