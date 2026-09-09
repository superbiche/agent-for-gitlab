import { gitlabApi } from "./gitlab.js";

// Published reports only: no traces, artifacts, variables or test execution.
export async function fetchCiEvidence(context, headSha) {
  const result = { fetched_at: new Date().toISOString(), head_sha: headSha,
    pipelines: [], limitations: ["Published GitLab CI evidence only; tests were not rerun."] };
  const limit = (message) => { if (!result.limitations.includes(message)) result.limitations.push(message); };
  if (!/^[a-f0-9]{40}$/i.test(headSha || "") || !/^\d+$/.test(String(context.projectId))) {
    result.head_sha = null;
    limit("Invalid project ID or reviewed SHA; CI evidence unavailable.");
    return result;
  }
  const project = String(context.projectId);
  const root = `/projects/${project}/pipelines`;
  const text = (value) => {
    if (typeof value !== "string") return null;
    if (value.length > 300) limit("Long report fields truncated to 300 characters.");
    return value.slice(0, 300);
  };
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const id = (value) => Number.isSafeInteger(value) && value > 0;
  const url = (value) => {
    try {
      const candidate = new URL(value);
      if (candidate.origin !== new URL(context.serverUrl).origin || candidate.username || candidate.password) return null;
      candidate.search = ""; candidate.hash = "";
      return text(candidate.href);
    } catch { return null; }
  };
  const get = async (path, label) => {
    try { return await gitlabApi(context, "GET", path); }
    catch { limit(`${label} retrieval failed; evidence unavailable.`); return null; }
  };
  const list = async (path, maxPages, label) => {
    const rows = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=20&page=${page}`, label);
      if (!Array.isArray(batch)) { limit(`${label} incomplete or invalid.`); break; }
      rows.push(...batch.slice(0, 20));
      if (batch.length < 20) return rows;
      if (page === maxPages) limit(`${label} pagination truncated.`);
    }
    return rows;
  };
  const currentPipeline = String(context.pipelineId ?? process.env.CI_PIPELINE_ID ?? "");
  const currentJob = String(context.jobId ?? process.env.CI_JOB_ID ?? "");
  const candidates = await list(`${root}?sha=${headSha}&order_by=id&sort=desc`, 2, "Pipeline list");
  for (const candidate of candidates) {
    if (!id(candidate?.id) || candidate.sha !== headSha ||
        (candidate.project_id != null && String(candidate.project_id) !== project)) {
      limit("Out-of-scope or invalid pipeline omitted."); continue;
    }
    if (String(candidate.id) === currentPipeline) { limit("Current review pipeline excluded."); continue; }
    if (result.pipelines.some((pipeline) => pipeline.id === candidate.id)) continue;
    if (result.pipelines.length === 3) { limit("Pipeline evidence truncated to three pipelines."); break; }
    const base = `${root}/${candidate.id}`;
    const detail = await get(base, "Pipeline details");
    if (!detail || detail.id !== candidate.id || detail.sha !== headSha || String(detail.project_id) !== project) {
      limit("Unverified pipeline scope omitted."); continue;
    }
    const pipeline = { id: detail.id, sha: headSha, status: text(detail.status),
      source: text(detail.source), web_url: url(detail.web_url), jobs: [], test_report: null };
    const jobs = await list(`${base}/jobs`, 5, `Pipeline ${detail.id} jobs`);
    for (const job of jobs) {
      if (String(job?.id) === currentJob) { limit("Current review job excluded."); continue; }
      if (!id(job?.id) || job.commit?.id !== headSha || job.pipeline?.id !== detail.id ||
          job.pipeline?.sha !== headSha || (job.pipeline?.project_id != null && String(job.pipeline.project_id) !== project)) {
        limit("Out-of-scope or invalid job omitted."); continue;
      }
      pipeline.jobs.push({ id: job.id, name: text(job.name), stage: text(job.stage),
        status: text(job.status), allow_failure: job.allow_failure === true, web_url: url(job.web_url) });
    }
    const report = await get(`${base}/test_report_summary`, `Pipeline ${detail.id} test report`);
    if (report && typeof report.total === "object" && report.total && Array.isArray(report.test_suites)) {
      const counts = (item) => Object.fromEntries(["total_count", "success_count", "failed_count", "skipped_count", "error_count"]
        .map((key) => [key, count(item?.[key])]));
      pipeline.test_report = { ...counts(report.total), suites: report.test_suites.slice(0, 20)
        .map((suite) => ({ name: text(suite.name), ...counts(suite) })) };
      if (report.test_suites.length > 20) limit("Test suites truncated to twenty per pipeline.");
      if (!report.total.total_count) limit(`Pipeline ${detail.id} has no published test cases; test results unavailable.`);
    } else limit(`Pipeline ${detail.id} published test report unavailable.`);
    result.pipelines.push(pipeline);
  }
  if (!result.pipelines.length) limit("No eligible pipelines available for the reviewed SHA.");
  // Bound the entire serialized context, including multi-byte report names.
  while (Buffer.byteLength(JSON.stringify(result)) > 32768 && result.pipelines.length) {
    limit("CI evidence truncated to the 32 KiB serialized output limit.");
    const last = result.pipelines.at(-1);
    if (last.jobs.length) last.jobs.pop();
    else if (last.test_report?.suites.length) last.test_report.suites.pop();
    else result.pipelines.pop();
  }
  return result;
}
