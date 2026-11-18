import { test, expect } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The lugus shape: both credentials as files (OpenBao lane A), App ids in env.
const dir = mkdtempSync(join(tmpdir(), "gh-routing-"));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
writeFileSync(join(dir, "GITHUB_APP_PRIVATE_KEY"), privateKey.export({ type: "pkcs1", format: "pem" }));
writeFileSync(join(dir, "GITHUB_WEBHOOK_SECRET"), "gh-secret");
process.env.GITHUB_WEBHOOK_SECRET_FILE = join(dir, "GITHUB_WEBHOOK_SECRET");
process.env.GITHUB_APP_PRIVATE_KEY_FILE = join(dir, "GITHUB_APP_PRIVATE_KEY");
process.env.GITHUB_APP_CLIENT_ID = "Iv23test";
process.env.GITHUB_APP_INSTALLATION_ID = "123";
process.env.WEBHOOK_SECRET = "gl-secret";
process.env.RATE_LIMITING_ENABLED = "false";
process.env.AI_GITHUB_USERNAME = "ai-bot";
process.env.LOG_LEVEL = "error";
process.env.REVIEW_ONLY = "true";

// bun test shares one module cache across files: a query gives this file its own
// server instance, started with the environment above.
const { default: app } = await import("../src/index.ts?github-routing");

function signed(body: unknown): { raw: string; sig: string } {
  const raw = JSON.stringify(body);
  const sig = "sha256=" + createHmac("sha256", "gh-secret").update(raw).digest("hex");
  return { raw, sig };
}

const tokenResponse = () =>
  new Response(JSON.stringify({ token: "ghs_installation", expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
    status: 201,
  });

const comment = (text: string, pr = true) => ({
  action: "created",
  comment: { id: 55, body: text, user: { login: "operator" } },
  issue: pr ? { number: 7, title: "PR title", pull_request: {} } : { number: 3, title: "Issue" },
  repository: { full_name: "owner/repo", default_branch: "main" },
});

const postGitHub = (body: unknown, event = "issue_comment", sig?: string) => {
  const { raw, sig: good } = signed(body);
  return app.fetch(
    new Request("http://localhost/webhook/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": sig ?? good },
      body: raw,
    })
  );
};

test("rejects bad signature and non-comment events before dispatch", async () => {
  expect((await postGitHub(comment("@ai review"), "issue_comment", "sha256=bad")).status).toBe(401);
  expect(await (await postGitHub(comment("@ai review"), "push")).text()).toContain("ignored");
  expect(await (await postGitHub({ ...comment("@ai review"), action: "edited" })).text()).toContain("ignored");
});

test("review-only refuses generic and issue commands", async () => {
  for (const b of [comment("@ai fix this"), comment("@ai review", false)]) {
    expect(await (await postGitHub(b)).text()).toContain("review-only");
  }
});

test("ignores self-triggered comments", async () => {
  const body = comment("@ai review");
  body.comment.user.login = "ai-bot";
  expect(await (await postGitHub(body)).text()).toContain("self-trigger");
});

test("dispatches review with platform variables and reacts", async () => {
  const original = globalThis.fetch;
  let dispatch: { url: string; body: Record<string, unknown> } | undefined;
  let reaction: string | undefined;
  let auth: string | undefined;
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.endsWith("/app/installations/123/access_tokens")) return tokenResponse();
    if (url.endsWith("/dispatches")) {
      auth = (init as { headers?: Record<string, string> })?.headers?.Authorization;
      dispatch = { url, body: JSON.parse(init?.body || "{}") };
      return new Response("", { status: 204 });
    }
    if (url.includes("/reactions")) {
      reaction = url;
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const res = await postGitHub(comment("@ai review the diff"));
    expect(res.status).toBe(200);
    const payload = dispatch?.body.client_payload as Record<string, string>;
    expect(dispatch?.body.event_type).toBe("ai-agent");
    // GitHub caps client_payload at 10 properties; AI_PLATFORM defaults in the consumer workflow.
    expect(Object.keys(payload).length).toBeLessThanOrEqual(10);
    expect(payload.AI_RESOURCE_TYPE).toBe("pull_request");
    expect(payload.AI_RESOURCE_ID).toBe("7");
    expect(payload.AI_PROJECT_PATH).toBe("owner/repo");
    expect(payload.DIRECT_PROMPT).toBe("review the diff");
    expect(reaction).toContain("/repos/owner/repo/issues/comments/55/reactions");
    // The dispatch runs as the App installation, never with a personal token.
    expect(auth).toBe("Bearer ghs_installation");
  } finally {
    globalThis.fetch = original;
  }
});

test("reacts to inline review comments without posting a comment", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/access_tokens")) return tokenResponse();
    calls.push(url);
    if (url.endsWith("/dispatches")) return new Response("", { status: 204 });
    if (url.includes("/reactions")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const body = {
      action: "created",
      comment: { id: 56, body: "@ai review", user: { login: "operator" } },
      pull_request: { number: 7 },
      repository: { full_name: "owner/repo", default_branch: "main" },
    };
    expect((await postGitHub(body, "pull_request_review_comment")).status).toBe(200);
    expect(calls).toEqual([
      "https://api.github.com/repos/owner/repo/dispatches",
      "https://api.github.com/repos/owner/repo/pulls/comments/56/reactions",
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
