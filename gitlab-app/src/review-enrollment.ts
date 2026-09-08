import { createHash } from "node:crypto";

// Approved CI entrypoint bytes are deployed alongside the verified consumer routers.
// This rejects older, unenrolled MR branches before their ordinary CI can start.
export async function isReviewEnrolled(projectId: number, ref: string): Promise<boolean> {
  const approved = (process.env.REVIEW_CI_CONFIG_SHA256 || "").split(",").filter(value => /^[a-f0-9]{64}$/.test(value));
  if (!approved.length) return false;
  const base = `${process.env.GITLAB_URL || "https://gitlab.com"}/api/v4/projects/${projectId}`;
  const headers = { "PRIVATE-TOKEN": process.env.GITLAB_TOKEN || "" };
  const projectResponse = await fetch(base, { headers });
  if (!projectResponse.ok) throw new Error("Could not verify project CI enrollment");
  const project = await projectResponse.json() as { ci_config_path?: string };
  const path = project.ci_config_path || ".gitlab-ci.yml";
  // External/custom-provider entrypoints are not part of this enrollment.
  if (path.includes("@") || path.includes("://")) return false;
  const response = await fetch(`${base}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`, { headers });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("Could not verify source-branch CI enrollment");
  const hash = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
  return approved.includes(hash);
}

export async function postEnrollmentRefusal(projectId: number, mrIid: number, noteId: number): Promise<void> {
  const response = await fetch(`${process.env.GITLAB_URL || "https://gitlab.com"}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`, {
    method: "POST",
    headers: { "PRIVATE-TOKEN": process.env.GITLAB_TOKEN || "", "Content-Type": "application/json" },
    body: JSON.stringify({ body: `AI risk review not started: this source branch does not contain an approved review CI entrypoint. Rebase onto the enrolled default branch, or have its CI change validated and enrolled, then request review again. No pipeline was created.\n\nTrigger note: ${noteId}\n\nAutomated review webhook.` }),
  });
  if (!response.ok) throw new Error("Could not report CI enrollment refusal");
}
