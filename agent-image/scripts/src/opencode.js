import logger from "./logger.js";
import { riskSourcePolicy } from "./risk-context.js";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

export async function runOpencode(context, prompt, options = {}) {
  logger.start("Running opencode via cli...");
  const risk = context.reviewProfile === "risk";

  const [providerID, modelID] = context.opencodeModel.split('/');
  if (!providerID || !modelID) {
    throw new Error(`Invalid OPENCODE_MODEL format: ${context.opencodeModel}. Expected format: provider/model`);
  }

  logger.info(`Using model: ${modelID} from provider: ${providerID}`);

  logger.info("Sending prompt to model ... this may take a while");

  const cliArgs = [
    "run",
    "--print-logs",
    "--pure",
    "--model", 
    context.opencodeModel,
    "--log-level",
    "ERROR"
  ];

  if (risk || options.format) {
    cliArgs.push("--format", risk ? "json" : options.format);
  }

  if (options.skipPermissions !== false) {
    cliArgs.push("--auto");
  }

  logger.info(`Running: opencode ${cliArgs.join(" ")}`);

  const isolation = risk ? riskInvocation(context) : {};
  const input = `${risk ? isolation.context : context.agentPrompt}\n${prompt}`;
  if (risk && Buffer.byteLength(input, "utf8") > 512 * 1024) throw new Error("Review context exceeds 512 KiB; split the MR or use local review. No partial review was submitted.");
  const result = spawnSync("opencode", cliArgs, {
    encoding: "utf-8",
    ...isolation.options,
    input,
    ...(risk ? { timeout: 20 * 60 * 1000 } : {}),
    stdio: options.captureOutput ? ["pipe", "pipe", "pipe"] : ["pipe", process.stdout, process.stderr],
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });

  if (result.error?.code === "ETIMEDOUT") throw new Error("Risk review model call timed out after 20 minutes; review incomplete.");
  if (result.error) throw new Error(`Could not run opencode: ${result.error.code || result.error.message}`);
  if (result.status !== 0) {
    const stderr = result.stderr || `exit status ${result.status}`;
    logger.error("opencode CLI exited with error: ", stderr);
    throw new Error(`opencode CLI failed: ${stderr}`);
  }

  logger.success("opencode CLI completed");
  if (risk) {
    const evidence = parseRiskEvents(result.stdout || "", isolation.sourcePolicy, isolation.options.cwd);
    context.verifiedSourceReads = [...new Set([...(context.verifiedSourceReads || []), ...evidence.reads])];
    context.sourceReadFailures = [...new Set([...(context.sourceReadFailures || []), ...evidence.failedReads])];
    return evidence.text;
  }
  return result.stdout || "";
}

// Consume the pinned CLI's JSON events, never model-authored claims of tool use.
export function parseRiskEvents(output, policy, worktree) {
  const allowed = new Set(policy.allowed.map(file => resolve(policy.repo, file)));
  const reads = new Set();
  const failedReads = new Set();
  const text = [];
  for (const line of output.split("\n").filter(line => line.trim())) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error("Risk review tool evidence was not valid CLI JSON; review incomplete."); }
    if (event.type === "error") throw new Error("Risk review CLI reported an error; review incomplete.");
    if (event.type === "text" && typeof event.part?.text === "string") text.push(event.part.text);
    if (event.type !== "tool_use" || event.part?.tool !== "read") continue;
    const state = event.part.state;
    if (typeof state?.input?.filePath !== "string") continue;
    const file = resolve(worktree, state.input.filePath);
    if (state.status === "completed" && allowed.has(file)) reads.add(relative(policy.repo, file));
    if (state.status === "error") failedReads.add(relative(policy.repo, file));
  }
  if (!reads.size) throw new Error("Risk review completed no successful allowlisted source reads; review incomplete.");
  return { text: text.join("\n"), reads: [...reads], failedReads: [...failedReads] };
}

// Run outside the reviewed tree: its OpenCode configuration/plugins are not loaded.
// The model can inspect source but cannot execute commands or access CI credentials.
export function riskInvocation(context) {
  if (!context.opencodeModel.startsWith("deepseek/")) throw new Error("Risk deployment currently supports the DeepSeek provider only");
  const repo = process.cwd();
  const policy = context.sourcePolicy || riskSourcePolicy(repo);
  const files = policy.allowed;
  const isolationRoot = mkdtempSync(join(tmpdir(), "risk-review-"));
  const runDir = join(isolationRoot, "work");
  mkdirSync(runDir);
  // The pinned CLI can deadlock while booting Git-backed location services.
  // Its non-Git worktree is "/"; verify that invariant before rebasing permissions.
  const gitProbe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: runDir, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: join(isolationRoot, "home"), LC_ALL: "C" },
  });
  if (gitProbe.error || gitProbe.status !== 128 || !gitProbe.stderr.includes("not a git repository")) {
    rmSync(isolationRoot, { recursive: true, force: true });
    throw new Error("Risk review requires a temporary directory outside any Git worktree.");
  }
  const permissionRoot = "/";
  const configDir = join(isolationRoot, "config", "opencode");
  mkdirSync(configDir, { recursive: true });
  // OpenCode initializes this dependency even with --pure. Supply audited build-time
  // dependencies so a fresh HOME never needs a runtime package fetch.
  const bootstrap = fileURLToPath(new URL("../../opencode-bootstrap/", import.meta.url));
  for (const file of ["package.json", "package-lock.json"]) copyFileSync(join(bootstrap, file), join(configDir, file));
  symlinkSync(join(bootstrap, "node_modules"), join(configDir, "node_modules"), "dir");
  const read = { "*": "deny" };
  for (const file of files) read[relative(permissionRoot, `${repo}/${file}`)] = "allow";
  read[relative(permissionRoot, "/tmp/review-findings.json")] = "allow";
  read[relative(permissionRoot, "/tmp/review-scores.json")] = "allow";
  const permission = { "*": "deny", read, glob: "allow", edit: { "*": "deny", [relative(permissionRoot, "/tmp/review-findings.json")]: "allow", [relative(permissionRoot, "/tmp/review-scores.json")]: "allow" }, external_directory: { "*": "deny", [`${repo}/**`]: "allow", "/tmp/*": "allow" } };
  const history = execFileSync("git", ["log", "-10", "--oneline", "--name-only"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const configPath = join(isolationRoot, "opencode.json");
  writeFileSync(configPath, JSON.stringify({ permission, share: "disabled", lsp: false }));
  return {
    isolationRoot,
    sourcePolicy: { ...policy, repo },
    context: `Repository for read-only inspection: ${repo}\nOnly source reads, glob filename discovery and the two JSON output writes are permitted. No shell or content-search tools. Use this partial tracked inventory, or glob within the repository to locate other callers, then read their absolute paths.\n${files.slice(0, 2000).join("\n")}\n${Math.max(0, files.length - 2000)} more readable tracked files can be located with glob.\nRecent history:\n${history}`,
    options: {
      cwd: runDir,
      env: { PATH: process.env.PATH, HOME: join(isolationRoot, "home"), XDG_CONFIG_HOME: join(isolationRoot, "config"), XDG_DATA_HOME: join(isolationRoot, "data"), XDG_STATE_HOME: join(isolationRoot, "state"), DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true" },
    },
  };
}
