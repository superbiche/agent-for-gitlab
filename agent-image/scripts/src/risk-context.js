import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

// Infrastructure repos can store Secret documents in innocently named all.yaml.
// Do not rely on the model or filename alone to keep that material out of prompts.
export function credentialMaterial(text = "") {
  const plain = String(text).replace(/^[+-]/gm, "");
  if (/^\s*kind:\s*["']?Secret["']?\s*(?:#.*)?$/m.test(plain)) return true;
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(String(text))) return true;
  if (/\b(?:glpat-[A-Za-z0-9_-]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/.test(plain)) return true;
  return Object.entries(process.env).some(([key, value]) => /TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY/.test(key) && value?.length >= 8 && plain.includes(value));
}

export function riskSourcePolicy(repo = process.cwd()) {
  const entries = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: repo, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }).split("\0").filter(Boolean);
  const allowed = [], excluded = [];
  for (const entry of entries) {
    const file = entry.slice(entry.indexOf("\t") + 1);
    const absolute = resolve(repo, file);
    const mode = entry.slice(0, 6);
    if (/[?*\x00-\x1f]/.test(file) || (mode !== "100644" && mode !== "100755")) { excluded.push(file); continue; }
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > 1024 * 1024 || /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$)|secret|credential|password|\.(?:pem|key|p12|pfx)$/i.test(file) || credentialMaterial(readFileSync(absolute, "utf8"))) {
      excluded.push(file); continue;
    }
    allowed.push(file);
  }
  return { allowed, excluded };
}

export function validateRiskContext(data, policy) {
  for (const diff of data.diffs) {
    if (policy.excluded.includes(diff.new_path) || policy.excluded.includes(diff.old_path) || credentialMaterial(diff.diff)) throw new Error("Review includes excluded or credential-bearing files; use a local review for this change.");
  }
  if (credentialMaterial(data.mr.title) || credentialMaterial(data.mr.description) || data.notes.some(n => credentialMaterial(n.body))) throw new Error("MR discussion contains credential-bearing material; external review refused.");
}
