import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";

export function safeSourcePath(file) {
  return typeof file === "string" && file.length > 0 && !isAbsolute(file) && !file.split("/").some(p => p === ".." || p === "." || !p) && !/[?*\x00-\x1f\x7f\\]/.test(file);
}

// TruffleHog owns detection and exclusion regex semantics. Never expose its raw output.
export function scanSnapshot(root, config = "", { binary = "trufflehog", timeout = 180000 } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "native-scan-"));
  const output = join(temporary, "output"), errors = join(temporary, "errors");
  let out, err;
  try {
    mkdirSync(join(temporary, "home"));
    writeFileSync(join(temporary, "exclude-paths"), config, { mode: 0o600 });
    out = openSync(output, "w", 0o600); err = openSync(errors, "w", 0o600);
    const result = spawnSync(binary, ["filesystem", ".", "--no-verification", "--no-update", "--results=verified,unknown,unverified", "--fail", "--fail-on-scan-errors", "--json", "--no-color", "--concurrency=4", "--exclude-paths", join(temporary, "exclude-paths")], {
      cwd: root, timeout, stdio: ["ignore", out, err],
      env: { PATH: process.env.PATH, HOME: join(temporary, "home"), TMPDIR: temporary, LANG: "C.UTF-8" },
    });
    if (result.error || ![0, 183].includes(result.status)) throw new Error("TruffleHog unavailable, timed out, or failed; review blocked. Raw diagnostics suppressed.");
    if (statSync(output).size > 20 * 1024 * 1024) throw new Error("TruffleHog output exceeded its bound; review blocked.");
    const findings = [];
    try {
      for (const line of readFileSync(output, "utf8").split("\n").filter(l => l.trim())) {
        const item = JSON.parse(line), location = item?.SourceMetadata?.Data?.Filesystem;
        if (!location || typeof location.file !== "string" || typeof item.DetectorName !== "string" || !/^[A-Za-z0-9_. -]{1,100}$/.test(item.DetectorName) || !Number.isInteger(location.line) || location.line < 0) throw new Error();
        const file = relative(resolve(root), resolve(root, location.file));
        if (!safeSourcePath(file) || !statSync(join(root, file)).isFile()) throw new Error();
        findings.push({ file, line: location.line, detector: item.DetectorName });
      }
    } catch { throw new Error("TruffleHog output was invalid; review blocked. Raw diagnostics suppressed."); }
    if (result.status === 183 && !findings.length) throw new Error("TruffleHog reported findings without usable locations; review blocked.");
    return findings;
  } finally {
    if (out !== undefined) closeSync(out);
    if (err !== undefined) closeSync(err);
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function scanText(text, file, config = "", options) {
  return scanSegments(new Map([[file,text]]), config, options);
}
export function scanSegments(entries, config = "", options) {
  // A rename can replace file a with a/b. Preserve both native relative paths
  // in separate trees instead of failing to materialize conflicting old/new paths.
  const groups = [];
  for (const [file,text] of entries) {
    let group = groups.find(g => [...g.keys()].every(other => !file.startsWith(other + "/") && !other.startsWith(file + "/")));
    if (!group) { group = new Map(); groups.push(group); }
    group.set(file,text);
  }
  return groups.flatMap(group => scanSegmentGroup(group, config, options));
}
function scanSegmentGroup(entries, config, options) {
  const root = mkdtempSync(join(tmpdir(), "review-segment-"));
  try {
    for (const [file,text] of entries) {
      if (!safeSourcePath(file)) throw new Error("Unsupported review source path; review blocked.");
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), text, { mode: 0o600 });
    }
    return scanSnapshot(root, config, options);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export function refuseFindings(findings, surface = "source") {
  if (findings.length) throw new Error(`TruffleHog blocked external review (${surface}); no provider call made for this invocation. ${JSON.stringify(findings.slice(0, 20))}. Remove the credential or obtain an operator-approved .trufflehog-exclude-paths exception for a source fixture; discussion/history exceptions are not supported. No values displayed.`);
}
