import test from "node:test";
import assert from "node:assert/strict";
import { compressDiffs, stripDeletionOnlyHunks, changedLineCount, estimateTokens } from "../src/diff-compression.js";
import { selectReviewModel, buildPrompt } from "../src/review.js";

const patch = (lines, start = 1) => `@@ -${start},${lines} +${start},${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line ${i} ${"x".repeat(40)}`).join("\n")}\n`;
const file = (path, diff, extra = {}) => ({ old_path: path, new_path: path, renamed_file: false, deleted_file: false, diff, ...extra });

test("small diffs pass through untouched", () => {
  const diffs = [file("a.js", patch(3)), file("gone.js", "@@ -1 +0,0 @@\n-x\n", { deleted_file: true })];
  const result = compressDiffs(diffs, { maxTokens: 10000 });
  assert.equal(result.compression, null);
  assert.equal(result.diffs, diffs);
});

test("strips deletion-only hunks and keeps mixed hunks", () => {
  const input = "@@ -1,2 +1,1 @@\n-a\n-b\n@@ -10,2 +9,2 @@\n-c\n+d\n e\n@@ -20,1 +19,1 @@\n f\n";
  assert.equal(stripDeletionOnlyHunks(input), "@@ -10,2 +9,2 @@\n-c\n+d\n e\n@@ -20,1 +19,1 @@\n f\n");
  assert.equal(stripDeletionOnlyHunks("@@ -1,2 +0,0 @@\n-a\n-b\n"), "");
});

test("large diffs list deleted, binary and overflow files by name", () => {
  const diffs = [
    file("src/big.js", patch(200)),
    file("src/small.js", patch(5)),
    file("src/other.js", patch(5)),
    file("README.md", patch(5)),
    file("logo.png", ""),
    file("old.js", patch(50), { deleted_file: true }),
  ];
  const { diffs: kept, compression } = compressDiffs(diffs, { maxTokens: 1000 });
  assert.deepEqual(kept.map((d) => d.new_path), ["src/other.js", "src/small.js", "README.md"]);
  assert.deepEqual(compression.other_modified_files, ["src/big.js"]);
  assert.deepEqual(compression.deleted_files, ["old.js"]);
  assert.deepEqual(compression.skipped_files, ["logo.png"]);
  assert.equal(compression.included_files, 3);
  assert.ok(compression.estimated_tokens_after <= 1000);
});

test("prioritizes the most common extension, largest patch first", () => {
  const diffs = [file("x.md", patch(4)), file("a.py", patch(2)), file("b.py", patch(6)), file("pad.bin.txt", patch(400))];
  const { diffs: kept } = compressDiffs(diffs, { maxTokens: 800 });
  assert.deepEqual(kept.map((d) => d.new_path), ["b.py", "a.py", "x.md"]);
});

test("name lists stop at the hard budget and count omissions", () => {
  const diffs = Array.from({ length: 50 }, (_, i) => file(`src/very/long/path/to/file-${i}.js`, patch(40)));
  const { compression } = compressDiffs(diffs, { maxTokens: 700 });
  assert.ok(compression.omitted_file_count > 0);
  assert.ok(compression.estimated_tokens_after <= 700);
});

test("prompt carries compressed diffs and compression metadata", () => {
  const reviewData = { mr: {}, notes: [], diffs: [file("a.js", patch(1))], promptDiffs: [], diffCompression: { included_files: 0 } };
  const prompt = buildPrompt("find.md", { reviewProfile: "standard", reviewMode: "strict" }, reviewData, {});
  const json = JSON.parse(prompt.slice(prompt.indexOf("{", prompt.indexOf("## Runner-provided GitLab context"))));
  assert.deepEqual(json.diffs, []);
  assert.deepEqual(json.diff_compression, { included_files: 0 });
});

test("changedLineCount counts added and removed lines", () => {
  assert.equal(changedLineCount([file("a.js", "@@ -1,2 +1,2 @@\n-a\n+b\n c\n")]), 2);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

const routing = { opencodeModel: "deepseek/big", reviewProfile: "standard", reviewSmallModel: "openrouter/openai/small", reviewSmallMaxLines: 10, reviewSmallMaxFiles: 2 };

test("routes small MRs to REVIEW_SMALL_MODEL", () => {
  assert.equal(selectReviewModel(routing, { diffs: [file("a.js", patch(3))] }).opencodeModel, "openrouter/openai/small");
});

test("keeps the default model for large MRs, risk reviews and unset routing", () => {
  assert.equal(selectReviewModel(routing, { diffs: [file("a.js", patch(11))] }).opencodeModel, "deepseek/big");
  assert.equal(selectReviewModel(routing, { diffs: [file("a", "+x"), file("b", "+x"), file("c", "+x")] }).opencodeModel, "deepseek/big");
  assert.equal(selectReviewModel({ ...routing, reviewProfile: "risk" }, { diffs: [] }).opencodeModel, "deepseek/big");
  assert.equal(selectReviewModel({ ...routing, reviewSmallModel: "" }, { diffs: [] }).opencodeModel, "deepseek/big");
  assert.equal(selectReviewModel({ ...routing, reviewSmallModel: "nomodel" }, { diffs: [] }).opencodeModel, "deepseek/big");
});
