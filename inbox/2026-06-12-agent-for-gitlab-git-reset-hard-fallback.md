# Runner git sync: silent reset --hard fallback + shrug-and-continue

**Date:** 2026-06-12
**Source:** agent-for-gitlab (Codex verification flagged it; analyzed during SN delivery)
**Affects:** agent-image/scripts/src/git.js (`pullWithToken`, `ensureBranch`)

## Observed

`pullWithToken` (git.js:65-84): on `pull --rebase` failure it falls back to `fetch` + `git reset --hard FETCH_HEAD`; if that also fails it logs a warning and the runner **continues anyway**. `ensureBranch` (git.js:55-63) uses `checkout -B <branch>`, which moves an existing local branch to current HEAD.

## Why it matters

Benign in today's review-only ephemeral-CI path, but three traps:

1. **Shrug-and-continue masks failures**: after total sync failure the agent reviews (or edits/pushes) an indeterminate tree state silently. A review against a stale base is indistinguishable from a real one.
2. **Future work loss**: the obvious next feature for `@ai fix this` flows is a re-sync before push; this fallback (whose comment already rationalizes "lose local commits, that's ok for an agent") would silently discard agent-authored commits.
3. **Local runs**: the CLAUDE.md local-test recipe runs this path; against a real checkout, `checkout -B` + `reset --hard` rewrites a branch pointer and nukes uncommitted work. Only `AI_DRY_RUN` (routes before git setup) guards it.

## Suggested action

Small diff, hot path: fail the job loudly on total sync failure (existing `handleError` posts a ❌ comment); gate `reset --hard` behind an explicit ephemerality check (`CI == "true"`); surface the original pull error instead of the silent fallback warning.
