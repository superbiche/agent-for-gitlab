import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { investigationTools } from "../src/investigation.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "investigation-test-"));
  writeFileSync(join(root, "safe.js"), "legacy_symbol();\n".repeat(105));
  writeFileSync(join(root, "denied.js"), "legacy_symbol(secret);\n");
  writeFileSync(join(root, "composer.lock"), JSON.stringify({ packages: [{ name: "spatie/laravel-health", version: "1.34.0", source: { url: "https://github.com/spatie/laravel-health.git", reference: "a".repeat(40) } }] }));
  return { root, repo: root, allowed: ["safe.js", "composer.lock"], dispose: () => rmSync(root, { recursive: true, force: true }) };
}
test("source search respects the exact inventory and reports pagination and null scope", () => {
  const p = fixture();
  try {
    const tools = investigationTools(p, join(p.root, "evidence"));
    const first = JSON.parse(tools.search({ text: "legacy_symbol" }));
    assert.equal(first.matches.length, 100); assert.equal(first.truncated, true);
    assert(first.matches.every(m => m.file === "safe.js"));
    const rest = JSON.parse(tools.search({ text: "legacy_symbol", offset: first.next_offset }));
    assert.equal(rest.matches.length, 5); assert.equal(rest.truncated, false);
    assert.equal(JSON.parse(tools.search({ text: "secret" })).matches.length, 0);
    assert.equal(JSON.parse(tools.search({ text: "legacy_symbol", path: "../" })).files_scanned, 0);
    assert.throws(() => tools.search({ text: "x", offset: -1 }));
    assert.equal(readFileSync(join(p.root, "evidence"), "utf8").split("\n").filter(Boolean).length, 4);
  } finally { p.dispose(); }
});
test("public evidence is scanned before exposure, hashed and bound to the final URL", async () => {
  const p = fixture();
  try {
    const scanned = [];
    const tools = investigationTools(p, join(p.root, "evidence"), { fetchText: async () => ({ url: "https://docs.example/final", text: "contract", contentType: "text/plain" }), scan: (text, file) => { scanned.push(file); return []; } });
    const result = JSON.parse(await tools.fetch({ url: "https://docs.example/start" }));
    assert.deepEqual(scanned, ["request.txt", "response-url.txt", "external.txt"]);
    assert.match(result.sha256, /^[a-f0-9]{64}$/); assert.equal(result.url, "https://docs.example/final");
    const blocked = investigationTools(p, join(p.root, "evidence"), { scan: () => [{}], fetchText: () => { throw new Error("must not fetch"); } });
    await assert.rejects(blocked.fetch({ url: "https://docs.example" }), /TruffleHog/);
    const poisoned = investigationTools(p, join(p.root, "evidence"), { scan: (text, file) => file === "external.txt" ? [{}] : [], fetchText: async () => ({ url: "https://docs.example", text: "private", contentType: "text/plain" }) });
    await assert.rejects(poisoned.fetch({ url: "https://docs.example" }), /TruffleHog/);
  } finally { p.dispose(); }
});
test("dependency reads use the reviewed lock commit and reject traversal or unsupported packages", async () => {
  const p = fixture();
  try {
    let fetched;
    const tools = investigationTools(p, join(p.root, "evidence"), { fetchText: async url => { fetched = url; return { url, text: "source", contentType: "text/plain" }; }, scan: () => [] });
    const result = JSON.parse(await tools.dependency({ name: "spatie/laravel-health", file: "src/Health.php" }));
    assert.equal(fetched, `https://raw.githubusercontent.com/spatie/laravel-health/${"a".repeat(40)}/src/Health.php`);
    assert.equal(result.reference, "a".repeat(40));
    await assert.rejects(tools.dependency({ name: "spatie/laravel-health", file: "../secret" }));
    await assert.rejects(tools.dependency({ name: "unknown", file: "index.js" }));
  } finally { p.dispose(); }
});
