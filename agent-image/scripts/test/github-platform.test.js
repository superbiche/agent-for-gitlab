import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDiffPosition } from "../src/review.js";
import { buildGitHubPosition } from "../src/platforms/github.js";
import {
  fetchMergeRequest,
  fetchMergeRequestDiffs,
  fetchMergeRequestNotes,
  postMergeRequestDiscussion,
} from "../src/platforms/github.js";

const fixtureDir = new URL("./fixtures/", import.meta.url);
const diffs = JSON.parse(readFileSync(join(fixtureDir.pathname, "diffs.json"), "utf8"));
const refs = { base_sha: "a".repeat(40), head_sha: "b".repeat(40), start_sha: "a".repeat(40) };
const gh = { platform: "github" };

test("github maps an added line to RIGHT side with head sha", () => {
  const position = buildGitHubPosition(diffs, { file: "src/example.js", line_start: 9 }, refs);
  assert.equal(position.path, undefined);
  assert.equal(position.new_path, "src/example.js");
  assert.equal(position.new_line, 9);
  assert.equal(position.head_sha, refs.head_sha);
  assert.equal(position.old_line, undefined);
});

test("github maps a deleted line to LEFT side", () => {
  const position = buildGitHubPosition(diffs, { file: "src/deleted.js", line_start: 4, old_line: 4 }, refs);
  assert.equal(position.old_line, 4);
  assert.equal(position.new_line, undefined);
});

test("github maps a multi-line finding to start_line on the same side", () => {
  const position = buildGitHubPosition(diffs, { file: "src/example.js", line_start: 9, line_end: 10 }, refs);
  assert.equal(position.new_line, 9);
  assert.equal(position.start_line, 9);
  assert.equal(position.start_side, "RIGHT");
});

test("github returns null without head sha", () => {
  assert.equal(buildGitHubPosition(diffs, { file: "src/example.js", line_start: 9 }, {}), null);
});

test("buildDiffPosition dispatches github to head-sha positions", () => {
  const position = buildDiffPosition(diffs, { file: "src/example.js", line_start: 9 }, refs, gh);
  assert.equal(position.head_sha, refs.head_sha);
  assert.equal(position.position_type, undefined);
});

test("github PR metadata normalizes to diff_refs", async (t) => {
  const pr = { number: 7, base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } };
  const seen = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    seen.push(String(input));
    if (url.pathname.endsWith("/pulls/7/files")) {
      return new Response(JSON.stringify([{ filename: "a.js", status: "modified", patch: "@@ -1 +1 @@\n+x" }]));
    }
    if (url.pathname.endsWith("/pulls/7/comments")) {
      return new Response(JSON.stringify([{ id: 1, body: "inline", user: {}, path: "a.js", line: 1 }]));
    }
    if (url.pathname.endsWith("/issues/7/comments")) {
      return new Response(JSON.stringify([{ id: 2, body: "note", user: {} }]));
    }
    if (url.pathname.endsWith("/pulls/7")) return new Response(JSON.stringify(pr));
    throw new Error(`unexpected ${url.pathname}`);
  });
  try {
    const context = { platform: "github", projectPath: "owner/repo", mrIid: "7", githubToken: "fixture" };
    const meta = await fetchMergeRequest(context);
    assert.equal(meta.diff_refs.head_sha, "b".repeat(40));
    assert.equal(meta.diff_refs.start_sha, "a".repeat(40));
    const files = await fetchMergeRequestDiffs(context);
    assert.equal(files[0].new_path, "a.js");
    assert.ok(seen.some((u) => u.includes("/pulls/7/files") && u.includes("per_page=30")));
    const notes = await fetchMergeRequestNotes(context);
    assert.equal(notes.length, 2);
  } finally { t.mock.restoreAll(); }
});

test("github review comment posts commit_id/path/line/side", async (t) => {
  let seen;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    seen = { url: String(input), body: JSON.parse(init.body), auth: init.headers.Authorization };
    return new Response(JSON.stringify({ id: 9 }));
  });
  try {
    const context = { platform: "github", projectPath: "owner/repo", mrIid: "7", githubToken: "secret-value" };
    const position = buildGitHubPosition(diffs, { file: "src/example.js", line_start: 9 }, refs);
    await postMergeRequestDiscussion(context, 7, "finding", position);
    assert.match(seen.url, /\/repos\/owner\/repo\/pulls\/7\/comments/);
    assert.equal(seen.body.commit_id, "b".repeat(40));
    assert.equal(seen.body.path, "src/example.js");
    assert.equal(seen.body.line, 9);
    assert.equal(seen.body.side, "RIGHT");
    assert.equal(seen.auth, "Bearer secret-value");
  } finally { t.mock.restoreAll(); }
});

test("github rejects invalid repo and PR numbers without calling the API", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => { calls.push(String(input)); return new Response("{}"); });
  try {
    await assert.rejects(fetchMergeRequest({ platform: "github", projectPath: "not-a-repo", mrIid: "7" }), /owner\/repo/);
    await assert.rejects(fetchMergeRequest({ platform: "github", projectPath: "owner/repo", mrIid: "0" }), /PR number/);
    assert.equal(calls.length, 0);
  } finally { t.mock.restoreAll(); }
});
