import logger from "../logger.js";

// GitHub platform adapter. Same contract as platforms/gitlab.js (see
// platforms/interface.js). Auth is a fine-grained PAT or GitHub App token via
// GITHUB_TOKEN; never log the value. API base defaults to api.github.com but
// GHES is supported through GITHUB_API_URL / AI_API_URL.
function token(context) {
  return context.githubToken || process.env.GITHUB_TOKEN || "";
}

function repoPath(context) {
  const repo = context.projectPath || "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repository "${repo}". Expected "owner/repo" via AI_PROJECT_PATH.`);
  }
  return repo;
}

function baseUrl(context) {
  const base = context.apiUrl || process.env.GITHUB_API_URL || "https://api.github.com";
  return base.replace(/\/$/, "");
}

export async function githubApi(context, method, path, data = null) {
  const url = new URL(`${baseUrl(context)}${path}`);
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const auth = token(context);
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const response = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API error ${response.status}: ${body.slice(0, 500)}`);
  }

  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

// PR numbers are numbers; context.mrIid stays the shared review-resource id.
function prNumber(context, override) {
  const value = Number(override ?? context.mrIid ?? context.resourceId);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid GitHub PR number "${override ?? context.mrIid ?? context.resourceId}"`);
  }
  return value;
}

// GitHub review comments need the PR head SHA. review.js normalizes PR
// metadata to the GitLab diff_refs shape ({ base_sha, head_sha, start_sha })
// so the rest of the core stays unchanged.
function diffRefs(pr) {
  return {
    base_sha: pr?.base?.sha || null,
    head_sha: pr?.head?.sha || null,
    start_sha: pr?.base?.sha || null,
  };
}

export async function postComment(context, message) {
  const type = (context.resourceType || "").toLowerCase();
  const isIssue = type === "issue" || (!context.mrIid && type !== "pull_request");
  const number = prNumber(context, isIssue ? context.resourceId : undefined);
  const endpoint = `/repos/${repoPath(context)}/issues/${number}/comments`;

  try {
    const response = await githubApi(context, "POST", endpoint, { body: message });
    logger.info(`Posted comment to ${context.resourceType} #${number}`);
    return response;
  } catch (error) {
    logger.error(`Failed to post comment: ${error.message}`);
    return null;
  }
}

// Legacy GitLab-shaped names kept so review.js needs no per-platform branch.
export async function fetchMergeRequest(context, number = context.mrIid) {
  const pr = await githubApi(context, "GET", `/repos/${repoPath(context)}/pulls/${prNumber(context, number)}`);
  return { ...pr, diff_refs: diffRefs(pr) };
}

export async function fetchMergeRequestDiffs(context, number = context.mrIid) {
  const files = await paginated(context, `/repos/${repoPath(context)}/pulls/${prNumber(context, number)}/files`);
  return files.map((file) => ({
    old_path: file.previous_filename || file.filename,
    new_path: file.filename,
    renamed_file: file.status === "renamed",
    deleted_file: file.status === "removed",
    diff: file.patch || "",
    too_large: !file.patch && file.changes > 0,
  }));
}

export async function fetchMergeRequestNotes(context, number = context.mrIid) {
  const [issueComments, reviewComments] = await Promise.all([
    paginated(context, `/repos/${repoPath(context)}/issues/${prNumber(context, number)}/comments`),
    paginated(context, `/repos/${repoPath(context)}/pulls/${prNumber(context, number)}/comments`),
  ]);
  return [
    ...issueComments.map((note) => ({ id: note.id, body: note.body || "", author: note.user, created_at: note.created_at })),
    ...reviewComments.map((note) => ({ id: note.id, body: note.body || "", author: note.user, created_at: note.created_at, path: note.path, line: note.line || note.original_line })),
  ];
}

export async function postMergeRequestNote(context, number, body) {
  return githubApi(context, "POST", `/repos/${repoPath(context)}/issues/${prNumber(context, number)}/comments`, { body });
}

export async function postMergeRequestDiscussion(context, number, body, position) {
  const pr = prNumber(context, number);
  const payload = {
    body,
    commit_id: position.head_sha,
    path: position.new_path || position.old_path,
    line: position.new_line ?? position.old_line,
    side: position.new_line ? "RIGHT" : "LEFT",
  };
  if (position.start_line != null) {
    payload.start_line = position.start_line;
    payload.start_side = position.start_side || payload.side;
  }
  return githubApi(context, "POST", `/repos/${repoPath(context)}/pulls/${pr}/comments`, payload);
}

async function paginated(context, path) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await githubApi(context, "GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("Invalid GitHub list response");
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error("GitHub pagination limit reached; context is incomplete");
}

export async function fetchMergeRequestDiffStatus(context) {
  const pr = await fetchMergeRequest(context);
  if (!pr?.diff_refs?.head_sha) throw new Error("GitHub did not provide PR head SHA");
  // GitHub truncates large file lists; treat a patch-less changed file as
  // incomplete context, mirroring the GitLab overflow gate.
  const diffs = await fetchMergeRequestDiffs(context);
  if (diffs.some((d) => d.too_large)) throw new Error("Incomplete GitHub diff context; review cannot claim completion.");
  return { overflow: false };
}

// Platform-interface aliases (see platforms/interface.js contract).
export const api = githubApi;
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
export const buildPosition = buildGitHubPosition;

export function buildGitHubPosition(diffs, finding, diffRefs) {
  const diff = (diffs || []).find((candidate) => {
    return candidate.new_path === finding.file || candidate.old_path === finding.file;
  });
  if (!diff || !diff.diff || !diffRefs?.head_sha) {
    return null;
  }

  const line = findLineInPatch(diff.diff, finding);
  if (!line) return null;

  // GitHub review comments anchor to a single side: new (RIGHT) for added /
  // context lines, old (LEFT) for deletions. Multi-line suggestions use
  // start_line/start_side on the same side.
  const position = {
    head_sha: diffRefs.head_sha,
    old_path: diff.old_path || finding.file,
    new_path: diff.new_path || finding.file,
  };
  if (line.new_line) {
    position.new_line = line.new_line;
    if (finding.line_end && finding.line_end > finding.line_start) {
      position.start_line = finding.line_start;
      position.start_side = "RIGHT";
    }
  } else if (line.old_line) {
    position.old_line = line.old_line;
    if (finding.line_end && finding.line_end > finding.line_start) {
      position.start_line = finding.line_start;
      position.start_side = "LEFT";
    }
  } else {
    return null;
  }
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
