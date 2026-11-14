// Translator from Pi's `--mode json` event stream to the evidence the runner already
// consumes from OpenCode (usage per call, final text, verified source reads, failure).
// Shapes recorded 2026-11-14 from Pi 1.5.2 (test/fixtures/pi-*.jsonl); reference:
// Pi docs/json.md. Records are split on LF only, as Pi documents.
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

const finite = value => { const number = Number(value); return Number.isFinite(number) ? number : 0; };

export function piEvents(output = "", { strict = false } = {}) {
  const events = [];
  for (const line of String(output).split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { if (strict) throw new Error("Pi event stream was not valid JSON lines; review incomplete."); }
  }
  return events;
}

const assistantMessages = events => events.filter(e => e.type === "message_end" && e.message?.role === "assistant").map(e => e.message);

// One OpenCode "step" is one model request; on Pi that is one assistant message.
// Pi reports `reasoning` as a subset of `output`; OpenCode reports it separately, so
// the split is undone here and totals keep their meaning across harnesses.
export function parsePiUsage(output = "") {
  const usage = { steps: 0, cost: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  for (const message of assistantMessages(piEvents(output))) {
    const u = message.usage || {};
    const reasoning = Math.min(finite(u.reasoning), finite(u.output));
    usage.steps += 1;
    usage.cost += finite(u.cost?.total);
    usage.input += finite(u.input);
    usage.output += finite(u.output) - reasoning;
    usage.reasoning += reasoning;
    usage.cache_read += finite(u.cacheRead);
    usage.cache_write += finite(u.cacheWrite);
  }
  return usage;
}

export function parsePiText(output = "") {
  return assistantMessages(piEvents(output)).flatMap(m => (Array.isArray(m.content) ? m.content : []).filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text)).join("\n");
}

// Pi exits 0 after a failed provider call (recorded: exit 0, final assistant message
// stopReason "error", auto_retry_end success false). Failure is therefore read from
// the stream: the run must settle and its last assistant message must have stopped
// normally. Returns an error description or null.
export function piRunFailure(output = "") {
  const events = piEvents(output);
  if (!events.some(e => e.type === "agent_settled")) return "Pi run did not settle";
  if (events.find(e => e.type === "agent_settled")?.aborted) return "Pi run was aborted";
  const last = assistantMessages(events).at(-1);
  if (!last) return "Pi produced no assistant message";
  // Only the documented normal terminal reason completes a run. "length" is output-token
  // exhaustion (the answer is cut off, even when a file was written before it), "toolUse" is a
  // run that ended with calls pending, and anything else is a state this runner does not know.
  if (last.stopReason !== "stop") return `Pi run ended with stopReason ${last.stopReason}`;
  return null;
}

