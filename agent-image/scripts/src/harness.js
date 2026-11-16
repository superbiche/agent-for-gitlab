import { runOpencode } from "./opencode.js";
import { runPi } from "./pi.js";

// The one entry point the runner and the review use; the harness is chosen by
// configuration (AGENT_HARNESS), OpenCode when unset. Any other value is refused here
// too (validateConfig refuses it earlier): never a silent fall back to the default.
export function runAgent(context, prompt, options) {
  if (context.harness === "pi") return runPi(context, prompt, options);
  if (context.harness === "opencode" || context.harness === undefined) return runOpencode(context, prompt, options);
  throw new Error(`Unknown AGENT_HARNESS ${JSON.stringify(context.harness)}; use "opencode" or "pi".`);
}
