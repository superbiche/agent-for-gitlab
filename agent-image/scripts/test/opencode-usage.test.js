import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpencode } from "../src/opencode.js";
import { summarizeUsage } from "../src/usage.js";

// Fake CLI: lists the model, then one paid step followed by the given exit status.
function fakeOpencode(exitStatus) {
  const dir = mkdtempSync(join(tmpdir(), "fake-opencode-run-"));
  writeFileSync(join(dir, "opencode"), `#!/bin/sh
if [ "$1" = models ]; then echo anthropic/claude-sonnet-5-5; exit 0; fi
cat >/dev/null
echo '{"type":"text","part":{"type":"text","text":"partial"}}'
echo '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","cost":0.125,"tokens":{"input":100,"output":20,"reasoning":0,"cache":{"read":30,"write":10}}}}'
exit ${exitStatus}
`);
  chmodSync(join(dir, "opencode"), 0o755);
  return dir;
}

async function run(exitStatus) {
  const path = process.env.PATH;
  process.env.PATH = `${fakeOpencode(exitStatus)}:${path}`;
  const context = { opencodeModel: "anthropic/claude-sonnet-5-5", reviewProfile: "standard", agentPrompt: "", usage: [] };
  try {
    const output = await runOpencode(context, "x", { captureOutput: true, label: "findings" }).catch((error) => error);
    return { context, output };
  } finally { process.env.PATH = path; }
}

test("a failed CLI call still records the steps it completed", async () => {
  const { context, output } = await run(1);
  assert.match(output.message, /opencode CLI failed/);
  const { total, calls } = summarizeUsage(context.usage);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].complete, false);
  assert.deepEqual([total.cost, total.input, total.output, total.cache_read, total.cache_write, total.complete], [0.125, 100, 20, 30, 10, false]);
});

test("a successful CLI call returns text and complete usage", async () => {
  const { context, output } = await run(0);
  assert.equal(output, "partial");
  assert.equal(context.usage[0].complete, true);
  assert.equal(summarizeUsage(context.usage).total.complete, true);
});
