// Pins the guard's reproduction of Pi's path rules to the installed Pi's own functions.
// A Pi release that changes a rule fails here. Set PI_DIST to Pi's dist directory (or run
// after `npm ci` in agent-image/pi-bootstrap); REQUIRE_PI_DIST=1 makes absence a failure.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { piResolve, piRewrites, piReadCandidates, piNormalize } from "../src/pi-guard.js";
import { piDistOrRequire, piDistVersion } from "../verification/pi-dist.js";

const { dist, skip: missing } = piDistOrRequire();
const piUtils = dist ? await import(pathToFileURL(join(dist, "core/tools/path-utils.js")).href) : null;

export const SPELLINGS = [
  "/etc/os-release", "@/etc/os-release", "@@/etc/os-release", "@ /etc/os-release", "@~/x", "@~", "~", "~/x", "~/", "~root/x",
  "file:///etc/os-release", "@file:///etc/os-release", "file:///a%20b", "notes.txt", "./notes.txt", "../notes.txt", "sub/../notes.txt",
  "@notes.txt", "@./notes.txt", "@../x", "a b", "a b", "a b", " /etc/os-release", "@ /etc/os-release", "　/etc/os-release",
  "/etc//os-release", "/etc/./os-release", "", "@", "/", "//etc/os-release", "$HOME/x", "${HOME}/x", "~/$HOME", "x\ny", "/tmp/x ", " /tmp/x",
  "/repo/a b.txt", "/repo/a b.txt", "@/repo/a b.txt", "/repo/a b.txt",
];
const SPACES = [" ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", "　"];
export const BASES = ["/work/cockpit", "/work/a b", "/work/café", "/work/cockpit/", "/work/école", "~", "~/proj", "file:///work/cockpit", ...SPACES.map(c => `/work/a${c}b`), `/work/${SPACES[0]}lead`];

test("the guard resolves every spelling against every base directory exactly as Pi's own resolveToCwd", { skip: missing }, () => {
  for (const base of BASES) for (const input of SPELLINGS) {
    let want, got;
    try { want = piUtils.resolveToCwd(input, base); } catch (error) { want = `throws ${error.name}`; }
    try { got = piResolve(input, base); } catch (error) { got = `throws ${error.name}`; }
    assert.equal(got, want, `${JSON.stringify(input)} against ${JSON.stringify(base)}`);
  }
});

test("the base directory rule is Pi's own, separate from its argument rule", { skip: missing }, () => {
  assert.equal(piResolve("notes.txt", "/work/a b"), "/work/a b/notes.txt");
  assert.equal(piUtils.resolveToCwd("notes.txt", "/work/a b"), "/work/a b/notes.txt");
  assert.equal(piResolve("a b/notes.txt", "/work"), "/work/a b/notes.txt");
});

test("a spelling Pi would rewrite is exactly one the guard reports as rewritten", { skip: missing }, () => {
  for (const input of SPELLINGS) assert.equal(piRewrites(input), piUtils.expandPath(input) !== input, JSON.stringify(input));
  assert.equal(piNormalize("@x"), piUtils.expandPath("@x"));
});

// `read` opens the first spelling that exists. For each variant a case where only that variant
// exists: Pi opens it and it must be among the guard's candidates.
const VARIANTS = {
  "am-pm": ["Screenshot 3 PM.png", n => n.replace(/ (AM|PM)\./gi, " $1.")],
  "nfd": ["café.txt", n => n.normalize("NFD")],
  "curly": ["o'café.txt", n => n.replace(/'/g, "’")],
  "nfd-curly": ["Capture d'écran.png", n => n.normalize("NFD").replace(/'/g, "’")],
};
for (const [label, [asked, make]] of Object.entries(VARIANTS)) {
  test(`read fallback candidate "${label}" is among the guard's candidates`, { skip: missing }, () => {
    const only = make(asked);
    assert.notEqual(only, asked);
    const folder = mkdtempSync(join(tmpdir(), `variant-${label}-`));
    try {
      writeFileSync(join(folder, only), "x");
      const opened = piUtils.resolveReadPath(asked, folder);
      assert.equal(opened, join(folder, only), "Pi opened the variant");
      assert.ok(piReadCandidates(piResolve(asked, folder)).includes(opened));
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
}

test("the pinned Pi is the version this runner was checked against", { skip: missing }, () => {
  const pin = JSON.parse(readFileSync(new URL("../../pi-bootstrap/package.json", import.meta.url), "utf8")).dependencies["@earendil-works/pi-coding-agent"];
  assert.equal(piDistVersion(dist), pin);
});
