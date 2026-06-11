# agent-for-gitlab Notes

This repository is a GitLab `@ai` bot fork. The active architecture is webhook-triggered CI plus a Node runner in `agent-image/scripts/`.

## Current Architecture

```text
GitLab comment
  -> gitlab-app webhook
  -> GitLab CI job using agent-image
  -> ai-runner
  -> opencode + GitLab REST posting
```

`gitlab-app/` is treated as working webhook infrastructure for the current review-port work. The runner owns GitLab posting; do not reintroduce the custom MCP server or switch the runner to bash for review orchestration.

## Review Command

`DIRECT_PROMPT` routes to review only when it matches `^\s*review\b` case-insensitively.

Review orchestration:

1. Fetch MR metadata, `diff_refs`, diffs, and notes through GitLab REST.
2. Run opencode FIND with `prompts/review/find.md`.
3. Run opencode SCORE with `prompts/review/score.md` when `REVIEW_SCORING=agents`.
4. Filter in Node by confidence threshold.
5. Post inline DiffNotes when positions map.
6. Fall back to plain MR notes when inline posting fails.
7. Post one summary note with `#note_<id>` links.

Generic `@ai <anything else>` still runs opencode once and posts captured stdout.

## Key Environment Variables

- `DIRECT_PROMPT`
- `OPENCODE_AGENT_PROMPT`
- `CUSTOM_AGENT_PROMPT`
- `OPENCODE_MODEL`
- `GITLAB_TOKEN`
- `CI_SERVER_HOST`
- `CI_SERVER_URL`
- `CI_API_V4_URL`
- `CI_PROJECT_ID`
- `AI_PROJECT_PATH`
- `AI_AUTHOR`
- `AI_RESOURCE_TYPE`
- `AI_RESOURCE_ID`
- `AI_DISCUSSION_ID`
- `AI_BRANCH`

Review variables:

- `REVIEW_MODE`: `loose`, `strict`, `excessive`; default `strict`.
- `REVIEW_PROFILE`: `quick`, `standard`, `thorough`; default `standard`.
- `REVIEW_SCORING`: `global`, `agents`; default `agents` for excessive mode, else `global`.
- `REVIEW_LANG`: `en`, `fr`; default `en`.
- `REVIEW_AUDIENCE`: `team`, `oss`, `self`; default `team`.
- `AI_DRY_RUN`: fixture mode without GitLab or LLM calls.

DeepSeek deployment uses `DEEPSEEK_API_KEY` and `OPENCODE_MODEL=deepseek/<model-id>`.

## Build And Test

Build from the repository root so Docker can copy top-level prompts:

```bash
docker build -f agent-image/Dockerfile -t ai-agent .
```

Run local tests:

```bash
cd agent-image/scripts
npm test
```

Run review dry-run:

```bash
cd agent-image/scripts
AI_DRY_RUN=1 DIRECT_PROMPT=review AI_RESOURCE_TYPE=mr AI_RESOURCE_ID=7 node ai-runner.js
```

## Guardrails

- Do not edit `gitlab-app/` for review runner changes.
- Do not run live GitLab, deployment, or LLM calls during offline implementation.
- Do not print secret values; use variable names only.
- Keep review posting deterministic in Node.
