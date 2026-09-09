import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCiEvidence } from '../src/ci-evidence.js';
const sha = 'a'.repeat(40);
const ctx = { projectId: 117, serverUrl: 'https://gitlab.example', gitlabToken: 'fixture', pipelineId: 999, jobId: 999 };
const pipe = (id = 1) => ({ id, project_id: 117, sha, status: 'success' });
const job = (id, pid = 1) => ({ id, name: 'test', status: 'success', commit: { id: sha }, pipeline: pipe(pid) });
function standard(url) {
  if (url.pathname.endsWith('/pipelines')) return [pipe()];
  if (url.pathname.endsWith('/jobs')) return [job(2)];
  if (url.pathname.endsWith('/test_report_summary')) return { total: { total_count: 2, failed_count: 1 }, test_suites: [{ name: 'Unit', total_count: 2, failed_count: 1 }] };
  return pipe();
}
async function run(t, route = standard, head = sha) {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input); paths.push(url.pathname + url.search);
    const value = route(url);
    return new Response(JSON.stringify(value?.error ? { secret: 'never-expose' } : value), { status: value?.error ? 500 : 200 });
  });
  return { result: await fetchCiEvidence(ctx, head), paths };
}
test('exact SHA published jobs and suite evidence', async (t) => {
  const { result, paths } = await run(t);
  assert.equal(result.pipelines[0].jobs[0].id, 2);
  assert.equal(result.pipelines[0].test_report.suites[0].failed_count, 1);
  assert.ok(paths[0].includes(`sha=${sha}`));
  assert.ok(paths.every((p) => !/trace|artifacts|variables/.test(p)));
});
test('invalid SHA makes no requests', async (t) => {
  const { result, paths } = await run(t, standard, 'bad');
  assert.equal(paths.length, 0); assert.equal(result.head_sha, null);
});
test('empty pipeline evidence explicit', async (t) => {
  const { result } = await run(t, () => []);
  assert.match(result.limitations.join(' '), /No eligible pipelines/);
});
test('API errors sanitized and test report unavailable', async (t) => {
  const { result } = await run(t, (u) => u.pathname.endsWith('test_report_summary') ? { error: true } : standard(u));
  assert.equal(result.pipelines[0].test_report, null);
  assert.match(result.limitations.join(' '), /retrieval failed/);
  assert.doesNotMatch(JSON.stringify(result), /never-expose/);
});
test('head and project scope mismatch rejected', async (t) => {
  const { result } = await run(t, (u) => u.pathname.endsWith('/pipelines') ? [pipe(), { ...pipe(2), project_id: 9 }] : { ...pipe(), sha: 'b'.repeat(40) });
  assert.equal(result.pipelines.length, 0);
  assert.match(result.limitations.join(' '), /Unverified pipeline scope/);
});
test('review pipeline and job excluded, mismatched jobs rejected', async (t) => {
  const { result } = await run(t, (u) => {
    if (u.pathname.endsWith('/pipelines')) return [pipe(999), pipe()];
    if (u.pathname.endsWith('/jobs')) return [job(999), { ...job(2), commit: { id: 'b'.repeat(40) } }, job(3)];
    return standard(u);
  });
  assert.deepEqual(result.pipelines[0].jobs.map((j) => j.id), [3]);
  assert.match(result.limitations.join(' '), /Current review pipeline excluded/);
});
test('job pagination includes second page', async (t) => {
  const { result } = await run(t, (u) => u.pathname.endsWith('/jobs') ? (u.searchParams.get('page') === '1' ? Array.from({ length: 20 }, (_, i) => job(i + 1)) : [job(21)]) : standard(u));
  assert.equal(result.pipelines[0].jobs.length, 21);
});
test('count and byte limits explicit, bounded requests', async (t) => {
  const { result, paths } = await run(t, (u) => {
    if (u.pathname.endsWith('/pipelines')) return Array.from({ length: 20 }, (_, i) => pipe(i + 1));
    const pid = Number(u.pathname.match(/pipelines\/(\d+)/)?.[1]);
    if (u.pathname.endsWith('/jobs')) return Array.from({ length: 20 }, (_, i) => ({ ...job(i + 1, pid), name: '界'.repeat(1000), stage: '界'.repeat(1000) }));
    if (u.pathname.endsWith('/test_report_summary')) return { total: { total_count: 30 }, test_suites: Array.from({ length: 30 }, () => ({ name: 'suite' })) };
    return pipe(pid);
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  assert.ok(paths.length <= 23);
  assert.match(result.limitations.join(' '), /pagination truncated/);
  assert.match(result.limitations.join(' '), /32 KiB/);
  assert.match(result.limitations.join(' '), /Test suites truncated/);
});
test('absent test cases never imply tests ran', async (t) => {
  const { result } = await run(t, (u) => u.pathname.endsWith('test_report_summary') ? { total: { total_count: 0 }, test_suites: [] } : standard(u));
  assert.match(result.limitations.join(' '), /no published test cases/);
});
