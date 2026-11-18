import { test, expect, afterEach } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubAppAuth, loadGitHubAppConfig, type GitHubAppConfig } from "../src/github";
import { ConfigError, readSecret } from "../src/secrets";

const dir = mkdtempSync(join(tmpdir(), "gh-app-"));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const keyFile = join(dir, "key.pem");
writeFileSync(keyFile, pem);

const ENV_NAMES = [
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_FILE",
  "T_SECRET",
  "T_SECRET_FILE",
];
const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
afterEach(() => {
  for (const n of ENV_NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});
function setEnv(values: Record<string, string | undefined>) {
  for (const n of ENV_NAMES) delete process.env[n];
  for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
}
function file(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("expected a ConfigError");
};

test("readSecret reads <NAME>_FILE, strips one newline, refuses ambiguous or bad files", () => {
  setEnv({ T_SECRET_FILE: file("one", "s3cret\n") });
  expect(readSecret("T_SECRET")).toBe("s3cret");
  setEnv({ T_SECRET: "direct" });
  expect(readSecret("T_SECRET")).toBe("direct");
  setEnv({});
  expect(readSecret("T_SECRET")).toBeUndefined();
  setEnv({ T_SECRET: "a", T_SECRET_FILE: file("both", "b") });
  expect(refusal(() => readSecret("T_SECRET"))).toContain("both set");
  setEnv({ T_SECRET_FILE: join(dir, "missing") });
  expect(refusal(() => readSecret("T_SECRET"))).toContain("readable");
  setEnv({ T_SECRET_FILE: file("empty", "") });
  expect(refusal(() => readSecret("T_SECRET"))).toContain("empty");
  setEnv({ T_SECRET_FILE: file("two", "a\nb\n") });
  expect(refusal(() => readSecret("T_SECRET"))).toContain("more than one line");
  setEnv({ T_SECRET_FILE: file("pem", pem) });
  expect(readSecret("T_SECRET", { multiline: true })).toBe(pem);
});

test("readSecret refusals never carry the value", () => {
  setEnv({ T_SECRET_FILE: file("leak", "do-not-print\nsecond\n") });
  expect(refusal(() => readSecret("T_SECRET"))).not.toContain("do-not-print");
});

test("an unreadable credential file is refused", () => {
  if (process.getuid?.() === 0) return; // root reads a 0000 file
  const p = file("unreadable", "x");
  chmodSync(p, 0o000);
  setEnv({ T_SECRET_FILE: p });
  expect(refusal(() => readSecret("T_SECRET"))).toContain("readable");
});

test("loadGitHubAppConfig: absent lane, complete lane, partial or invalid lane", () => {
  setEnv({});
  expect(loadGitHubAppConfig()).toBeUndefined();
  setEnv({ GITHUB_APP_CLIENT_ID: "Iv23x", GITHUB_APP_INSTALLATION_ID: "42", GITHUB_APP_PRIVATE_KEY_FILE: keyFile });
  const cfg = loadGitHubAppConfig();
  expect(cfg?.clientId).toBe("Iv23x");
  expect(cfg?.installationId).toBe("42");
  setEnv({ GITHUB_APP_INSTALLATION_ID: "42", GITHUB_APP_PRIVATE_KEY_FILE: keyFile });
  expect(refusal(() => loadGitHubAppConfig())).toContain("GITHUB_APP_CLIENT_ID");
  setEnv({ GITHUB_APP_CLIENT_ID: "Iv23x", GITHUB_APP_INSTALLATION_ID: "abc", GITHUB_APP_PRIVATE_KEY_FILE: keyFile });
  expect(refusal(() => loadGitHubAppConfig())).toContain("GITHUB_APP_INSTALLATION_ID");
  setEnv({ GITHUB_APP_CLIENT_ID: "Iv23x", GITHUB_APP_INSTALLATION_ID: "42" });
  expect(refusal(() => loadGitHubAppConfig())).toContain("GITHUB_APP_PRIVATE_KEY");
  setEnv({ GITHUB_APP_CLIENT_ID: "Iv23x", GITHUB_APP_INSTALLATION_ID: "42", GITHUB_APP_PRIVATE_KEY_FILE: file("bad.pem", "not a key\n") });
  expect(refusal(() => loadGitHubAppConfig())).toContain("not a PEM private key");
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  setEnv({ GITHUB_APP_CLIENT_ID: "Iv23x", GITHUB_APP_INSTALLATION_ID: "42", GITHUB_APP_PRIVATE_KEY_FILE: file("ec.pem", ec) });
  expect(refusal(() => loadGitHubAppConfig())).toContain("RSA");
});

const config = (): GitHubAppConfig => ({ clientId: "Iv23x", installationId: "42", privateKey });

test("the App JWT is RS256, issued by the client ID, backdated and short-lived", () => {
  const nowMs = 1_800_000_000_000;
  const jwt = new GitHubAppAuth(config(), () => nowMs).appJwt();
  const [h, p, s] = jwt.split(".");
  expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  expect(claims).toEqual({ iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "Iv23x" });
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  expect(verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
});

function withFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
const minted = (n: number, expiresAtMs: number) =>
  new Response(JSON.stringify({ token: `ghs_${n}`, expires_at: new Date(expiresAtMs).toISOString() }), { status: 201 });

test("installation tokens are cached, shared by concurrent callers, and renewed before expiry", async () => {
  let now = 1_800_000_000_000;
  let mints = 0;
  const restore = withFetch((url, init) => {
    expect(url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(init?.method).toBe("POST");
    mints += 1;
    return minted(mints, now + 3600_000);
  });
  try {
    const auth = new GitHubAppAuth(config(), () => now);
    expect(await Promise.all([auth.token(), auth.token()])).toEqual(["ghs_1", "ghs_1"]);
    expect(mints).toBe(1);
    now += 54 * 60_000; // inside the cache window (expiry minus 5 minutes)
    expect(await auth.token()).toBe("ghs_1");
    now += 2 * 60_000; // past it
    expect(await auth.token()).toBe("ghs_2");
    expect(mints).toBe(2);
    auth.invalidate("ghs_2");
    expect(await auth.token()).toBe("ghs_3");
  } finally {
    restore();
  }
});

test("a failed token exchange throws without caching", async () => {
  let calls = 0;
  const restore = withFetch(() => {
    calls += 1;
    return calls === 1 ? new Response('{"message":"Bad credentials"}', { status: 401 }) : minted(2, Date.now() + 3600_000);
  });
  try {
    const auth = new GitHubAppAuth(config());
    await expect(auth.token()).rejects.toThrow("token exchange failed: 401");
    expect(await auth.token()).toBe("ghs_2");
  } finally {
    restore();
  }
});

test("server refuses to start with EX_CONFIG (78) on a missing or empty credential file", () => {
  const cases: Record<string, string>[] = [
    { GITHUB_WEBHOOK_SECRET_FILE: join(dir, "absent") },
    { GITHUB_WEBHOOK_SECRET_FILE: file("empty-hmac", "") },
    {
      GITHUB_WEBHOOK_SECRET_FILE: file("hmac", "x"),
      GITHUB_APP_CLIENT_ID: "Iv23x",
      GITHUB_APP_INSTALLATION_ID: "42",
      GITHUB_APP_PRIVATE_KEY_FILE: join(dir, "absent.pem"),
    },
    // A complete App with no webhook secret at all (no file, no env, no GitLab fallback).
    { GITHUB_APP_CLIENT_ID: "Iv23x", GITHUB_APP_INSTALLATION_ID: "42", GITHUB_APP_PRIVATE_KEY_FILE: keyFile },
  ];
  for (const extra of cases) {
    const run = Bun.spawnSync({
      cmd: [process.execPath, "run", join(import.meta.dir, "..", "src", "index.ts")],
      env: { PATH: process.env.PATH || "", LOG_LEVEL: "error", RATE_LIMITING_ENABLED: "false", PORT: "0", ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(78);
  }
});
