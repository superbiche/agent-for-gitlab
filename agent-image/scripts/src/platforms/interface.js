// Platform interface for the review runner.
//
// The core review orchestration (review.js) works against this interface so
// GitLab and GitHub adapters stay interchangeable. Adapters own auth headers,
// URL shapes, pagination, inline-position mapping, and CI evidence.
//
// Each function receives the normalized context built by context.js:
//   { platform, projectId, projectPath, mrIid, resourceType, resourceId,
//     discussionId, gitlabToken, serverUrl, apiUrl, ... }
//
// Adapter contract:
//   api(context, method, path, data)          - low-level request, returns parsed JSON
//   postComment(context, message)            - reply on the triggering thread
//   fetchPullRequest(context)                - MR/PR metadata incl. diff refs
//   fetchDiffs(context)                      - unified diff entries
//   fetchNotes(context)                      - existing discussion notes
//   fetchDiffStatus(context)                 - diff completeness (risk gate)
//   postNote(context, body)                  - plain MR/PR note
//   postDiscussion(context, body, position)  - inline note, falls back to null on reject
//   buildPosition(diffs, finding, refs)      - map a finding to an inline position or null
//   fetchCiEvidence(context, headSha)        - published CI evidence (risk profile)

export function selectPlatform(context) {
  return context.platform === "github" ? "github" : "gitlab";
}

export async function loadAdapter(context) {
  const name = selectPlatform(context);
  if (name === "github") {
    return import("./github.js");
  }
  return import("./gitlab.js");
}
