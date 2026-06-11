import logger from "./logger.js";

export async function gitlabApi(context, method, path, data = null) {
  const baseUrl = context.apiUrl || `${context.serverUrl}/api/v4`;
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${path}`);
  const response = await fetch(url, {
    method,
    headers: {
      "PRIVATE-TOKEN": context.gitlabToken,
      "Content-Type": "application/json",
    },
    body: data ? JSON.stringify(data) : undefined,
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GitLab API error ${response.status}: ${body}`);
  }

  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export async function postComment(context, message) {
  const isIssue = (context.resourceType || "").toLowerCase() === "issue";
  const discussionId = context.discussionId;
  const endpoint = isIssue
    ? `/projects/${context.projectId}/issues/${context.resourceId}/notes`
    : discussionId
    ? `/projects/${context.projectId}/merge_requests/${context.resourceId}/discussions/${discussionId}/notes`
    : `/projects/${context.projectId}/merge_requests/${context.resourceId}/notes`;

  try {
    const response = await gitlabApi(context, "POST", endpoint, { body: message });
    logger.info(
      `Posted comment to ${context.resourceType} #${context.resourceId}${
        !isIssue && discussionId ? ` (discussion ${discussionId})` : ""
      }`
    );
    return response;
  } catch (error) {
    logger.error(`Failed to post comment: ${error.message}`);
    return null;
  }
}

export async function fetchMergeRequest(context, mrIid = context.mrIid) {
  return gitlabApi(context, "GET", `/projects/${context.projectId}/merge_requests/${mrIid}`);
}

export async function fetchMergeRequestDiffs(context, mrIid = context.mrIid) {
  return gitlabApi(context, "GET", `/projects/${context.projectId}/merge_requests/${mrIid}/diffs`);
}

export async function fetchMergeRequestNotes(context, mrIid = context.mrIid) {
  return gitlabApi(context, "GET", `/projects/${context.projectId}/merge_requests/${mrIid}/notes?per_page=100`);
}

export async function postMergeRequestNote(context, mrIid, body) {
  return gitlabApi(context, "POST", `/projects/${context.projectId}/merge_requests/${mrIid}/notes`, { body });
}

export async function postMergeRequestDiscussion(context, mrIid, body, position) {
  return gitlabApi(context, "POST", `/projects/${context.projectId}/merge_requests/${mrIid}/discussions`, {
    body,
    position,
  });
}
