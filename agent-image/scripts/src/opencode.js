import logger from "./logger.js";
import { spawnSync } from "node:child_process";

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
    cliArgs.push("--dangerously-skip-permissions");
  }

  logger.info(`Running: opencode ${cliArgs.join(" ")}`);

  const result = spawnSync("opencode", cliArgs, {
    encoding: "utf-8",
    input: `${context.agentPrompt}\n${prompt}`,
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
