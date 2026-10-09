import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureModelKnown } from "../src/opencode.js";

// Fake CLI: the bundled list lacks gpt-6-luna until `--refresh` runs once.
function fakeOpencode() {
  const dir = mkdtempSync(join(tmpdir(), "fake-opencode-"));
  writeFileSync(join(dir, "opencode"), `#!/bin/sh
case "$*" in *--refresh*) touch "${dir}/refreshed";; esac
echo openrouter/openai/gpt-5.6-luna
[ -f "${dir}/refreshed" ] && echo openrouter/openai/gpt-6-luna
exit 0
`);
  chmodSync(join(dir, "opencode"), 0o755);
  return dir;
}

test("refreshes the registry once when the model is missing", () => {
  const dir = fakeOpencode();
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    ensureModelKnown("openrouter/openai/gpt-5.6-luna");
    assert.equal(existsSync(join(dir, "refreshed")), false);
    ensureModelKnown("openrouter/openai/gpt-6-luna");
    assert.equal(existsSync(join(dir, "refreshed")), true);
    assert.throws(() => ensureModelKnown("openrouter/openai/gpt-404"), /does not know model openrouter\/openai\/gpt-404/);
  } finally { process.env.PATH = path; }
});
