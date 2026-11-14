// Mutation check for the Pi runner: each entry removes ONE named mechanism from a copy of
// the sources and the Pi tests must then fail. A mechanism whose removal leaves the tests
// green is not tested. Usage: node verification/pi-mutations.mjs   (exit 1 on a survivor)
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("..", import.meta.url));
// The path-rule and native-read tests compare against the installed Pi; without it a mutant of those
// rules would survive for the wrong reason, so the run refuses to start.
if (!process.env.PI_DIST && !existsSync(join(scripts, "../pi-bootstrap/node_modules"))) { console.error("PI_DIST (or an installed agent-image/pi-bootstrap) is required"); process.exit(2); }
// The tests call `git log` in the working directory, so each copy is a throwaway repository.
function makeCopy() {
  const copy = mkdtempSync(join(tmpdir(), "pi-mutation-"));
  // agent-image/ as a whole: the tests read ../pi-bootstrap/package.json (the Pi pin).
  cpSync(join(scripts, ".."), join(copy, "agent-image"), { recursive: true, filter: source => !source.includes("node_modules") });
  const git = (...args) => spawnSync("git", ["-c", "user.name=m", "-c", "user.email=m@example.invalid", ...args], { cwd: copy, stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "copy");
  return copy;
}
const work = copy => join(copy, "agent-image", "scripts");
const mutations = [
  // guarantee: no shell, no other tools (tool allowlist, deny by default)
  ["tool-allowlist", "src/pi-guard.js", 'if (!tools.includes(toolName)) return { allow: false', 'if (false) return { allow: false'],
  ["tool-selection-flag", "src/pi.js", '"--tools", RISK_TOOLS.join(","),', ""],
  ["tool-declaration-narrowing", "src/pi-extension.js", "pi.setActiveTools([...RISK_TOOLS]);", ""],
  // guarantee: reads only inside the approved inventory (also keeps credentials and /proc out)
  ["read-inventory", "src/pi-guard.js", "targets.some(target => !target || !permitted.has(target))", "targets.some(target => !target)"],
  ["read-link-inventory", "src/pi-guard.js", "root && target === join(root, file)", "root && target"],
  ["read-output-link", "src/pi-guard.js", "output === join(parent, basename(file))", "output"],
  ["canonical-execution", "src/pi-guard.js", "input: { ...input, path: target }", "input"],
  // guarantee: writes only the two outputs
  ["write-outputs", "src/pi-guard.js", "if (!path || !outputs.includes(path))", "if (!path)"],
  ["write-link", "src/pi-guard.js", "(existing && existing !== join(parent, basename(path)))", "false"],
  ["argument-shape", "src/pi-guard.js", 'if (!keysWithin(input, ["path", "offset", "limit"]))', "if (false)"],
  // guarantee: every call is decided before it runs
  ["guard-blocks", "src/pi-extension.js", "if (!decision.allow) return { block: true, reason: decision.reason };", ""],
  ["guard-mutates-input", "src/pi-extension.js", "Object.assign(event.input, decision.input);", ""],
  ["guard-record", "src/pi-extension.js", 'record({ type: "guard"', 'void ({ type: "guard"'],
  // guarantee: the runner refuses evidence it cannot trust
  ["evidence-ready-set", "src/pi-events.js", "if (ready.length !== 1 ||", "if (false &&"],
  ["evidence-unguarded-call", "src/pi-events.js", "if (results.get(start.toolCallId)?.isError === true) continue;", "continue;"],
  ["evidence-unexpected-tool", "src/pi-events.js", "if (!expectedTools.includes(start.toolName)) throw", "if (false) throw"],
  ["evidence-effective-path", "src/pi-events.js", "allowed.has(file) ?", "true ?"],
  ["failure-from-stream", "src/pi-events.js", 'if (last.stopReason !== "stop")', "if (false)"],
  ["failure-settled", "src/pi-events.js", 'if (!events.some(e => e.type === "agent_settled"))', "if (false)"],
  ["failure-exit-zero", "src/pi.js", "if (failure) throw", "if (false) throw"],
  // guarantee: no credentials, no repository configuration, nothing fetched at job time
  ["env-minimal", "src/pi.js", "PI_CODING_AGENT_DIR: agentDir,", "PI_CODING_AGENT_DIR: agentDir, GITLAB_TOKEN: process.env.GITLAB_TOKEN,"],
  ["no-project-resources", "src/pi.js", '"--no-extensions", "-e", extension,', '"-e", extension,'],
  ["no-project-approval", "src/pi.js", '"--no-context-files", "--no-mcp", "--no-approve",', '"--no-context-files", "--no-mcp",'],
  ["offline-flag-generic", "src/pi.js", 'return ["--mode", "json", "--no-session", "--offline",', 'return ["--mode", "json", "--no-session",'],
  ["offline-flag-risk", "src/pi.js", '"--mode", "json", "--no-session", "--offline",\n        "--no-extensions"', '"--mode", "json", "--no-session",\n        "--no-extensions"'],
  ["offline-env", "src/pi.js", 'PI_OFFLINE: "1", ', ""],
  ["non-git-cwd", "src/pi.js", "gitProbe.status !== 128 ||", "false &&"],
  ["provider-restriction", "src/pi.js", 'if (!context.opencodeModel.startsWith("deepseek/")) throw', "if (false) throw"],
  ["glob-inventory", "src/pi-guard.js", "allowed.filter(file =>", "[...allowed, '/etc/hostname'].filter(file =>"],
  // finding 1: Pi opens another file than the one the guard approved
  ["spelling-refused", "src/pi-guard.js", "|| piRewrites(raw)) return null", ") return null"],
  ["spelling-unicode-space", "src/pi-guard.js", 'String(input).replace(UNICODE_SPACES, " ")', "String(input)"],
  ["spelling-at-strip", "src/pi-guard.js", 'if (strip && n.startsWith("@"))', "if (false)"],
  ["spelling-base-rule", "src/pi-guard.js", "piNormalize(cwd, { spaces: false, strip: false })", "piNormalize(cwd)"],
  ["spelling-home", "src/pi-guard.js", 'if (n.startsWith("~/")) return join(homedir(), n.slice(2));', ""],
  ["spelling-file-url", "src/pi-guard.js", "if (/^file:\\/\\//.test(n)) return fileURLToPath(n);", ""],
  ["read-candidates", "src/pi-guard.js", "const candidates = piReadCandidates(path).filter(", "const candidates = [path].filter("],
  ["read-all-candidates", "src/pi-guard.js", "targets.some(target => !target || !permitted.has(target))", "[targets[0]].some(target => !target || !permitted.has(target))"],
  ["read-reopen-rewrite", "src/pi-guard.js", "if (piRewrites(target) || piResolve(target, policy.workdir) !== target)", "if (false)"],
  // finding 2: a successful read that delivered no source
  ["range-validation", "src/pi-guard.js", "ok(input.offset) && ok(input.limit) ?", "true ?"],
  ["delivery-truncation-count", "src/pi-events.js", "if (truncation) count = truncation.firstLineExceedsLimit ? 0 : truncation.outputLines;\n  else count =", "if (false) count = 0;\n  else count ="],
  ["delivery-count-zero", "src/pi-events.js", "if (count === 0) return null;", ""],
  ["delivery-content-match", "src/pi-events.js", "if (!text.startsWith(expected) || (tail !== \"\" && !/^\\n\\n\\[[^\\n\\]]*\\]$/.test(tail))) return null;", ""],
  ["delivery-error-result", "src/pi-events.js", "end.isError !== false ||", "false ||"],
  ["delivery-partial", "src/pi-events.js", "merged[0][0] === 1 && merged[0][1] >= entry.total", "true"],
  ["delivery-merge", "src/pi-events.js", "if (last && from <= last[1] + 1)", "if (last)"],
  // finding 3: exhaustion is not completion
  ["stop-reason-length", "src/pi-events.js", 'last.stopReason !== "stop"', '!["stop", "length"].includes(last.stopReason)'],
  ["stop-reason-unknown", "src/pi-events.js", 'last.stopReason !== "stop"', '["error", "aborted"].includes(last.stopReason) === false ? false : true'],
  // process environment as observed in the Pi process itself
  ["env-observed", "src/pi-events.js", "if (allowedEnv) {", "if (false) {"],
  ["env-reported", "src/pi-extension.js", ", envKeys: Object.keys(process.env).sort()", ""],
  // resources the repository or the user could otherwise supply
  ["flag-no-skills", "src/pi.js", '"--no-skills", ', ""],
  ["flag-no-prompt-templates", "src/pi.js", '"--no-prompt-templates", ', ""],
  ["flag-no-themes", "src/pi.js", '"--no-themes", ', ""],
  ["flag-no-context-files", "src/pi.js", '"--no-context-files", ', ""],
  ["flag-no-mcp", "src/pi.js", '"--no-context-files", "--no-mcp", "--no-approve",', '"--no-context-files", "--no-approve",'],
  ["flag-no-mcp-generic", "src/pi.js", '"--no-extensions", "--no-mcp", "--no-approve", "--model"', '"--no-extensions", "--no-approve", "--model"'],
  // selection and default
  ["harness-default", "src/context.js", '|| "opencode";', '|| "pi";'],
  ["harness-typo-validate", "src/config.js", "if (![\"opencode\", \"pi\"].includes(context.harness)) throw", "if (false) throw"],
  ["harness-typo-dispatch", "src/harness.js", "context.harness === \"opencode\" || context.harness === undefined", "true"],
  ["model-known", "src/pi.js", "if (!listed.includes(model)) throw", "if (false) throw"],
];

// Control: the unmutated copy must pass, or "killed" would only mean "the copy is broken".
{
  const copy = makeCopy();
  const baseline = spawnSync(process.execPath, ["--test", "test/pi-runner.test.js", "test/pi-path-rules.test.js"], { cwd: work(copy), encoding: "utf8" });
  rmSync(copy, { recursive: true, force: true });
  if (baseline.status !== 0) { console.log("baseline copy fails its own tests; mutation results would mean nothing"); process.exit(2); }
  console.log("baseline  unmutated copy passes");
}
let survivors = 0;
for (const [name, file, find, replace] of mutations) {
  const copy = makeCopy();
  try {
    const path = join(work(copy), file), text = readFileSync(path, "utf8");
    if (!text.includes(find)) { console.log(`STALE    ${name}: pattern not found in ${file}`); survivors++; continue; }
    writeFileSync(path, text.replace(find, replace));
    const result = spawnSync(process.execPath, ["--test", "test/pi-runner.test.js", "test/pi-path-rules.test.js"], { cwd: work(copy), encoding: "utf8" });
    const killed = result.status !== 0;
    if (!killed) survivors++;
    console.log(`${killed ? "killed  " : "SURVIVED"} ${name}`);
  } finally { rmSync(copy, { recursive: true, force: true }); }
}
console.log(survivors ? `${survivors} mutation(s) not caught` : `all ${mutations.length} mutations caught`);
process.exit(survivors ? 1 : 0);
