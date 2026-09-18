// Compatibility shim: the GitLab adapter now lives in platforms/gitlab.js.
// New code should import from ./platforms/interface.js (loadAdapter) and
// program against the platform interface. This shim keeps existing imports
// working during the migration slice.
export {
  gitlabApi,
  postComment,
  fetchMergeRequest,
  fetchMergeRequestDiffs,
  fetchMergeRequestNotes,
  postMergeRequestNote,
  postMergeRequestDiscussion,
  fetchMergeRequestDiffStatus,
  api,
  fetchPullRequest,
  fetchDiffs,
  fetchNotes,
  fetchDiffStatus,
  postNote,
  postDiscussion,
  buildPosition,
} from "./platforms/gitlab.js";
