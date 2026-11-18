import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { logger } from "./logger";
import { ConfigError, readSecret } from "./secrets";

function apiBase(): string {
  return (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
}

const BASE_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
  "User-Agent": "ai-webhook",
};

// The GitHub lane authenticates as a GitHub App installation: the webhook's
// writes (repository_dispatch, the reaction) appear as <app>[bot], and no
// personal token is involved.
export interface GitHubAppConfig {
  clientId: string; // JWT issuer: the App's client ID (GitHub's recommendation; the numeric App ID also works)
  installationId: string;
  privateKey: KeyObject;
}

// Startup: the lane is configured when any App setting is present, and then
// every setting must be valid (ConfigError otherwise). Undefined = no GitHub
// lane on this server.
export function loadGitHubAppConfig(): GitHubAppConfig | undefined {
  const clientId = process.env.GITHUB_APP_CLIENT_ID || undefined;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID || undefined;
  const pem = readSecret("GITHUB_APP_PRIVATE_KEY", { multiline: true });
  if (!clientId && !installationId && !pem) return undefined;
  if (!clientId) throw new ConfigError("GITHUB_APP_CLIENT_ID is not set");
  if (!installationId || !/^[0-9]+$/.test(installationId)) {
    throw new ConfigError("GITHUB_APP_INSTALLATION_ID must be the numeric installation id");
  }
  if (!pem) throw new ConfigError("GITHUB_APP_PRIVATE_KEY_FILE (or GITHUB_APP_PRIVATE_KEY) is not set");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new ConfigError("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  }
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new ConfigError("GITHUB_APP_PRIVATE_KEY is not an RSA key (GitHub signs App JWTs with RS256)");
  }
  return { clientId, installationId, privateKey };
}

const JWT_BACKDATE_S = 60; // clock drift allowance (GitHub's recommendation)
const JWT_LIFETIME_S = 540; // exp at most 10 minutes ahead
const REFRESH_MARGIN_MS = 5 * 60_000; // renew before GitHub's expiry
const MAX_CACHE_MS = 55 * 60_000; // installation tokens last one hour

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

// Installation tokens (server-to-server) expire after one hour and have no
// refresh token: a new one is minted from a fresh App JWT.
export class GitHubAppAuth {
  private cached?: { token: string; renewAt: number };
  private pending?: Promise<string>;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly now: () => number = Date.now
  ) {}

  appJwt(): string {
    const nowS = Math.floor(this.now() / 1000);
    const unsigned =
      base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
      "." +
      base64url(JSON.stringify({ iat: nowS - JWT_BACKDATE_S, exp: nowS + JWT_LIFETIME_S, iss: this.config.clientId }));
    return `${unsigned}.${base64url(sign("sha256", Buffer.from(unsigned), this.config.privateKey))}`;
  }

  async token(): Promise<string> {
    if (this.cached && this.now() < this.cached.renewAt) return this.cached.token;
    // One exchange at a time: concurrent deliveries share it.
    if (!this.pending) {
      this.pending = this.mint().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  // Drop a token GitHub refused (revoked, or the installation changed).
  invalidate(token: string): void {
    if (this.cached?.token === token) this.cached = undefined;
  }

  private async mint(): Promise<string> {
    const url = `${apiBase()}/app/installations/${this.config.installationId}/access_tokens`;
    const response = await fetch(url, {
      method: "POST",
      headers: { ...BASE_HEADERS, Authorization: `Bearer ${this.appJwt()}` },
    });
    if (response.status !== 201) {
      const text = await response.text();
      logger.error("GitHub App token exchange failed", {
        status: response.status,
        body: text.slice(0, 300),
        installationId: this.config.installationId,
      });
      throw new Error(`GitHub App token exchange failed: ${response.status}`);
    }
    const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
    const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (typeof body.token !== "string" || !body.token || Number.isNaN(expiresAt)) {
      throw new Error("GitHub App token exchange returned no token or expiry");
    }
    const now = this.now();
    this.cached = { token: body.token, renewAt: Math.min(expiresAt - REFRESH_MARGIN_MS, now + MAX_CACHE_MS) };
    logger.debug("GitHub App installation token minted", { expiresAt: body.expires_at });
    return body.token;
  }
}

let appAuth: GitHubAppAuth | undefined;

export function configureGitHubApp(config: GitHubAppConfig | undefined): void {
  appAuth = config ? new GitHubAppAuth(config) : undefined;
}

// An authenticated GitHub API call as the App installation. A 401 drops the
// cached token and retries once with a new one (a refused request was not
// applied, so the retry cannot double it).
async function githubFetch(url: string, init: { method: string; body?: string }): Promise<Response> {
  if (!appAuth) throw new Error("GitHub App is not configured (GITHUB_APP_CLIENT_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_FILE)");
  const auth = appAuth;
  const call = async (): Promise<{ response: Response; token: string }> => {
    const token = await auth.token();
    const response = await fetch(url, { ...init, headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` } });
    return { response, token };
  };
  const first = await call();
  if (first.response.status !== 401) return first.response;
  auth.invalidate(first.token);
  logger.warn("GitHub refused the installation token; retrying once with a new one", { url });
  return (await call()).response;
}

export interface DispatchVariables {
  [key: string]: string;
}

// Trigger a repository_dispatch event; the consumer workflow filters on
// event.client_payload.trigger === "ai" and runs the ai-runner job.
export async function dispatchAgentRun(
  owner: string,
  repo: string,
  variables: DispatchVariables
): Promise<void> {
  const url = `${apiBase()}/repos/${owner}/${repo}/dispatches`;
  const eventType = process.env.GITHUB_DISPATCH_EVENT || "ai-agent";
  logger.debug("Dispatching GitHub agent run", { owner, repo, eventType });

  const response = await githubFetch(url, {
    method: "POST",
    body: JSON.stringify({ event_type: eventType, client_payload: { trigger: "ai", ...variables } }),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error("Agent dispatch failed", { status: response.status, body: text.slice(0, 500), owner, repo });
    throw new Error(`GitHub dispatch failed: ${response.status}`);
  }
  logger.info("Agent run dispatched", { owner, repo, eventType });
}

// Acknowledge with a reaction, never a comment: a comment makes the
// authenticated identity a thread participant and subscribes it to every
// later event.
export async function addReaction(params: {
  owner: string;
  repo: string;
  commentId: number;
  reviewComment?: boolean;
  emoji?: string;
}): Promise<void> {
  const { owner, repo, commentId } = params;
  const emoji = params.emoji || "+1";
  if (!commentId) return;
  const kind = params.reviewComment ? "pulls" : "issues";
  try {
    const res = await githubFetch(`${apiBase()}/repos/${owner}/${repo}/${kind}/comments/${commentId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ content: emoji }),
    });
    if (!res.ok) {
      logger.warn("Failed to add reaction", { status: res.status, owner, repo, commentId });
    }
  } catch (error) {
    logger.warn("Error adding reaction", { error: error instanceof Error ? error.message : error });
  }
}

export function sanitizeBranchName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}
