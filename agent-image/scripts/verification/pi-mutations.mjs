// Mutation check for the Pi runner: each entry removes ONE named mechanism from a copy of
// the sources and the Pi tests must then fail. A mechanism whose removal leaves the tests
// green is not tested. Usage: node verification/pi-mutations.mjs   (exit 1 on a survivor)
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("..", import.meta.url));
// The tests call `git log` in the working directory, so each copy is a throwaway repository.
function makeCopy() {
  const copy = mkdtempSync(join(tmpdir(), "pi-mutation-"));
  cpSync(scripts, copy, { recursive: true, filter: source => !source.includes("node_modules") });
  const git = (...args) => spawnSync("git", ["-c", "user.name=m", "-c", "user.email=m@example.invalid", ...args], { cwd: copy, stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "copy");
  return copy;
}
const mutations = [
  // guarantee: no shell, no other tools (tool allowlist, deny by default)
  ["tool-allowlist", "src/pi-guard.js", 'if (!tools.includes(toolName)) return { allow: false', 'if (false) return { allow: false'],
  ["tool-selection-flag", "src/pi.js", '"--tools", RISK_TOOLS.join(","),', ""],
  ["tool-declaration-narrowing", "src/pi-extension.js", "pi.setActiveTools([...RISK_TOOLS]);", ""],
  // guarantee: reads only inside the approved inventory (also keeps credentials and /proc out)
  ["read-inventory", "src/pi-guard.js", "if (!target || !permitted.has(target))", "if (!target)"],
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
  ["evidence-effective-path", "src/pi-events.js", "allowed.has(file)", "true"],
  ["failure-from-stream", "src/pi-events.js", 'if (["error", "aborted"].includes(last.stopReason))', "if (false)"],
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
  // selection and default
  ["harness-default", "src/context.js", 'if (!normalized) return "opencode";', 'if (!normalized) return "pi";'],
  ["harness-typo", "src/context.js", "if (![\"opencode\", \"pi\"].includes(normalized)) throw", "if (false) throw"],
  ["model-known", "src/pi.js", "if (!listed.includes(model)) throw", "if (false) throw"],
];

// Control: the unmutated copy must pass, or "killed" would only mean "the copy is broken".
{
  const copy = makeCopy();
  const baseline = spawnSync(process.execPath, ["--test", "test/pi-runner.test.js"], { cwd: copy, encoding: "utf8" });
  rmSync(copy, { recursive: true, force: true });
  if (baseline.status !== 0) { console.log("baseline copy fails its own tests; mutation results would mean nothing"); process.exit(2); }
  console.log("baseline  unmutated copy passes");
}
let survivors = 0;
for (const [name, file, find, replace] of mutations) {
  const copy = makeCopy();
  try {
    const path = join(copy, file), text = readFileSync(path, "utf8");
    if (!text.includes(find)) { console.log(`STALE    ${name}: pattern not found in ${file}`); survivors++; continue; }
    writeFileSync(path, text.replace(find, replace));
    const result = spawnSync(process.execPath, ["--test", "test/pi-runner.test.js"], { cwd: copy, encoding: "utf8" });
    const killed = result.status !== 0;
    if (!killed) survivors++;
    console.log(`${killed ? "killed  " : "SURVIVED"} ${name}`);
  } finally { rmSync(copy, { recursive: true, force: true }); }
}
console.log(survivors ? `${survivors} mutation(s) not caught` : `all ${mutations.length} mutations caught`);
process.exit(survivors ? 1 : 0);
