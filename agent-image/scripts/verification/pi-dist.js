// Where the installed Pi's own code lives, for the tests that pin this runner's
// reproduction of Pi's rules to Pi itself. PI_DIST wins; otherwise the image's pinned
// install (pi-bootstrap/node_modules) is used. null when Pi is not installed here.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export function piDist() {
  const candidates = [process.env.PI_DIST, fileURLToPath(new URL("../../pi-bootstrap/node_modules/@earendil-works/pi-coding-agent/dist", import.meta.url))].filter(Boolean);
  return candidates.find(dir => existsSync(join(dir, "core/tools/path-utils.js"))) || null;
}
export function piDistVersion(dist) {
  return JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")).version;
}
