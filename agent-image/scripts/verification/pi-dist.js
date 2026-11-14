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

// The one place that decides what a missing Pi means: a skip on a bare checkout, a failure
// when REQUIRE_PI_DIST=1 (the image build and CI set it, so an image whose guard and Pi were
// never compared cannot be built). Returns { dist, skip } for `test(..., { skip })`.
export function piDistOrRequire() {
  const dist = piDist();
  if (!dist && process.env.REQUIRE_PI_DIST === "1") throw new Error("REQUIRE_PI_DIST=1 but no installed Pi was found (set PI_DIST to Pi's dist directory)");
  return { dist, skip: dist ? false : "Pi is not installed here (set PI_DIST)" };
}
