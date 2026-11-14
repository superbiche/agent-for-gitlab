// Pi has no permission system: a tool runs with the process's rights. In risk
// review every denial OpenCode expressed as a permission rule is decided here,
// by image-owned code that the Pi process loads from an explicit extension path.
// This module is pure (no Pi import) so the policy is testable without Pi and the
// same function runs inside the real process (pi-extension.js).
import { realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, basename, join, resolve, isAbsolute } from "node:path";

// The complete tool surface of a risk review. Anything not named here is denied,
// whatever Pi or an extension adds later (deny by default, not a list of bans).
export const RISK_TOOLS = Object.freeze(["read", "write", "glob", "source_search", "public_fetch", "dependency_read"]);

// Variables Pi, Node and the launching shell add to the process themselves (observed, Pi 1.5.2).
// Anything else the process holds beyond what the runner passed is reported by the extension and refused.
export const PI_ENV_EXTRAS = Object.freeze(["AI_AGENT", "NODE_PATH", "PI_CODING_AGENT", "PWD", "OLDPWD", "SHLVL", "_"]);

// The only files the model may write, as in the OpenCode permission rule.
export const RISK_OUTPUTS = Object.freeze(["/tmp/review-findings.json", "/tmp/review-scores.json"]);

// Validated read range: positive integers or absent. A zero limit would succeed and deliver nothing.
function readRange(input) {
  const ok = value => value === undefined || (Number.isInteger(value) && value >= 1);
  return ok(input.offset) && ok(input.limit) ? { offset: input.offset ?? 1, limit: input.limit ?? null } : null;
}

const keysWithin = (input, allowed) => input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every(key => allowed.includes(key));

// --- the path Pi really opens ---------------------------------------------------------
// Pi 1.5.2's native tools do not open the argument they are given (dist/core/tools/path-utils.js
// `resolveToCwd` / `resolveReadPath`, dist/utils/paths.js `normalizePath`): a leading "@" is
// stripped, the Unicode space characters become a plain space, "~" and "~/" become the home
// directory, a file:// URL becomes its path, and a relative path is resolved against the working
// directory, which is normalised by a DIFFERENT rule (no "@", no Unicode-space replacement). `read`
// then tries up to four more spellings of the resolved path when the first does not exist.
// A guard that judged the raw argument approved one file while Pi opened its excluded twin (a name
// differing by one Unicode space). So the rules are reproduced here, every spelling Pi would
// rewrite is refused (the review has no reason to write one), and the path Pi opens is judged.
// test/pi-path-rules.test.js feeds a table of spellings and base directories to these functions
// and to the installed Pi's own and requires the same answers: a Pi bump that changes a rule fails.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
export const piNormalize = (input, { spaces = true, strip = true } = {}) => {
  let n = spaces ? String(input).replace(UNICODE_SPACES, " ") : String(input);
  if (strip && n.startsWith("@")) n = n.slice(1);
  if (n === "~") return homedir();
  if (n.startsWith("~/")) return join(homedir(), n.slice(2));
  if (/^file:\/\//.test(n)) return fileURLToPath(n);
  return n;
};
export const piNormalizeBase = cwd => piNormalize(cwd, { spaces: false, strip: false });
export const piResolve = (input, cwd) => {
  const n = piNormalize(input);
  return isAbsolute(n) ? resolve(n) : resolve(piNormalizeBase(cwd), n);
};
export const piReadCandidates = resolved => {
  const curly = x => x.replace(/'/g, "\u2019");
  const nfd = resolved.normalize("NFD");
  return [...new Set([resolved, resolved.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, curly(resolved), curly(nfd)])];
};
// A spelling Pi would change before using it.
export const piRewrites = input => piNormalize(input) !== String(input);

function canonical(workdir, raw) {
  if (typeof raw !== "string" || !raw || raw.includes("\0") || piRewrites(raw)) return null;
  try { return piResolve(raw, workdir); } catch { return null; }
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
    const range = readRange(input);
    if (!range) return { allow: false, reason: "Read offset and limit must be positive integers." };
    const path = canonical(policy.workdir, input.path);
    if (!path) return { allow: false, reason: "Read path is empty, malformed or spelled in a way Pi rewrites (leading @, ~, file:// or Unicode spaces)." };
    // An inventory entry that is a link to somewhere else is not an approved file.
    const root = real(policy.repo);
    const permitted = new Set(policy.allowed.map(file => ({ file, target: real(join(policy.repo, file)) })).filter(({ file, target }) => root && target === join(root, file)).map(({ target }) => target));
    for (const file of outputs) {
      // The review may read back its own output, but a link planted at that path grants nothing.
      const parent = real(dirname(file)), output = real(file);
      if (parent && output === join(parent, basename(file))) permitted.add(output);
    }
    // Every spelling `read` may open must be approved: it opens the first that exists.
    const candidates = piReadCandidates(path).filter(candidate => existsSync(candidate));
    const opened = candidates.length ? candidates : [path];
    const targets = opened.map(real);
    if (targets.some(target => !target || !permitted.has(target))) return { allow: false, reason: "Read is outside the approved source inventory." };
    const target = targets[0];
    // The call executes the canonical path; Pi must not rewrite THAT into another file.
    if (piRewrites(target) || piResolve(target, policy.workdir) !== target) return { allow: false, reason: "This file's name cannot be addressed without Pi rewriting it; it is not readable." };
    return { allow: true, input: { ...input, path: target }, effective: target, range };
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
