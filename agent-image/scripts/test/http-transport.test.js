import test from "node:test";
import assert from "node:assert/strict";
import { causeSummary, fetchWithRetry } from "../src/platforms/http.js";

test("causeSummary preserves the undici cause chain instead of bare fetch failed", () => {
  const root = new TypeError("fetch failed", {
    cause: new Error("connect ECONNREFUSED 1.2.3.4:443", {
      cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
    }),
  });
  const summary = causeSummary(root);
  assert.match(summary, /fetch failed/);
  assert.match(summary, /ECONNREFUSED/);
});

test("causeSummary tolerates cycles and non-error input", () => {
  const loop = new Error("loop");
  loop.cause = loop;
  assert.equal(causeSummary(loop), "loop");
  assert.equal(causeSummary("plain string"), "plain string");
});

test("causeSummary redacts token-shaped values", () => {
  const summary = causeSummary(new Error('GitLab API error 401: {"error":"bad"} PRIVATE-TOKEN glpat-abcdef1234567890'));
  assert.doesNotMatch(summary, /glpat-abcdef/);
  assert.match(summary, /\*\*\*\*/);
  const bare = causeSummary(new Error("saw github_pat_abcdefghij0123456789 in output"));
  assert.doesNotMatch(bare, /github_pat_abcdef/);
});

test("fetchWithRetry retries once on network failure then surfaces the cause", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
    return new Response(JSON.stringify({ ok: true }));
  });
  try {
    const response = await fetchWithRetry("https://example.invalid/x", { method: "GET" }, { label: "Probe", delayMs: 0 });
    assert.equal(calls, 2);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    t.mock.restoreAll();
  }
});

test("fetchWithRetry throws a cause-carrying error after exhausting attempts", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) });
  });
  try {
    await assert.rejects(
      fetchWithRetry("https://example.invalid/x", { method: "GET" }, { label: "Probe", delayMs: 0 }),
      (error) => {
        assert.match(error.message, /Probe network failure after 2 attempts/);
        assert.match(error.message, /ENOTFOUND/);
        return true;
      },
    );
  } finally {
    t.mock.restoreAll();
  }
});

test("fetchWithRetry never retries an HTTP error status", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response("conflict", { status: 409 });
  });
  try {
    const response = await fetchWithRetry("https://example.invalid/x", { method: "POST" }, { label: "Probe" });
    assert.equal(calls, 1);
    assert.equal(response.status, 409);
  } finally {
    t.mock.restoreAll();
  }
});
