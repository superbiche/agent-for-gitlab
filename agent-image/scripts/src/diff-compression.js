// Token-aware diff fitting for review prompts, after PR-Agent's compression strategy:
// https://docs.pr-agent.ai/core-abilities/compression_strategy/
// Small diffs pass through untouched. Large diffs drop deleted files and
// deletion-only hunks to name lists, then fit patches by language priority.

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svgz", "tif", "tiff", "psd",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi", "webm", "wav", "ogg",
  "exe", "dll", "so", "dylib", "bin", "class", "pyc", "o", "a", "wasm",
]);

export const DEFAULT_MAX_DIFF_TOKENS = 64000;
const SOFT_BUFFER_RATIO = 0.1;

export function estimateTokens(text = "") {
  return Math.ceil(String(text).length / 4);
}

export function compressDiffs(diffs = [], { maxTokens = DEFAULT_MAX_DIFF_TOKENS } = {}) {
  const totalTokens = diffs.reduce((sum, d) => sum + estimateTokens(d.diff), 0);
  if (totalTokens <= maxTokens) return { diffs, compression: null };

  const deleted = [];
  const skipped = [];
  const candidates = [];
  for (const diff of diffs) {
    const path = diff.new_path || diff.old_path;
    if (diff.deleted_file) { deleted.push(path); continue; }
    if (!diff.diff || BINARY_EXTENSIONS.has(extensionOf(path))) { skipped.push(path); continue; }
    const patch = stripDeletionOnlyHunks(diff.diff);
    candidates.push({ diff: { ...diff, diff: patch }, path, tokens: estimateTokens(patch) });
  }

  const softLimit = Math.floor(maxTokens * (1 - SOFT_BUFFER_RATIO));
  const kept = [];
  const overflow = [];
  let used = 0;
  for (const item of prioritize(candidates)) {
    if (item.tokens && used + item.tokens <= softLimit) {
      kept.push(item.diff);
      used += item.tokens;
    } else {
      overflow.push(item.path);
    }
  }

  // Name lists fill the remaining budget up to the hard stop.
  let omitted = 0;
  const listNames = (paths) => paths.filter((path) => {
    const cost = estimateTokens(path) + 1;
    if (used + cost > maxTokens) { omitted += 1; return false; }
    used += cost;
    return true;
  });
  const otherModified = listNames(overflow);
  const deletedFiles = listNames(deleted);

  return {
    diffs: kept,
    compression: {
      budget_tokens: maxTokens,
      estimated_tokens_before: totalTokens,
      estimated_tokens_after: used,
      included_files: kept.length,
      other_modified_files: otherModified,
      deleted_files: deletedFiles,
      skipped_files: skipped,
      omitted_file_count: omitted,
    },
  };
}

// Removes hunks that only delete lines; returns "" when nothing else remains.
export function stripDeletionOnlyHunks(patch = "") {
  const hunks = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@") || !hunks.length) hunks.push([line]);
    else hunks[hunks.length - 1].push(line);
  }
  return hunks
    .filter((hunk) => !hunk[0].startsWith("@@") || hunk.some((line) => line.startsWith("+")) || !hunk.some((line) => line.startsWith("-")))
    .map((hunk) => hunk.join("\n"))
    .join("\n")
    .replace(/^\n+$/, "");
}

// Most common extension in the MR first; largest patches first within a language.
function prioritize(candidates) {
  const counts = new Map();
  for (const item of candidates) counts.set(extensionOf(item.path), (counts.get(extensionOf(item.path)) || 0) + 1);
  return [...candidates].sort((a, b) =>
    (counts.get(extensionOf(b.path)) - counts.get(extensionOf(a.path)))
    || extensionOf(a.path).localeCompare(extensionOf(b.path))
    || (b.tokens - a.tokens)
    || a.path.localeCompare(b.path));
}

function extensionOf(path = "") {
  const name = path.split("/").pop();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function changedLineCount(diffs = []) {
  let count = 0;
  for (const diff of diffs) {
    for (const line of String(diff.diff || "").split("\n")) {
      if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) count += 1;
    }
  }
  return count;
}
