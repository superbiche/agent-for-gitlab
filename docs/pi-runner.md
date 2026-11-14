# Pi runner (alternative to OpenCode)

The runner can drive Pi (`@earendil-works/pi-coding-agent`, pinned 1.5.2) instead of OpenCode.
OpenCode stays the default; a job opts in with `AGENT_HARNESS=pi`. An unknown value is an
error, never a silent fall back to OpenCode.

## Switching a workflow (owner's steps, in order)

1. Pin the image tag that ships Pi (it is not published by this change; the operator builds and pins it).
2. Set `AGENT_HARNESS=pi` in the job. Nothing else in the pipeline or repository changes.
3. Re-express the model. `OPENCODE_MODEL` keeps its name and its `provider/model` shape, but the id must be one
   Pi knows (`pi --list-models`); Pi's catalogue differs from OpenCode's. Example: `deepseek/deepseek-v4-flash`
   becomes `deepseek/deepseek-flash`. A model Pi does not know fails before any model call.
4. Keep the provider key variable (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...). Not carried:
   `Z_API_KEY` (a zai provider needs a `models.json` entry), `AZURE_RESOURCE_NAME` (Pi's azure provider reads
   `AZURE_OPENAI_*`), Bedrock profiles. These stay on OpenCode.

Pin back: unset `AGENT_HARNESS` (or set `opencode`), or pin the previous image tag. Both harnesses are in the image.

## Contract (what the scripts guarantee on either harness)

| Evidence / guarantee | OpenCode | Pi |
|---|---|---|
| per-call usage (input, output, reasoning, cache, cost, steps) | `step_finish` events | `message_end` of each assistant message (`src/pi-events.js`); Pi's `reasoning` (a subset of `output`) is split out to keep OpenCode's meaning |
| final text | `text` parts | text blocks of assistant messages |
| failure | exit status, `error` event | stream: Pi **exits 0 after a failed provider call**; failure is the run not settling or its last assistant message ending `error`/`aborted` |
| verified source reads (risk) | `tool_use` read events completed on an allowlisted path | the guard's own decision record (canonical path) joined with `tool_execution_end` for the same call id |

## Risk-review denials on Pi

Pi has no permission system: a tool runs with the process's rights. Each denial is owned by a named
mechanism; `verification/pi-mutations.mjs` removes each one and the Pi tests must fail, and
`checks/pi-risk-runtime.mjs <variant>` shows the guarantee lost on the real Pi when it is removed.

| Denial | Mechanism (file) |
|---|---|
| no shell, grep, find, ls, edit, web or delegation tool | tool allowlist: `--tools` (declaration), the extension's `setActiveTools`, and the guard's deny-by-default tool check (`src/pi-guard.js`, `src/pi-extension.js`, `src/pi.js`) |
| reads only of the approved snapshot (+ the two outputs) | guard `read` rule: canonical realpath must be an inventory file (links refused), executed with the canonical path |
| writes only `/tmp/review-findings.json`, `/tmp/review-scores.json` | guard `write` rule, link at the output path refused |
| no CI credential reachable | minimal process environment (`piRiskInvocation`: PATH, isolated HOME, the one model key, Pi switches); no shell to dump it; `/proc/self/environ` is outside the inventory |
| repository cannot configure or extend the agent | work directory outside any Git worktree, `--no-extensions` (+ explicit `-e` for the image's own extension), `--no-approve`, `--no-context-files`, `--no-skills`, `--no-prompt-templates`, `--no-mcp` |
| nothing fetched or phoned home at job time | `--offline`, `PI_OFFLINE`, `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK`; Pi is installed at build time from a locked, integrity-checked install |
| a run without its guard is not accepted | the runner requires the extension's `ready` record with exactly the expected tool set, and a guard decision for every executed call |
| filename discovery cannot reveal files outside the inventory | image-owned `glob` over the inventory (Pi's builtin `find` needs an `fd` binary and walks anywhere) |

## Not equivalent, or not verified

See the slice report for the full list. In short: network egress is not restricted by either harness
(the image-owned `public_fetch` is the only fetch tool); review quality on Pi with DeepSeek was not compared;
Pi's default thinking level may differ from OpenCode's.
