import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import {
  triggerPipeline,
  cancelOldPipelines,
  getProject,
  createBranch,
  sanitizeBranchName,
  addReactionToNote,
  getDiscussionThread,
} from "./gitlab";
import { dispatchAgentRun, addReaction as addGitHubReaction } from "./github";
import { limitByUser } from "./limiter";
import { logger } from "./logger";
import type { WebhookPayload } from "./types";
import { isReviewEnrolled, postEnrollmentRefusal } from "./review-enrollment";

const app = new Hono();

// Log all requests
app.use("*", async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  logger.info(`${method} ${path}`, {
    method,
    path,
    headers: logger.maskSensitive(Object.fromEntries(c.req.raw.headers)),
  });

  await next();

  const duration = Date.now() - start;

  const status = c.res.status;

  logger.info(`${method} ${path} ${status} ${duration}ms`, {
    method,
    path,
    status,
    duration,
  });
});
app.get("/health", (c) => c.text("ok"));

// Optional admin endpoints exist only when explicitly configured.
if (process.env.ADMIN_TOKEN) {
app.get(
  "/admin/disable",
  bearerAuth({ token: process.env.ADMIN_TOKEN! }),
  (c) => {
    process.env.AI_DISABLED = "true";
    logger.warn("Bot disabled via admin endpoint");
    return c.text("disabled");
  }
);

app.get(
  "/admin/enable",
  bearerAuth({ token: process.env.ADMIN_TOKEN! }),
  (c) => {
    process.env.AI_DISABLED = "false";
    logger.info("Bot enabled via admin endpoint");
    return c.text("enabled");
  }
);

}

