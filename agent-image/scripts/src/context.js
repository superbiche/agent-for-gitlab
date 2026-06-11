export function buildContext() {
  // Combine prompts: webhook (OPENCODE_AGENT_PROMPT) + pipeline (CUSTOM_AGENT_PROMPT)
  const webhookAppPrompt = process.env.OPENCODE_AGENT_PROMPT || "";
  const pipelinePrompt = process.env.CUSTOM_AGENT_PROMPT || "";
  let combinedPrompt = "";
  if (webhookAppPrompt && pipelinePrompt) {
    combinedPrompt = `${webhookAppPrompt.trim()}\n\n---\n# Pipeline Additions\n${pipelinePrompt.trim()}`;
  } else {
    combinedPrompt = webhookAppPrompt || pipelinePrompt || "";
  }

  const reviewMode = normalizeChoice(process.env.REVIEW_MODE, ["loose", "strict", "excessive"], "strict");
  const reviewScoringDefault = reviewMode === "excessive" ? "agents" : "global";
  const resourceType = process.env.AI_RESOURCE_TYPE;
  const resourceId = process.env.AI_RESOURCE_ID;

  return {
    projectPath: process.env.AI_PROJECT_PATH,
    author: process.env.AI_AUTHOR,
    resourceType,
    resourceId,
    discussionId: process.env.AI_DISCUSSION_ID,
    prompt: process.env.DIRECT_PROMPT,
    branch: process.env.AI_BRANCH,
    email: process.env.AI_GITLAB_EMAIL,
    username: process.env.AI_GITLAB_USERNAME,
    opencodeModel: process.env.OPENCODE_MODEL,
    agentPrompt: combinedPrompt,
    gitlabToken: process.env.GITLAB_TOKEN,
    host: process.env.CI_SERVER_HOST || "gitlab.com",
    projectId: process.env.CI_PROJECT_ID,
    serverUrl: process.env.CI_SERVER_URL || "https://gitlab.com",
    apiUrl: process.env.CI_API_V4_URL,
    checkoutDir: "./repo",
    mrIid: (resourceType || "").toLowerCase() === "mr" ? resourceId : undefined,
    reviewMode,
    reviewProfile: normalizeChoice(process.env.REVIEW_PROFILE, ["quick", "standard", "thorough"], "standard"),
    reviewScoring: normalizeChoice(process.env.REVIEW_SCORING, ["global", "agents"], reviewScoringDefault),
    reviewLang: normalizeChoice(process.env.REVIEW_LANG, ["en", "fr"], "en"),
    reviewAudience: normalizeChoice(process.env.REVIEW_AUDIENCE, ["team", "oss", "self"], "team"),
    dryRun: isTruthy(process.env.AI_DRY_RUN),
    dryRunFixtures: {
      mr: process.env.REVIEW_FIXTURE_MR,
      diffs: process.env.REVIEW_FIXTURE_DIFFS,
      findings: process.env.REVIEW_FIXTURE_FINDINGS,
      scores: process.env.REVIEW_FIXTURE_SCORES,
    },
  };
}

function normalizeChoice(value, allowed, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}
