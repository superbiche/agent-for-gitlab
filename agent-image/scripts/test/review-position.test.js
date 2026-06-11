import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDiffPosition } from "../src/review.js";

const fixtureDir = new URL("./fixtures/", import.meta.url);
const diffs = JSON.parse(readFileSync(join(fixtureDir.pathname, "diffs.json"), "utf8"));
const mr = JSON.parse(readFileSync(join(fixtureDir.pathname, "mr.json"), "utf8"));
const diffRefs = mr.diff_refs;

test("maps an added line to new_line", () => {
  const position = buildDiffPosition(diffs, { file: "src/example.js", line_start: 9 }, diffRefs);
  assert.equal(position.new_path, "src/example.js");
  assert.equal(position.old_path, "src/example.js");
  assert.equal(position.new_line, 9);
  assert.equal(position.old_line, undefined);
});

test("maps a context line to old_line and new_line", () => {
  const position = buildDiffPosition(diffs, { file: "src/example.js", line_start: 10 }, diffRefs);
  assert.equal(position.old_line, 9);
  assert.equal(position.new_line, 10);
});

test("maps renamed files using old and new paths", () => {
  const position = buildDiffPosition(diffs, { file: "src/new-name.js", line_start: 2 }, diffRefs);
  assert.equal(position.old_path, "src/old-name.js");
  assert.equal(position.new_path, "src/new-name.js");
  assert.equal(position.new_line, 2);
});

test("maps deleted lines to old_line", () => {
  const position = buildDiffPosition(diffs, { file: "src/deleted.js", line_start: 4, old_line: 4 }, diffRefs);
  assert.equal(position.old_line, 4);
  assert.equal(position.new_line, undefined);
});

test("returns null when required diff refs are absent", () => {
  const position = buildDiffPosition(diffs, { file: "src/example.js", line_start: 9 }, {});
  assert.equal(position, null);
});
