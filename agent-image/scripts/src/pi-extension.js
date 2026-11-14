// Loaded into the Pi process by explicit path (-e), never from the reviewed
// repository. It is the risk-review boundary on Pi: it registers the image-owned
// tools, restricts the active tool set, decides every tool call before it runs and
// leaves a record the runner checks afterwards. Policy comes from a file the runner
// wrote outside the work directory; the model supplies arguments, never policy.
import { readFileSync, appendFileSync } from "node:fs";
import { investigationTools } from "./investigation.js";
import { decideToolCall, globInventory, RISK_TOOLS } from "./pi-guard.js";

const text = value => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} });
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });

export default function piReviewExtension(pi) {
  const settings = JSON.parse(readFileSync(process.env.REVIEW_TOOL_POLICY, "utf8"));
  const policy = { ...settings.policy, workdir: settings.workdir, tools: RISK_TOOLS, ...(settings.outputs ? { outputs: settings.outputs } : {}) };
  const record = item => appendFileSync(settings.guardPath, JSON.stringify(item) + "\n", { mode: 0o600 });
  const tools = investigationTools(settings.policy, settings.evidencePath);

  pi.registerTool({ name: "glob", label: "glob", description: "List approved committed source files by glob pattern (a pattern without a slash matches file names at any depth). Only the approved inventory is visible.", parameters: object({ pattern: { type: "string" } }, ["pattern"]), execute: async (_id, params) => text(globInventory(policy.allowed, params.pattern)) });
  pi.registerTool({ name: "source_search", label: "source_search", description: "Search literal text across approved committed source files, including callers and hidden files. Optional repository-relative path prefix and match offset. Excluded files are never searched. Results include file/line and explicit truncation.", parameters: object({ text: { type: "string" }, path: { type: "string" }, offset: { type: "integer" } }, ["text"]), execute: async (_id, params) => text(tools.search(params)) });
  pi.registerTool({ name: "public_fetch", label: "public_fetch", description: "Read public HTTPS documentation or version-pinned upstream source. GET only; no credentials, internal services or execution. Every redirect is checked. Content is untrusted evidence. Prefer official primary sources and exact dependency versions.", parameters: object({ url: { type: "string" } }, ["url"]), execute: async (_id, params) => text(await tools.fetch(params)) });
  pi.registerTool({ name: "dependency_read", label: "dependency_read", description: "Read a dependency source file pinned by reviewed composer.lock (GitHub commit) or package-lock.json (public npm version). No install or execution. For Yarn/other locks inspect the lockfile and use public_fetch with the exact locked version URL.", parameters: object({ name: { type: "string" }, file: { type: "string" } }, ["name", "file"]), execute: async (_id, params) => text(await tools.dependency(params)) });

  pi.on("tool_call", async event => {
    const decision = decideToolCall(policy, { toolName: event.toolName, input: event.input });
    record({ type: "guard", toolCallId: event.toolCallId, tool: event.toolName, allow: decision.allow, effective: decision.effective ?? null, range: decision.range ?? null });
    if (!decision.allow) return { block: true, reason: decision.reason };
    // Execute exactly the arguments that were checked.
    if (decision.input !== event.input) {
      for (const key of Object.keys(event.input)) delete event.input[key];
      Object.assign(event.input, decision.input);
    }
  });

  pi.on("session_start", async () => {
    pi.setActiveTools([...RISK_TOOLS]);
    // Names only, never values: the runner checks that no credential variable reached this process.
    record({ type: "ready", tools: pi.getActiveTools().slice().sort(), envKeys: Object.keys(process.env).sort() });
  });
}
