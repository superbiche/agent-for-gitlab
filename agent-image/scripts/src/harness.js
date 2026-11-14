import { runOpencode } from "./opencode.js";
import { runPi } from "./pi.js";

// The one entry point the runner and the review use; the harness is chosen by
// configuration (AGENT_HARNESS), OpenCode when unset.
export function runAgent(context, prompt, options) {
  return context.harness === "pi" ? runPi(context, prompt, options) : runOpencode(context, prompt, options);
}
