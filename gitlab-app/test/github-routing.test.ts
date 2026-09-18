import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";

process.env.GITHUB_WEBHOOK_SECRET = "gh-secret";
process.env.GITHUB_TOKEN = "gh-token";
process.env.WEBHOOK_SECRET = "gl-secret";
process.env.RATE_LIMITING_ENABLED = "false";
process.env.AI_GITHUB_USERNAME = "ai-bot";
process.env.LOG_LEVEL = "error";
process.env.REVIEW_ONLY = "true";

const { default: app } = await import("../src/index");

function signed(body: unknown): { raw: string; sig: string } {
  const raw = JSON.stringify(body);
  const sig = "sha256=" + createHmac("sha256", "gh-secret").update(raw).digest("hex");
  return { raw, sig };
}

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
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.endsWith("/dispatches")) {
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
    expect(payload.AI_PLATFORM).toBe("github");
    expect(payload.AI_RESOURCE_TYPE).toBe("pull_request");
    expect(payload.AI_RESOURCE_ID).toBe("7");
    expect(payload.AI_PROJECT_PATH).toBe("owner/repo");
    expect(payload.DIRECT_PROMPT).toBe("review the diff");
    expect(reaction).toContain("/repos/owner/repo/issues/comments/55/reactions");
  } finally {
    globalThis.fetch = original;
  }
});
