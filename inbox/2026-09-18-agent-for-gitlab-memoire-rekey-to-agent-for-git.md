# Memoire re-key pending: fold agent-for-gitlab -> agent-for-git

**Date:** 2026-09-18
**Source:** agent-for-gitlab (where this surfaced)
**Affects:** agent-for-gitlab repo / Memoire hub project identity

## Observed
- Repo had no `.memoire` file, so captures used fallback key `agent-for-gitlab`.
- Created `/home/michel/dev/devops/agent-for-gitlab/.memoire` with `project: agent-for-git` (forward rename: repo becomes shared core + GH/GL adapters, actual directory/repo rename comes later).
- New captures now land under `agent-for-git`; historical rows under `agent-for-gitlab` still need folding.

## Why it matters
Without the fold, history stays split across two project keys and future timeline/search reads on `agent-for-git` miss everything captured under the old key.

## Suggested action
Operator-present hub-side fold per `~/.agents/shared/memoire-rekey.md` § Hub (PG):
- Re-key pending: fold `agent-for-gitlab` -> `agent-for-git`.
- From-path: `/home/michel/dev/devops/agent-for-gitlab`
- Hub dry-run first: manual § Hub (PG), step (a), with `:FROM = /home/michel/dev/devops/agent-for-gitlab`, `:TO = agent-for-git`.
- Get explicit GO on dry-run counts before apply step (b). Never from an autonomous session.
- Do NOT delete this capture until the fold is verified; consumption = delete.
