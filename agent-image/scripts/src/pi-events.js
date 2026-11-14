// Translator from Pi's `--mode json` event stream to the evidence the runner already
// consumes from OpenCode (usage per call, final text, verified source reads, failure).
// Shapes recorded 2026-11-14 from Pi 1.5.2 (test/fixtures/pi-*.jsonl); reference:
// Pi docs/json.md. Records are split on LF only, as Pi documents.
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
  if (["error", "aborted"].includes(last.stopReason)) return `Pi run ended with stopReason ${last.stopReason}`;
  return null;
}

// Read evidence comes from the guard's own record of what it allowed (canonical path,
// decided before execution) joined with Pi's tool_execution_end for the same call id.
// Neither the model's text nor the arguments it wrote can certify a read.
export function parsePiRiskEvents(output, policy, guardRecords, expectedTools) {
  const events = piEvents(output, { strict: true });
  const failure = piRunFailure(output);
  if (failure) throw new Error(`Risk review CLI reported an error (${failure}); review incomplete.`);
  const ready = guardRecords.filter(r => r.type === "ready");
  if (ready.length !== 1 || JSON.stringify(ready[0].tools) !== JSON.stringify([...expectedTools].sort())) throw new Error("Risk review guard did not load with the expected tool set; review incomplete.");
  const guard = new Map(guardRecords.filter(r => r.type === "guard").map(r => [r.toolCallId, r]));
  const allowed = new Set(policy.allowed.map(file => resolve(policy.repo, file)));
  const results = new Map(events.filter(e => e.type === "tool_execution_end").map(e => [e.toolCallId, e]));
  const reads = new Set(), failedReads = new Set();
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
    const end = results.get(start.toolCallId);
    if (end && end.isError === false && allowed.has(file)) reads.add(relative(policy.repo, file));
    else failedReads.add(relative(policy.repo, file));
  }
  if (!reads.size) throw new Error("Risk review completed no successful allowlisted source reads; review incomplete.");
  return { text: parsePiText(output), reads: [...reads], failedReads: [...failedReads] };
}
