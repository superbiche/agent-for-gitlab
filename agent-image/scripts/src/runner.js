import logger from "./logger.js";
import { buildContext } from "./context.js";
import { postComment } from "./gitlab.js";
import { isInsideGitRepo, setupLocalRepository, ensureBranch } from "./git.js";
import { validateProviderKeys, validateConfig } from "./config.js";
import { runOpencode } from "./opencode.js";
import { writeOutput } from "./output.js";
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
      const output = await runOpencode(context, context.prompt, { captureOutput: true });
      const message = output.trim() || "opencode completed without a textual response.";
      await postComment(context, message);
      writeOutput(true, {
        prompt: context.prompt,
        branch: context.branch,
        posted: true,
      });
    }

    logger.info(`Working directory after opencode: ${process.cwd()}`);
    
    process.exit(0);
  } catch (error) {
    await handleError(context, error);
  }
}

async function handleError(context, error) {
  logger.error(error.message);
  if (!context.dryRun) {
    await postComment(
      context,
      `❌ AI encountered an error:\n\n` +
      `\`\`\`\n${error.message}\n\`\`\`\n\n` +
      `Please check the pipeline logs for details.`,
    );
  }
  writeOutput(false, { error: error.message });
  process.exit(1);
}
