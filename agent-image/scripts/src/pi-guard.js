// Pi has no permission system: a tool runs with the process's rights. In risk
// review every denial OpenCode expressed as a permission rule is decided here,
// by image-owned code that the Pi process loads from an explicit extension path.
// This module is pure (no Pi import) so the policy is testable without Pi and the
// same function runs inside the real process (pi-extension.js).
import { realpathSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";

// The complete tool surface of a risk review. Anything not named here is denied,
// whatever Pi or an extension adds later (deny by default, not a list of bans).
export const RISK_TOOLS = Object.freeze(["read", "write", "glob", "source_search", "public_fetch", "dependency_read"]);

// The only files the model may write, as in the OpenCode permission rule.
export const RISK_OUTPUTS = Object.freeze(["/tmp/review-findings.json", "/tmp/review-scores.json"]);

const keysWithin = (input, allowed) => input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every(key => allowed.includes(key));

function canonical(workdir, raw) {
  // Pi expands "~" and strips a leading "@" itself. That cannot diverge from this check:
  // the guard resolves the path against the work directory and the call then executes the
  // resulting absolute path (see `input` below), so Pi never sees a spelling of its own.
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return null;
  return resolve(workdir, raw);
}

function real(path) {
  try { return realpathSync(path); } catch { return null; }
}

// policy: { repo, allowed: [relative files], workdir, tools?, outputs? }
// Returns { allow: true, input, effective } or { allow: false, reason }.
// `input` is the canonical argument set Pi must execute (the caller mutates the call
// with it), so the path checked is the path opened, whatever the model wrote.
export function decideToolCall(policy, { toolName, input }) {
  const tools = policy.tools || RISK_TOOLS;
  const outputs = policy.outputs || RISK_OUTPUTS;
  if (!tools.includes(toolName)) return { allow: false, reason: `Tool ${JSON.stringify(toolName)} is not available in risk review.` };
  if (toolName === "read") {
    if (!keysWithin(input, ["path", "offset", "limit"])) return { allow: false, reason: "Unsupported read arguments." };
    const path = canonical(policy.workdir, input.path);
    const target = path && real(path);
    // An inventory entry that is a link to somewhere else is not an approved file.
    const root = real(policy.repo);
    const permitted = new Set(policy.allowed.map(file => ({ file, target: real(join(policy.repo, file)) })).filter(({ file, target }) => root && target === join(root, file)).map(({ target }) => target));
    for (const file of outputs) {
      // The review may read back its own output, but a link planted at that path grants nothing.
      const parent = real(dirname(file)), output = real(file);
      if (parent && output === join(parent, basename(file))) permitted.add(output);
    }
    if (!target || !permitted.has(target)) return { allow: false, reason: "Read is outside the approved source inventory." };
    return { allow: true, input: { ...input, path: target }, effective: target };
  }
  if (toolName === "write") {
    if (!keysWithin(input, ["path", "content"])) return { allow: false, reason: "Unsupported write arguments." };
    const path = canonical(policy.workdir, input.path);
    if (!path || !outputs.includes(path)) return { allow: false, reason: "Write is limited to the two review output files." };
    const parent = real(dirname(path));
    const existing = real(path);
    // A planted link at the output path must not redirect the write elsewhere.
    if (!parent || (existing && existing !== join(parent, basename(path)))) return { allow: false, reason: "Review output path is not a plain file in its directory." };
    return { allow: true, input: { ...input, path }, effective: path };
  }
  return { allow: true, input, effective: null };
}

// Filename discovery over the approved inventory only. Pi's builtin `find` shells out
// to an fd binary and can walk anywhere; this tool cannot name a file the review is not
// allowed to read. A pattern without "/" matches the basename at any depth.
export function globInventory(allowed, pattern, limit = 1000) {
  if (typeof pattern !== "string" || !pattern.length || pattern.length > 300) throw new Error("Provide a glob pattern of up to 300 characters.");
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/|\*\*|\*|\?/g, token => token === "**/" ? "(?:.*/)?" : token === "**" ? ".*" : token === "*" ? "[^/]*" : "[^/]");
  const expression = new RegExp(`^${source}$`);
  const slashless = !pattern.includes("/");
  const matches = allowed.filter(file => expression.test(slashless ? file.split("/").at(-1) : file));
  return { matches: matches.slice(0, limit), truncated: matches.length > limit };
}
