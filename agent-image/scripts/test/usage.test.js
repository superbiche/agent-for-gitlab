import test from "node:test";
import assert from "node:assert/strict";
import { parseUsage, parseText, recordUsage, summarizeUsage } from "../src/usage.js";

const step = (cost, input, output, read = 0, write = 0, reasoning = 0) => JSON.stringify({
  type: "step_finish", timestamp: 1, sessionID: "s",
  part: { type: "step-finish", reason: "stop", cost, tokens: { input, output, reasoning, cache: { read, write } } },
});
const text = (value) => JSON.stringify({ type: "text", part: { type: "text", text: value } });
const stream = [step(0.01, 1000, 200, 500, 100, 50), text("first"), "not json", step(0.02, 2000, 300), text("second"), ""].join("\n");

test("sums step_finish tokens and cost", () => {
  assert.deepEqual(parseUsage(stream), { steps: 2, cost: 0.03, input: 3000, output: 500, reasoning: 50, cache_read: 500, cache_write: 100 });
});

test("ignores malformed and unrelated events", () => {
  assert.deepEqual(parseUsage('{"type":"step_finish"\n{"type":"text"}'), { steps: 0, cost: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 });
});

test("extracts text parts in order", () => {
  assert.equal(parseText(stream), "first\nsecond");
});

test("records per-call usage on a shared context array and totals it", () => {
  const context = { opencodeModel: "anthropic/claude-sonnet-5-5", usage: [] };
  const routed = { ...context, opencodeModel: "openrouter/openai/gpt-5.5" };
  recordUsage(context, "findings", stream);
  recordUsage(routed, "scores", step(0.005, 100, 10));
  assert.equal(context.usage.length, 2);
  assert.deepEqual(context.usage.map((call) => [call.label, call.model]), [["findings", "anthropic/claude-sonnet-5-5"], ["scores", "openrouter/openai/gpt-5.5"]]);
  const { total } = summarizeUsage(context.usage);
  assert.equal(total.cost, 0.035);
  assert.equal(total.input, 3100);
});

test("failed calls keep their completed steps and mark totals as a lower bound", () => {
  const context = { opencodeModel: "deepseek/deepseek-flash", usage: [] };
  recordUsage(context, "findings", stream);
  recordUsage(context, "scores", step(0.125, 100, 20, 30, 10), { complete: false });
  assert.equal(context.usage[1].complete, false);
  assert.equal(context.usage[1].cost, 0.125);
  const { total } = summarizeUsage(context.usage);
  assert.equal(total.complete, false);
  assert.equal(total.cost, 0.155);
});