// Read evidence comes from the guard's own record of what it allowed (canonical path,
// decided before execution) joined with Pi's tool_execution_end for the same call id.
// Neither the model's text nor the arguments it wrote can certify a read.
export function parsePiRiskEvents(output, policy, guardRecords, expectedTools, allowedEnv = null) {
  const events = piEvents(output, { strict: true });
  const failure = piRunFailure(output);
  if (failure) throw new Error(`Risk review CLI reported an error (${failure}); review incomplete.`);
  const ready = guardRecords.filter(r => r.type === "ready");
  if (ready.length !== 1 || JSON.stringify(ready[0].tools) !== JSON.stringify([...expectedTools].sort())) throw new Error("Risk review guard did not load with the expected tool set; review incomplete.");
  // The Pi process must hold no variable the runner did not pass (a CI token, a cloud credential).
  if (allowedEnv) {
    const extra = (ready[0].envKeys || []).filter(key => !allowedEnv.includes(key));
    if (!Array.isArray(ready[0].envKeys) || extra.length) throw new Error(`Risk review process holds environment variables it was not given (${(extra.length ? extra : ["unreported"]).join(", ")}); review incomplete.`);
  }
  const guard = new Map(guardRecords.filter(r => r.type === "guard").map(r => [r.toolCallId, r]));
  const results = new Map(events.filter(e => e.type === "tool_execution_end").map(e => [e.toolCallId, e]));
  const root = (() => { try { return realpathSync(policy.repo); } catch { return policy.repo; } })();
  const allowed = new Set(policy.allowed.map(file => resolve(root, file)));
  const coverage = new Map();   // relative file -> { total, ranges: [[from, to]] }
  const failedReads = new Set();
  for (const start of events.filter(e => e.type === "tool_execution_start")) {
    const decision = guard.get(start.toolCallId);
    // Every executed call passes the guard first. Pi skips the guard for a call it rejects
    // itself (a tool that is not active, invalid arguments): that call must end in an
    // error. A call the guard never saw that succeeded ran unguarded.
    if (!decision) {
      if (results.get(start.toolCallId)?.isError === true) continue;
      throw new Error(`Risk review ran ${JSON.stringify(start.toolName)} without a guard decision; review incomplete.`);
    }
    if (!decision.allow) {
      // Refused before execution, like an OpenCode permission error: noted when it was a read.
      if (start.toolName === "read" && typeof start.args?.path === "string") failedReads.add(relative(policy.repo, resolve(policy.workdir, start.args.path)));
      continue;
    }
    if (!expectedTools.includes(start.toolName)) throw new Error(`Risk review executed unexpected tool ${JSON.stringify(start.toolName)}; review incomplete.`);
    if (start.toolName !== "read") continue;
    const file = decision.effective;
    const name = relative(root, file);
    const delivered = allowed.has(file) ? deliveredLines(results.get(start.toolCallId), file, decision.range) : null;
    if (!delivered) { failedReads.add(name); continue; }
    const entry = coverage.get(name) || { total: delivered.total, ranges: [] };
    if (delivered.from <= delivered.to) entry.ranges.push([delivered.from, delivered.to]);
    else if (delivered.total === 0) entry.empty = true;
    coverage.set(name, entry);
  }
  const reads = [], partialReads = [];
  for (const [name, entry] of coverage) {
    const merged = mergeRanges(entry.ranges);
    if (entry.empty || (merged.length === 1 && merged[0][0] === 1 && merged[0][1] >= entry.total)) reads.push(name);
    else if (merged.length) partialReads.push(`${name} (lines ${merged.map(([a, b]) => `${a}-${b}`).join(", ")} of ${entry.total})`);
    else failedReads.add(name);
  }
  if (!reads.length && !partialReads.length) throw new Error("Risk review completed no successful allowlisted source reads; review incomplete.");
  return { text: parsePiText(output), reads, partialReads, failedReads: [...failedReads] };
}

function mergeRanges(ranges) {
  const merged = [];
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to); else merged.push([from, to]);
  }
  return merged;
}

// What a successful `read` actually delivered, from the snapshot's own bytes and the result
// (Pi 1.5.2 read.js): the range the guard validated, Pi's truncation details, and the text.
// "Success" alone is not delivery: `limit: 0` and a first line over Pi's size limit both succeed
// with a notice and no source. The returned text must equal the lines of the file it claims
// (a notice may trail it), or nothing is credited. Returns { from, to, total } or null.
export function deliveredLines(end, file, range) {
  if (!end || end.isError !== false || !range) return null;
  const content = end.result?.content;
  const text = Array.isArray(content) && content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string" ? content[0].text : null;
  if (text === null) return null;
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch { return null; }
  const lines = raw.split("\n"), total = lines.length;
  const from = range.offset;
  if (from > total) return null;
  const truncation = end.result?.details?.truncation;
  const remaining = total - (from - 1);
  let count;
  if (truncation) count = truncation.firstLineExceedsLimit ? 0 : truncation.outputLines;
  else count = range.limit === null ? remaining : Math.min(range.limit, remaining);
  if (!Number.isInteger(count) || count < 0 || count > remaining) return null;
  if (raw.length === 0) return text === "" ? { from: 1, to: 0, total: 0 } : null;
  if (count === 0) return null;
  const expected = lines.slice(from - 1, from - 1 + count).join("\n");
  const tail = text.slice(expected.length);
  if (!text.startsWith(expected) || (tail !== "" && !/^\n\n\[[^\n\]]*\]$/.test(tail))) return null;
  return { from, to: from + count - 1, total };
}
