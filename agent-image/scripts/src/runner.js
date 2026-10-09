import logger from "./logger.js";
import { buildContext } from "./context.js";
import { loadAdapter, selectPlatform } from "./platforms/interface.js";
import { causeSummary } from "./platforms/http.js";
import { isInsideGitRepo, setupLocalRepository, ensureBranch } from "./git.js";
import { validateProviderKeys, validateConfig } from "./config.js";
import { runOpencode } from "./opencode.js";
import { writeOutput } from "./output.js";
import { summarizeUsage } from "./usage.js";
import { gitSetup } from "./git.js";
import { isReviewRequest, runReview } from "./review.js";

export async function run() {
  logger.info("AI GitLab Runner Started");

  const context = buildContext();

  logger.info(`Project: ${context.projectPath || "(unknown)"}`);
  logger.info(`Triggered by: @${context.author || "unknown"}`);
  logger.info(`Branch: ${context.branch}`);

  try {
    validateConfig(context);
    const platform = await loadAdapter(context);
    logger.info(`Platform: ${selectPlatform(context)}`);

    if (context.dryRun && isReviewRequest(context.prompt)) {
      const reviewResult = await runReview(context);
      writeOutput(true, reviewResult);
      process.exit(0);
    }

    gitSetup(context);

    if (!isInsideGitRepo()) {
      setupLocalRepository(context);
    } else {
      // Ensure we're on the correct branch even if we're already in a git repo
      ensureBranch(context);
    }

    logger.info(`Prompt: ${context.prompt}`);

    // await postComment(context, "🤖 Getting the vibes started...");

    const hasAnyProviderKey = validateProviderKeys();
    if (!hasAnyProviderKey) {
      logger.warn(
        "No provider API key detected in env. opencode may fail to start unless credentials are pre-configured via 'opencode auth login'.",
      );
    }

    logger.info(`Working directory: ${process.cwd()}`); // Should be /opt/agent/repo

    if (isReviewRequest(context.prompt)) {
      const reviewResult = await runReview(context);
      writeOutput(true, reviewResult);
    } else {
      const output = await runOpencode(context, context.prompt, { captureOutput: true, label: "prompt" });
      const message = output.trim() || "opencode completed without a textual response.";
      await platform.postComment(context, message);
      writeOutput(true, {
        prompt: context.prompt,
        branch: context.branch,
        posted: true,
        usage: summarizeUsage(context.usage),
      });
    }

    logger.info(`Working directory after opencode: ${process.cwd()}`);
    
    process.exit(0);
  } catch (error) {
    await handleError(context, error);
  }
}

async function handleError(context, error) {
  logger.error(causeSummary(error));
  if (!context.dryRun) {
    // Best effort: error replies must never mask the original failure.
    try {
      const platform = await loadAdapter(context);
      await platform.postComment(
        context,
        `❌ AI encountered an error:\n\n` +
        `\`\`\`\n${causeSummary(error)}\n\`\`\`\n\n` +
        `Please check the pipeline logs for details.`,
      );
    } catch (postError) {
      logger.error(`Failed to post error comment: ${causeSummary(postError)}`);
    }
  }
  writeOutput(false, { error: causeSummary(error), usage: summarizeUsage(context.usage) });
  process.exit(1);
}
