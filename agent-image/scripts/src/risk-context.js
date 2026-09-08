import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSnapshot, scanSegments, safeSourcePath, refuseFindings } from "./native-secret-scan.js";

export function riskSourcePolicy(repo = process.cwd(), scannerOptions) {
  const git = args => execFileSync("git", args, { cwd: repo, maxBuffer: 20 * 1024 * 1024 });
  const entries = git(["ls-tree", "-rlz", "HEAD"]).toString("utf8").split("\0").filter(Boolean).map(entry => {
    const tab = entry.indexOf("\t");
    const metadata = entry.slice(0,tab), file = entry.slice(tab+1);
    const [mode, type, oid, size] = metadata.trim().split(/\s+/);
    return { mode, type, oid, size: Number(size), file };
  });
  const configEntry = entries.find(e => e.file === ".trufflehog-exclude-paths");
  if (configEntry && (!["100644", "100755"].includes(configEntry.mode) || configEntry.size > 1024 * 1024)) throw new Error("TruffleHog configuration must be a bounded tracked regular file.");
  const config = configEntry ? git(["cat-file", "blob", configEntry.oid]) : Buffer.alloc(0);
  const root = mkdtempSync(join(tmpdir(), "review-source-"));
  const allowed = [], excluded = [];
  try {
    for (const entry of entries) {
      const {file, mode, size, oid} = entry;
      if (!safeSourcePath(file) || !["100644", "100755"].includes(mode) || size > 1024 * 1024) { excluded.push(file); continue; }
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), git(["cat-file", "blob", oid]), { mode: 0o400 });
      allowed.push(file);
    }
    const findings = scanSnapshot(root, config, scannerOptions);
    const detected = new Set(findings.map(f => f.file));
    return { repo: root, originalRepo: repo, config, allowed: allowed.filter(f => !detected.has(f)), excluded: [...new Set([...excluded, ...detected])], findings, dispose: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

export function validateRiskContext(data, policy) {
  for (const diff of data.diffs) {
    if ([diff.a_mode,diff.b_mode].filter(Boolean).some(mode => !["100644","100755","000000","0"].includes(mode)) || ![diff.new_path, diff.old_path].filter(Boolean).every(safeSourcePath) || policy.excluded.includes(diff.new_path) || policy.excluded.includes(diff.old_path)) {
      const paths = [diff.old_path,diff.new_path].filter(Boolean);
      refuseFindings((policy.findings || []).filter(f => paths.includes(f.file)), "changed source");
      throw new Error(`Changed source is structurally excluded; external review blocked: ${JSON.stringify(paths)}. Use local review for unsupported file modes, sizes or paths.`);
    }
  }
}

// The bundle owns both transmitted bytes and scan provenance. A repository exception
// applies only to a source segment, never to discussion, focus, history or model text.
export function promptBundle(parts) {
  return Object.freeze({ parts: Object.freeze(parts.map(part => Object.freeze({ ...part, raw: Object.freeze([...(part.raw || [])]) }))) });
}
export function validatePromptBundle(bundle, policy, scannerOptions) {
  if (!bundle || !Array.isArray(bundle.parts)) throw new Error("Risk invocation requires a typed prompt bundle.");
  const source = new Map(), prompt = [];
  for (const part of bundle.parts) {
    if (typeof part.text !== "string" || !["source", "prompt"].includes(part.kind)) throw new Error("Invalid risk prompt segment.");
    const paths = part.kind === "source" ? part.paths : ["prompt.txt"];
    if (!Array.isArray(paths) || !paths.length) throw new Error("Missing risk source provenance.");
    for (const file of paths) {
      if (part.kind === "source" && policy.excluded.includes(file)) throw new Error("Changed source is excluded; external review blocked.");
      const text = [part.text, ...part.raw].join("\n");
      if (part.kind === "source") source.set(file, (source.get(file) || "") + "\n" + text);
      else prompt.push(text);
    }
  }
  refuseFindings(scanSegments(new Map([["prompt.txt", prompt.join("\n")]]), "", scannerOptions), "prompt");
  if (source.size) refuseFindings(scanSegments(source, policy.config, scannerOptions), "source");
  return bundle.parts.map(part => part.text).join("");
}
