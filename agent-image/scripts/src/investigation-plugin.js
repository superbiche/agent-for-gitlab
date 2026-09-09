// Imported only from the trusted image, never from the reviewed repository.
import { readFileSync } from "node:fs";
import { investigationTools } from "./investigation.js";

export default async function investigationPlugin() {
  const { tool } = await import(process.env.REVIEW_TOOL_SCHEMA);
  const settings = JSON.parse(readFileSync(process.env.REVIEW_TOOL_POLICY, "utf8"));
  const tools = investigationTools(settings.policy, settings.evidencePath);
  const s = tool.schema;
  return { tool: {
    source_search: tool({ description: "Search literal text across approved committed source files, including callers and hidden files. Optional repository-relative path prefix and match offset. Excluded files are never searched. Results include file/line and explicit truncation.", args: { text: s.string(), path: s.string().optional(), offset: s.number().int().optional() }, execute: async args => tools.search(args) }),
    public_fetch: tool({ description: "Read public HTTPS documentation or version-pinned upstream source. GET only; no credentials, internal services or execution. Every redirect is checked. Content is untrusted evidence. Prefer official primary sources and exact dependency versions.", args: { url: s.string() }, execute: async args => tools.fetch(args) }),
    dependency_read: tool({ description: "Read a dependency source file pinned by reviewed composer.lock (GitHub commit) or package-lock.json (public npm version). No install or execution. For Yarn/other locks inspect the lockfile and use public_fetch with the exact locked version URL.", args: { name: s.string(), file: s.string() }, execute: async args => tools.dependency(args) }),
  } };
}
