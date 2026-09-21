import logger from "../logger.js";

// Shared transport for the platform adapters (platforms/gitlab.js,
// platforms/github.js). Two jobs:
//
// 1. Retry once on network-level failures (fetch itself throws: DNS, TCP
//    reset, TLS, timeout). HTTP error statuses are NOT retried — a POST that
//    reached the server may already have taken effect, and replaying it can
//    double-post inline notes. Even a network throw after the server
//    processed the request can duplicate, but a single retry is the pragmatic
//    middle ground versus failing the whole review after a ~15-minute LLM run.
// 2. Preserve the undici error cause chain in messages. Node's fetch throws a
//    bare `TypeError: fetch failed` with the real reason (ECONNREFUSED,
//    ENOTFOUND, certificate, timeout) nested under `.cause`; logging only
//    `error.message` discards the diagnosis, as one StudioNet outage showed.

const RETRY_DELAY_MS = 2000;
const MAX_CAUSE_DEPTH = 5;
const MAX_SUMMARY_CHARS = 500;

function redactSecrets(text) {
  return String(text)
    .replace(/glpat-[A-Za-z0-9_-]+/g, "glpat-****")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_****")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "gh****")
    .replace(/(PRIVATE-TOKEN|Authorization)(["'\s:]+(?:Bearer\s+)?)[^\s,}"]+/gi, "$1$2****");
}

// One-line, secret-free summary of an error plus its `.cause` chain.
// Safe to log and to surface in the operator-facing error note.
export function causeSummary(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current instanceof Error && !seen.has(current) && parts.length < MAX_CAUSE_DEPTH) {
    seen.add(current);
    const bits = [];
    if (current.name && current.name !== "Error") bits.push(current.name);
    const message = (current.message || "").trim();
    if (current.code && !message.includes(String(current.code))) bits.push(`code=${current.code}`);
    if (message) bits.push(message);
    if (bits.length) parts.push(bits.join(" "));
    current = current.cause;
  }
  if (!parts.length) return String(error?.message ?? error ?? "unknown error").slice(0, MAX_SUMMARY_CHARS);
  return redactSecrets(parts.join(" <- caused by ")).slice(0, MAX_SUMMARY_CHARS);
}

export async function fetchWithRetry(url, init, options = {}) {
  const { label = "API request", attempts = 2, delayMs = RETRY_DELAY_MS } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      logger.warn(`${label} network failure (attempt ${attempt}/${attempts}): ${causeSummary(error)}`);
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(`${label} network failure after ${attempts} attempts: ${causeSummary(lastError)}`, {
    cause: lastError,
  });
}
