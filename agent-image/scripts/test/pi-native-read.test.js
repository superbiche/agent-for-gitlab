// The delivered-lines accounting against the installed Pi's own read tool. Like
// test/pi-path-rules.test.js it is a comparison with Pi, so REQUIRE_PI_DIST=1 turns an absent Pi into a failure.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { deliveredLines } from "../src/pi-events.js";
import { piDistOrRequire } from "../verification/pi-dist.js";

const { dist, skip: noPi } = piDistOrRequire();
async function nativeRead(file, params) {
  const { createReadToolDefinition } = await import(pathToFileURL(join(dist, "core/tools/read.js")).href);
  const tool = createReadToolDefinition(dirname(file));
  try { return { isError: false, result: await tool.execute("c", { path: file, ...params }, undefined, undefined, { cwd: dirname(file) }) }; }
  catch (error) { return { isError: true, result: { content: [{ type: "text", text: error.message }], details: {} } }; }
}
test("a read counts only for the lines it delivered, checked against the pinned native read tool", { skip: noPi }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-delivery-"));
  try {
    const file = join(root, "five.txt");
    writeFileSync(file, "l1\nl2\nl3\nl4\nl5");
    const range = (offset, limit) => ({ offset: offset ?? 1, limit: limit ?? null });
    const deliver = async (params) => deliveredLines(await nativeRead(file, params), file, range(params.offset, params.limit));
    assert.deepEqual(await deliver({}), { from: 1, to: 5, total: 5 });
    assert.deepEqual(await deliver({ limit: 2 }), { from: 1, to: 2, total: 5 }, "an ordinary partial read is partial, with its lines");
    assert.deepEqual(await deliver({ offset: 4 }), { from: 4, to: 5, total: 5 });
    assert.equal(await deliver({ limit: 0 }), null, "limit 0 succeeds with no source");
    assert.equal(await deliver({ offset: 99 }), null, "an error result delivers nothing");
    const missing = await nativeRead(join(root, "absent.txt"), {});
    assert.equal(missing.isError, true);
    assert.equal(deliveredLines(missing, file, range()), null);
    // First line over Pi's size limit: success, notice only.
    const wide = join(root, "wide.txt");
    writeFileSync(wide, "x".repeat(60 * 1024) + "\nsecond");
    const notice = await nativeRead(wide, {});
    assert.equal(notice.isError, false);
    assert.match(notice.result.content[0].text, /exceeds/);
    assert.equal(deliveredLines(notice, wide, range()), null, "a notice is not source");
    // Past Pi's line cap: truncated, partial coverage as Pi reports it.
    const long = join(root, "long.txt");
    writeFileSync(long, Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));
    const first = deliveredLines(await nativeRead(long, {}), long, range());
    assert.deepEqual(first, { from: 1, to: 2000, total: 2500 });
    // A forged result that does not match the file credits nothing.
    const forged = { isError: false, result: { content: [{ type: "text", text: "l1\nl2" }], details: {} } };
    assert.deepEqual(deliveredLines(forged, file, range(1, 2)), { from: 1, to: 2, total: 5 });
    assert.equal(deliveredLines({ ...forged, result: { content: [{ type: "text", text: "something else" }], details: {} } }, file, range(1, 2)), null);
    // An error result with the right text delivers nothing.
    assert.equal(deliveredLines({ isError: true, result: { content: [{ type: "text", text: "l1\nl2" }], details: {} } }, file, range(1, 2)), null);
    // An empty file has no content to deliver and is complete.
    const empty = join(root, "empty.txt"); writeFileSync(empty, "");
    assert.deepEqual(deliveredLines(await nativeRead(empty, {}), empty, range()), { from: 1, to: 0, total: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
