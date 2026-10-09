import logger from "./logger.js";

// Sums opencode `--format json` step_finish events (cost in USD, as priced by
// opencode's model registry) for one CLI call.
export function parseUsage(output = "") {
  const usage = { steps: 0, cost: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  for (const line of output.split("\n")) {
    if (!line.includes('"step_finish"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "step_finish") continue;
    const part = event.part || {};
    const tokens = part.tokens || {};
    usage.steps += 1;
    usage.cost += finite(part.cost);
    usage.input += finite(tokens.input);
    usage.output += finite(tokens.output);
    usage.reasoning += finite(tokens.reasoning);
    usage.cache_read += finite(tokens.cache?.read);
    usage.cache_write += finite(tokens.cache?.write);
  }
  return usage;
}

// Text parts of a `--format json` stream, in order; non-JSON lines are ignored.
export function parseText(output = "") {
  const text = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "text" && typeof event.part?.text === "string") text.push(event.part.text);
  }
  return text.join("\n");
}

export function recordUsage(context, label, output) {
  const usage = { label, model: context.opencodeModel, ...parseUsage(output) };
  if (Array.isArray(context.usage)) context.usage.push(usage);
  logger.info(`Usage ${label}: model=${usage.model} cost=$${usage.cost.toFixed(4)} input=${usage.input} output=${usage.output} reasoning=${usage.reasoning} cache_read=${usage.cache_read} cache_write=${usage.cache_write} steps=${usage.steps}`);
  return usage;
}

export function summarizeUsage(calls = []) {
  const total = { cost: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  for (const call of calls) for (const key of Object.keys(total)) total[key] += call[key] || 0;
  total.cost = Number(total.cost.toFixed(6));
  if (calls.length) logger.info(`Usage total: cost=$${total.cost.toFixed(4)} input=${total.input} output=${total.output} calls=${calls.length}`);
  return { total, calls };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
