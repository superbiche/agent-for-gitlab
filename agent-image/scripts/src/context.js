import { DEFAULT_MAX_DIFF_TOKENS } from "./diff-compression.js";

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
  const reviewProfile = normalizeChoice(process.env.REVIEW_PROFILE, ["quick", "standard", "thorough", "risk"], "standard");
  const reviewScoringDefault = reviewMode === "excessive" || reviewProfile === "risk" ? "agents" : "global";
  const resourceType = process.env.AI_RESOURCE_TYPE;
  const resourceId = process.env.AI_RESOURCE_ID;
  const platform = normalizeChoice(process.env.AI_PLATFORM, ["gitlab", "github"], "gitlab");
  const isGitHub = platform === "github";

  return {
    platform,
    projectPath: process.env.AI_PROJECT_PATH,
    author: process.env.AI_AUTHOR,
    resourceType,
    resourceId,
    discussionId: process.env.AI_DISCUSSION_ID,
    triggerNoteId: process.env.AI_TRIGGER_NOTE_ID,
    pipelineUrl: process.env.CI_PIPELINE_URL,
    pipelineSha: process.env.CI_COMMIT_SHA,
    prompt: process.env.DIRECT_PROMPT,
    branch: process.env.AI_BRANCH,
    email: process.env.AI_GITLAB_EMAIL,
    username: process.env.AI_GITLAB_USERNAME || process.env.AI_GITHUB_USERNAME,
    opencodeModel: process.env.OPENCODE_MODEL,
    // Shared by reference with routed model contexts; one entry per opencode call.
    usage: [],
    agentPrompt: combinedPrompt,
    gitlabToken: process.env.GITLAB_TOKEN,
    githubToken: process.env.GITHUB_TOKEN,
    host: process.env.CI_SERVER_HOST || (isGitHub ? "github.com" : "gitlab.com"),
    projectId: isGitHub ? undefined : process.env.CI_PROJECT_ID,
    serverUrl: process.env.CI_SERVER_URL || (isGitHub ? "https://github.com" : "https://gitlab.com"),
    apiUrl: process.env.CI_API_V4_URL || process.env.GITHUB_API_URL,
    checkoutDir: "./repo",
    mrIid: ["mr", "merge_request", "pr", "pull_request"].includes((resourceType || "").toLowerCase()) ? resourceId : undefined,
    reviewMode,
    reviewProfile,
    reviewScoring: normalizeChoice(process.env.REVIEW_SCORING, ["global", "agents"], reviewScoringDefault),
    reviewLang: normalizeChoice(process.env.REVIEW_LANG, ["en", "fr"], "en"),
    reviewAudience: normalizeChoice(process.env.REVIEW_AUDIENCE, ["team", "oss", "self"], "team"),
    reviewMaxDiffTokens: positiveInt(process.env.REVIEW_MAX_DIFF_TOKENS, DEFAULT_MAX_DIFF_TOKENS),
    reviewSmallModel: process.env.REVIEW_SMALL_MODEL || "",
    reviewSmallMaxLines: positiveInt(process.env.REVIEW_SMALL_MAX_LINES, 100),
    reviewSmallMaxFiles: positiveInt(process.env.REVIEW_SMALL_MAX_FILES, 5),
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

function positiveInt(value, fallback) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