// Single webhook endpoint for all projects
app.post("/webhook", async (c) => {
  const gitlabEvent = c.req.header("x-gitlab-event");
  const gitlabToken = c.req.header("x-gitlab-token");

  logger.debug("Webhook received", {
    event: gitlabEvent,
    hasToken: !!gitlabToken,
  });

  // Verify webhook secret
  if (!process.env.WEBHOOK_SECRET || gitlabToken !== process.env.WEBHOOK_SECRET) {
    logger.warn("Webhook unauthorized - invalid token");
    return c.text("unauthorized", 401);
  }

  // Only handle Note Hook events
  if (gitlabEvent !== "Note Hook") {
    logger.debug("Ignoring non-Note Hook event", { event: gitlabEvent });
    return c.text("ignored");
  }

  const body = await c.req.json<WebhookPayload>();

  // Log webhook payload (with sensitive data masked)
  logger.debug("Webhook payload received", {
    payload: logger.maskSensitive(body),
  });

  const note = body.object_attributes?.note || "";
  const projectId = body.project?.id;
  const projectPath = body.project?.path_with_namespace;
  const mrIid = body.merge_request?.iid;
  const issueIid = body.issue?.iid;
  const issueTitle = body.issue?.title;
  const authorUsername = body.user?.username;

  const discussionId = body.object_attributes?.discussion_id || "";
  // Get trigger phrase from environment or use default
  const triggerPhrase = process.env.TRIGGER_PHRASE || "@ai";
  const triggerRegex = new RegExp(
    `${triggerPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i"
  );

  // Check for trigger phrase mention
  if (!triggerRegex.test(note)) {
    logger.debug(`No ${triggerPhrase} mention found in note`);
    return c.text("skipped");
  }

  if (process.env.AI_DISABLED === "true") {
    logger.warn("Bot is disabled, skipping trigger");
    return c.text("disabled");
  }

  // Enable when we have a dedicated bot user
  if (process.env.AI_GITLAB_USERNAME === authorUsername) {
    logger.warn("Ignoring self-triggered note");
    return c.text("self-trigger");
  }

  // Review deployments never enter generic execution or create issue branches.
  const directMatch = note.match(new RegExp(`${triggerPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(.*)`, "is"));
  const command = directMatch ? directMatch[1].trim() : "";
  if (process.env.REVIEW_ONLY === "true" && (!mrIid || !/^review\b/i.test(command))) {
    return c.text("review-only: use @ai review on a merge request");
  }

  const resourceId = mrIid || issueIid || "general";
  const key = `${authorUsername}:${projectId}:${resourceId}`;

  if (!(await limitByUser(key))) {
    logger.warn("Rate limit exceeded", { key, author: authorUsername });

    return c.text("rate-limited");
  }

  logger.info(`${triggerPhrase} triggered`, {
    project: projectPath,
    author: authorUsername,
    resourceType: mrIid ? "merge_request" : issueIid ? "issue" : "unknown",
    resourceId: mrIid || issueIid,
  });

  // Determine branch ref
  let ref = body.merge_request?.source_branch;

  // For issues, create a branch
  if (issueIid && !mrIid) {
    try {
      // Get project details for default branch
      const project = await getProject(projectId);
      const defaultBranch = project.default_branch || "main";

      // Generate branch name with timestamp to ensure uniqueness
      const timestamp = Date.now();
      const branchName = `${
        process.env.BRANCH_PREFIX ?? "ai"
      }/issue-${issueIid}-${sanitizeBranchName(issueTitle || "")}-${timestamp}`;

      logger.info("Creating branch for issue", {
        issueIid,
        branchName,
        fromBranch: defaultBranch,
      });

      // Try to create the branch
      await createBranch(projectId, branchName, defaultBranch);
      ref = branchName;
    } catch (error) {
      logger.error("Failed to create branch for issue", {
        issueIid,
        error: error instanceof Error ? error.message : error,
      });

      // Don't fall back to main - fail the request
      return c.text("branch-creation-failed", 500);
    }
  } else if (!ref) {
    // For merge requests without a source branch, fail
    logger.error("No branch ref determined for merge request");
    return c.text("no-branch-ref", 400);
  }

  // Extract the prompt after the trigger phrase
  const promptMatch = note.match(
    new RegExp(
      `${triggerPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(.*)`,
      "is"
    )
  );

  const directPrompt = promptMatch ? promptMatch[1].trim() : "";
  let aggregatedPrompt = directPrompt;

  // If we have a discussion id, attempt to fetch the whole thread and prepend it
  if (discussionId) {
    try {
      // Lazy import to avoid circular deps if any
      const threadNotes = await getDiscussionThread({
        projectId: projectId!,
        mrIid: mrIid ?? undefined,
        issueIid: issueIid ?? undefined,
        discussionId,
        includeSystem: true,
      });

      logger.info(`Using ${threadNotes.length} discussion thread notes`);

      if (threadNotes.length > 0) {
        const formatted = threadNotes
          .map((n) => {
            const author = n.author?.username || n.author?.name || "user";
            const created = n.created_at ? ` (${n.created_at})` : "";
            return `@${author}${created}:\n${n.body.trim()}`;
          })
          .join("\n\n---\n\n");

        aggregatedPrompt =
          `Conversation Thread (most recent first below separator):\n\n${formatted}\n\n=== User Prompt ===\n${directPrompt}`.trim();
      }
    } catch (err) {
      logger.warn("Failed to aggregate discussion thread", {
        error: err instanceof Error ? err.message : err,
        discussionId,
      });
    }
  }

  // Enforce size limit for CI variable safety
  const MAX_PROMPT_CHARS = 8000;
  if (aggregatedPrompt.length > MAX_PROMPT_CHARS) {
    logger.warn("Aggregated prompt truncated", {
      original: aggregatedPrompt.length,
      max: MAX_PROMPT_CHARS,
    });
    aggregatedPrompt =
      aggregatedPrompt.slice(0, MAX_PROMPT_CHARS) + "\n...[truncated]";
  }

  // Create minimal webhook payload for CI/CD variable (10KB limit)
  const minimalPayload = {
    object_kind: body.object_kind,
    project: body.project,
    user: body.user,
    object_attributes: body.object_attributes
      ? {
          note: body.object_attributes.note,
          noteable_type: body.object_attributes.noteable_type,
        }
      : undefined,
    merge_request: body.merge_request
      ? {
          iid: body.merge_request.iid,
          title: body.merge_request.title,
          state: body.merge_request.state,
        }
      : undefined,
    issue: body.issue
      ? {
          iid: body.issue.iid,
          title: body.issue.title,
          state: body.issue.state,
        }
      : undefined,
  };

  // Trigger pipeline with variables
  const variables = {
    AI_TRIGGER: "true",
    AI_AUTHOR: authorUsername,
    AI_GITLAB_EMAIL: process.env.AI_GITLAB_EMAIL || "",
    AI_GITLAB_USERNAME: process.env.AI_GITLAB_USERNAME || "",
    AI_RESOURCE_TYPE: mrIid ? "merge_request" : "issue",
    AI_RESOURCE_ID: String(mrIid || issueIid || ""),
    AI_PROJECT_PATH: projectPath,
    AI_BRANCH: ref,
    AI_DISCUSSION_ID: discussionId,
    OPENCODE_MODEL: process.env.OPENCODE_MODEL || "azure/gpt-4.1",
    OPENCODE_AGENT_PROMPT: process.env.OPENCODE_AGENT_PROMPT || "",
    TRIGGER_PHRASE: triggerPhrase,
    // Preserve command routing when review is requested inside an existing thread.
    DIRECT_PROMPT: /^review\b/i.test(directPrompt) ? directPrompt : aggregatedPrompt,
    AI_TRIGGER_NOTE_ID: String(body.object_attributes?.id || ""),
    GITLAB_WEBHOOK_PAYLOAD: JSON.stringify(minimalPayload),
  };

  logger.info("Triggering pipeline", {
    projectId,
    ref,
    variables: logger.maskSensitive(variables),
  });

  try {
    if (process.env.REVIEW_ONLY === "true" && !(await isReviewEnrolled(projectId, ref))) {
      await postEnrollmentRefusal(projectId, mrIid!, body.object_attributes.id);
      return c.json({ status: "refused", reason: "Source branch CI is not enrolled for review" });
    }
    const pipelineId = await triggerPipeline(
      projectId,
      ref,
      variables,
      mrIid ?? undefined
    );

    logger.info("Pipeline triggered successfully", {
      pipelineId,
      projectId,
      ref,
    });

    const triggeringNoteId = body.object_attributes?.id;
    if (triggeringNoteId) {
      await addReactionToNote({
        projectId,
        mrIid: mrIid ?? undefined,
        issueIid: issueIid ?? undefined,
        noteId: triggeringNoteId,
      });
    }

    // Cancel old pipelines if configured
    if (process.env.CANCEL_OLD_PIPELINES === "true") {
      await cancelOldPipelines(projectId, pipelineId, ref);
    }

    return c.json({ status: "started", pipelineId, branch: ref });
  } catch (error) {
    logger.error("Failed to trigger pipeline", {
      error: error instanceof Error ? error.message : error,
      projectId,
      ref,
    });
    return c.json({ error: "Failed to trigger pipeline" }, 500);
  }
});

// GitHub webhook endpoint: issue_comment / pull_request_review_comment with
// @ai trigger phrase -> repository_dispatch to the consumer repo workflow.
app.post("/webhook/github", async (c) => {
  const event = c.req.header("x-github-event");
  const signature = c.req.header("x-hub-signature-256") || "";

  logger.debug("GitHub webhook received", { event, hasSignature: !!signature });

  const rawBody = await c.req.text();
  if (!verifyGitHubSignature(rawBody, signature)) {
    logger.warn("GitHub webhook unauthorized - invalid signature");
    return c.text("unauthorized", 401);
  }

  if (event !== "issue_comment" && event !== "pull_request_review_comment") {
    logger.debug("Ignoring non-comment GitHub event", { event });
    return c.text("ignored");
  }

  const body = JSON.parse(rawBody) as {
    action?: string;
    comment?: { id: number; body?: string; user?: { login?: string } };
    issue?: { number?: number; title?: string; pull_request?: unknown };
    pull_request?: { number?: number };
    repository?: { full_name?: string; default_branch?: string };
  };

  if (body.action !== "created") return c.text("ignored");

  const note = body.comment?.body || "";
  const authorLogin = body.comment?.user?.login || "";
  const repoFullName = body.repository?.full_name || "";
  const [owner, repo] = repoFullName.split("/");
  const prNumber = body.issue?.pull_request || body.pull_request ? body.issue?.number : undefined;
  const issueNumber = !prNumber ? body.issue?.number : undefined;

  const triggerPhrase = process.env.TRIGGER_PHRASE || "@ai";
  const triggerRegex = new RegExp(
    `${triggerPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i"
  );
  if (!triggerRegex.test(note)) {
    logger.debug(`No ${triggerPhrase} mention found in GitHub comment`);
    return c.text("skipped");
  }

  if (process.env.AI_DISABLED === "true") {
    logger.warn("Bot is disabled, skipping trigger");
    return c.text("disabled");
  }

  if (process.env.AI_GITHUB_USERNAME && process.env.AI_GITHUB_USERNAME === authorLogin) {
    logger.warn("Ignoring self-triggered GitHub comment");
    return c.text("self-trigger");
  }

  const directMatch = note.match(new RegExp(`${triggerPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(.*)`, "is"));
  const command = directMatch ? directMatch[1].trim() : "";
  if (process.env.REVIEW_ONLY === "true" && (!prNumber || !/^review\b/i.test(command))) {
    return c.text("review-only: use @ai review on a pull request");
  }

  const key = `${authorLogin}:${repoFullName}:${prNumber || issueNumber || "general"}`;
  if (!(await limitByUser(key))) {
    logger.warn("Rate limit exceeded", { key, author: authorLogin });
    return c.text("rate-limited");
  }

  const ref = body.repository?.default_branch || "main";
  const variables = {
    AI_PLATFORM: "github",
    AI_TRIGGER: "true",
    AI_AUTHOR: authorLogin,
    AI_GITHUB_USERNAME: process.env.AI_GITHUB_USERNAME || "",
    AI_RESOURCE_TYPE: prNumber ? "pull_request" : "issue",
    AI_RESOURCE_ID: String(prNumber || issueNumber || ""),
    AI_PROJECT_PATH: repoFullName,
    AI_BRANCH: ref,
    OPENCODE_MODEL: process.env.OPENCODE_MODEL || "azure/gpt-4.1",
    OPENCODE_AGENT_PROMPT: process.env.OPENCODE_AGENT_PROMPT || "",
    TRIGGER_PHRASE: triggerPhrase,
    DIRECT_PROMPT: command,
    AI_TRIGGER_NOTE_ID: String(body.comment?.id || ""),
  };

  try {
    await dispatchAgentRun(owner, repo, variables);
    logger.info("GitHub agent run dispatched", { repo: repoFullName, pr: prNumber, issue: issueNumber });
    if (body.comment?.id) {
      await addGitHubReaction({ owner, repo, commentId: body.comment.id, emoji: "+1" });
    }
    return c.json({ status: "started", repo: repoFullName, branch: ref });
  } catch (error) {
    logger.error("Failed to dispatch GitHub agent run", {
      error: error instanceof Error ? error.message : error,
      repo: repoFullName,
    });
    return c.json({ error: "Failed to dispatch agent run" }, 500);
  }
});

function verifyGitHubSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signature.startsWith("sha256=")) return false;
  const expected = signature.slice("sha256=".length);
  // Lazy import keeps bun startup fast; node:crypto is always available.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac, timingSafeEqual } = require("node:crypto") as typeof import("node:crypto");
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (digest.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(digest), Buffer.from(expected));
}

const port = Number(process.env.PORT) || 3000;
logger.info(`GitLab AI Webhook Server starting on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
