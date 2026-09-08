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
  read[relative(runDir, "/tmp/review-findings.json")] = "allow";
  read[relative(runDir, "/tmp/review-scores.json")] = "allow";
  const permission = { "*": "deny", read, glob: "allow", edit: { "*": "deny", [relative(runDir, "/tmp/review-findings.json")]: "allow", [relative(runDir, "/tmp/review-scores.json")]: "allow" }, external_directory: { "*": "deny", [`${repo}/**`]: "allow", "/tmp/*": "allow" } };
  const history = execFileSync("git", ["log", "-10", "--oneline", "--name-only"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const configPath = join(runDir, "opencode.json");
  writeFileSync(configPath, JSON.stringify({ permission, share: "disabled", lsp: false }));
  return {
    context: `Repository for read-only inspection: ${repo}\nOnly source reads, glob filename discovery and the two JSON output writes are permitted. No shell or content-search tools. Use this partial tracked inventory, or glob within the repository to locate other callers, then read their absolute paths.\n${files.slice(0, 2000).join("\n")}\n${Math.max(0, files.length - 2000)} more readable tracked files can be located with glob.\nRecent history:\n${history}`,
    options: {
      cwd: runDir,
      env: { PATH: process.env.PATH, HOME: runDir, XDG_CONFIG_HOME: join(runDir, "config"), XDG_DATA_HOME: join(runDir, "data"), XDG_STATE_HOME: join(runDir, "state"), DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true" },
    },
  };
}
