import { logger } from "./logger";

function apiBase(): string {
  return (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.GITHUB_TOKEN || ""}`,
    ...extra,
  };
}

export interface DispatchVariables {
  [key: string]: string;
}

// Trigger a repository_dispatch event; the consumer workflow filters on
// event.client_payload.trigger === "ai" and runs the ai-runner job.
export async function dispatchAgentRun(
  owner: string,
  repo: string,
  variables: DispatchVariables
): Promise<void> {
  const url = `${apiBase()}/repos/${owner}/${repo}/dispatches`;
  const eventType = process.env.GITHUB_DISPATCH_EVENT || "ai-agent";
  logger.debug("Dispatching GitHub agent run", { owner, repo, eventType });

  const response = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ event_type: eventType, client_payload: { trigger: "ai", ...variables } }),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error("Agent dispatch failed", { status: response.status, body: text.slice(0, 500), owner, repo });
    throw new Error(`GitHub dispatch failed: ${response.statusText}`);
  }
  logger.info("Agent run dispatched", { owner, repo, eventType });
}

export async function addReaction(params: {
  owner: string;
  repo: string;
  commentId: number;
  emoji?: string;
}): Promise<void> {
  const { owner, repo, commentId } = params;
  const emoji = params.emoji || "+1";
  if (!commentId) return;
  try {
    const res = await fetch(`${apiBase()}/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ content: emoji }),
    });
    if (!res.ok) {
      logger.warn("Failed to add reaction", { status: res.status, owner, repo, commentId });
    }
  } catch (error) {
    logger.warn("Error adding reaction", { error: error instanceof Error ? error.message : error });
  }
}

export function sanitizeBranchName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

// Post a short acknowledgment comment on the triggering issue/PR (GitHub
// path). Preferred over the emoji reaction: visible without hover, and the
// message is configurable via AI_ACK_MESSAGE on the webhook server.
export async function postAckComment(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  message?: string;
}): Promise<void> {
  const { owner, repo, issueNumber, message = "on it" } = params;
  if (!issueNumber) return;
  try {
    const res = await fetch(
      `${apiBase()}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ body: message }),
      }
    );
    if (!res.ok) {
      logger.warn("Failed to post ack comment", { status: res.status, owner, repo, issueNumber });
    }
  } catch (error) {
    logger.warn("Error posting ack comment", { error: error instanceof Error ? error.message : error });
  }
}
