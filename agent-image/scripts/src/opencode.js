import logger from "./logger.js";
import { riskSourcePolicy } from "./risk-context.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

export async function runOpencode(context, prompt, options = {}) {
  logger.start("Running opencode via cli...");

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

  if (options.format) {
    cliArgs.push("--format", options.format);
  }

  if (options.skipPermissions !== false) {
    cliArgs.push("--auto");
  }

  logger.info(`Running: opencode ${cliArgs.join(" ")}`);

  const risk = context.reviewProfile === "risk";
  const isolation = risk ? riskInvocation(context) : {};
  const result = spawnSync("opencode", cliArgs, {
    encoding: "utf-8",
    ...isolation.options,
    input: `${risk ? isolation.context : context.agentPrompt}\n${prompt}`,
    timeout: 20 * 60 * 1000,
    stdio: options.captureOutput ? ["pipe", "pipe", "pipe"] : ["pipe", process.stdout, process.stderr],
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const stderr = result.stderr || `exit status ${result.status}`;
    logger.error("opencode CLI exited with error: ", stderr);
    throw new Error(`opencode CLI failed: ${stderr}`);
  }

  logger.success("opencode CLI completed");
  return result.stdout || "";
}

// Run outside the reviewed tree: its OpenCode configuration/plugins are not loaded.
// The model can inspect source but cannot execute commands or access CI credentials.
export function riskInvocation(context) {
  if (!context.opencodeModel.startsWith("deepseek/")) throw new Error("Risk deployment currently supports the DeepSeek provider only");
  const repo = process.cwd();
  const policy = context.sourcePolicy || riskSourcePolicy(repo);
  const files = policy.allowed;
  const runDir = mkdtempSync(join(tmpdir(), "risk-review-"));
  // Pin OpenCode instance.worktree so permission patterns have a known relative base.
  execFileSync("git", ["init", "--quiet", runDir]);
  const read = { "*": "deny" };
  for (const file of files) read[relative(runDir, `${repo}/${file}`)] = "allow";
  const permission = { "*": "deny", read, edit: { "*": "deny", [relative(runDir, "/tmp/review-findings.json")]: "allow", [relative(runDir, "/tmp/review-scores.json")]: "allow" }, external_directory: { "*": "deny", [`${repo}/**`]: "allow", "/tmp/*": "allow" } };
  const history = execFileSync("git", ["log", "-10", "--oneline", "--name-only"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const configPath = join(runDir, "opencode.json");
  writeFileSync(configPath, JSON.stringify({ permission, share: "disabled", lsp: false }));
  return {
    context: `Repository for read-only inspection: ${repo}\nOnly read and the two JSON output writes are permitted. No shell/search tools; use this tracked file inventory to locate callers, then read their absolute paths.\n${files.join("\n")}\nRecent history:\n${history}`,
    options: {
      cwd: runDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true" },
    },
  };
}
