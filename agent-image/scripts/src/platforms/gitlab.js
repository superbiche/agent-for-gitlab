import logger from "../logger.js";
import { fetchWithRetry, causeSummary } from "./http.js";

export async function gitlabApi(context, method, path, data = null) {
  const baseUrl = context.apiUrl || `${context.serverUrl}/api/v4`;
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${path}`);
  let response;
  try {
    response = await fetchWithRetry(
      url,
      {
        method,
        headers: {
          "PRIVATE-TOKEN": context.gitlabToken,
          "Content-Type": "application/json",
        },
        body: data ? JSON.stringify(data) : undefined,
      },
      { label: `GitLab ${method} ${path}` },
    );
  } catch (error) {
    // Network failure after retry: keep the cause chain visible so the next
    // "fetch failed" is diagnosable instead of a bare TypeError message.
    throw new Error(`GitLab ${method} ${path}: ${causeSummary(error)}`, { cause: error.cause ?? error });
  }

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
    logger.error(`Failed to post comment: ${causeSummary(error)}`);
    return null;
  }
}

export async function fetchMergeRequest(context, mrIid = context.mrIid) {
  return gitlabApi(context, "GET", `/projects/${context.projectId}/merge_requests/${mrIid}`);
}

export async function fetchMergeRequestDiffs(context, mrIid = context.mrIid) {
  return paginated(context, `/projects/${context.projectId}/merge_requests/${mrIid}/diffs`);
}

export async function fetchMergeRequestNotes(context, mrIid = context.mrIid) {
  return paginated(context, `/projects/${context.projectId}/merge_requests/${mrIid}/notes`);
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

async function paginated(context, path) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await gitlabApi(context, "GET", `${path}?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("Invalid GitLab list response");
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error("GitLab pagination limit reached; context is incomplete");
}

export async function fetchMergeRequestDiffStatus(context) {
  // GitLab 17.x exposes overflow here; /diffs only gained size flags later.
  const result = await gitlabApi(context, "GET", `/projects/${context.projectId}/merge_requests/${context.mrIid}/changes`);
  if (typeof result?.overflow !== "boolean") throw new Error("GitLab did not provide diff completeness status");
  return { overflow: result.overflow };
}

// Platform-interface aliases. review.js and ci-evidence.js program against
// these names so the GitHub adapter can slot in without touching the core.
export const api = gitlabApi;
export const fetchPullRequest = fetchMergeRequest;
export const fetchDiffs = fetchMergeRequestDiffs;
export const fetchNotes = fetchMergeRequestNotes;
export const fetchDiffStatus = fetchMergeRequestDiffStatus;
export async function postNote(context, body) {
  return postMergeRequestNote(context, context.mrIid, body);
}
export async function postDiscussion(context, body, position) {
  return postMergeRequestDiscussion(context, context.mrIid, body, position);
}
export const buildPosition = buildGitLabPosition;

export function buildGitLabPosition(diffs, finding, diffRefs) {
  const diff = (diffs || []).find((candidate) => {
    return candidate.new_path === finding.file || candidate.old_path === finding.file;
  });
  if (!diff || !diff.diff || !diffRefs?.base_sha || !diffRefs?.head_sha || !diffRefs?.start_sha) {
    return null;
  }

  const line = findLineInPatch(diff.diff, finding);
  if (!line) return null;

  const position = {
    position_type: "text",
    base_sha: diffRefs.base_sha,
    head_sha: diffRefs.head_sha,
    start_sha: diffRefs.start_sha,
    old_path: diff.old_path || finding.file,
    new_path: diff.new_path || finding.file,
  };

  if (line.old_line) position.old_line = line.old_line;
  if (line.new_line) position.new_line = line.new_line;
  return position;
}

function findLineInPatch(patch, finding) {
  let oldLine = 0;
  let newLine = 0;
  const targetNew = positiveOrNull(finding.line_start);
  const targetOld = positiveOrNull(finding.old_line);

  for (const rawLine of patch.split("\n")) {
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (!rawLine || rawLine.startsWith("\\ No newline")) continue;
    const prefix = rawLine[0];

    if (prefix === "+") {
      if (newLine === targetNew) return { new_line: newLine };
      newLine += 1;
      continue;
    }

    if (prefix === "-") {
      if (targetOld && oldLine === targetOld) return { old_line: oldLine };
      oldLine += 1;
      continue;
    }

    if ((targetOld && oldLine === targetOld) || newLine === targetNew) {
      return { old_line: oldLine, new_line: newLine };
    }
    oldLine += 1;
    newLine += 1;
  }

  return null;
}

function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
