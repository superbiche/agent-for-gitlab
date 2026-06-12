# `@ai` on GitLab

![Comments Showcase](./docs/assets/header.png)

This fork runs an AI assistant from GitLab CI when the webhook app sees an `@ai` comment. The webhook in `gitlab-app/` starts a pipeline; the agent image runs `opencode` and posts results back to the MR or issue through GitLab REST.

## Current Architecture

![Architecture](./docs/assets/architecture.png)

```text
GitLab comment "@ai ..."
  -> webhook app triggers a CI job with DIRECT_PROMPT and AI_* variables
  -> agent-image ai-runner clones/checks out the target branch
  -> generic requests run opencode once and post stdout as a note
  -> "review" requests run deterministic MR review orchestration
```

There is no custom MCP server in the runner. GitLab reads/writes are done by Node through REST. `glab` is installed in the image for model-side read-only investigation during review, but posting is runner-owned.

## Review Flow

`DIRECT_PROMPT` is routed to review only when it matches `^\s*review\b` case-insensitively. Everything else stays on the generic path.

For `@ai review` on a merge request, the runner:

1. Fetches MR metadata, `diff_refs`, diffs, and existing notes through GitLab REST.
2. Runs opencode with `prompts/review/find.md` to produce candidate findings JSON.
3. Runs opencode with `prompts/review/score.md` when `REVIEW_SCORING=agents`.
4. Filters findings in Node using the mode threshold: `loose=80`, `strict=60`, `excessive=40`.
5. Posts inline DiffNotes when a valid diff position can be mapped.
6. Falls back to a plain MR note per finding when GitLab rejects an inline position.
7. Posts one summary MR note with `#note_<id>` links to inline or fallback notes.

The review behavior is a port of Michel's `/review` command: passes A-I, confidence rubric, false-positive filters, severity tiers, suggestions, strengths, and English/French audience-aware report text.

## Agent Image

Build the image from the repository root so the top-level `prompts/` directory is included:

```bash
docker build -f agent-image/Dockerfile -t ai-agent .
```

The image uses `node:22-bookworm-slim`, installs pinned `glab` and `opencode-ai`, copies `agent-image/scripts/`, and copies `prompts/` to `/opt/agent/prompts/`.

## CI Template

Copy or include [gitlab-utils/.gitlab-ci.yml](./gitlab-utils/.gitlab-ci.yml). Override `AI_AGENT_IMAGE` with the image built from this fork; the template default is only a placeholder inherited from upstream.

Required CI variables:

- `AI_AGENT_IMAGE`: fork-built agent image.
- `GITLAB_TOKEN`: masked token with GitLab API access.
- `OPENCODE_MODEL`: `provider/model`, for example `deepseek/<model-id>`.
- Provider key for the selected model, for DeepSeek use `DEEPSEEK_API_KEY`.

Review variables:

- `REVIEW_MODE`: `loose`, `strict`, or `excessive`; default `strict`.
- `REVIEW_PROFILE`: `quick`, `standard`, or `thorough`; default `standard`.
- `REVIEW_SCORING`: `global` or `agents`; default is `agents` when mode is `excessive`, otherwise `global`.
- `REVIEW_LANG`: `en` or `fr`; default `en`.
- `REVIEW_AUDIENCE`: `team`, `oss`, or `self`; default `team`.

StudioNet target variables:

- `REVIEW_MODE=excessive`
- `REVIEW_PROFILE=thorough`
- `REVIEW_SCORING=agents`
- `REVIEW_LANG=fr`
- `REVIEW_AUDIENCE=team`
- `OPENCODE_MODEL=deepseek/<model-id>`
- `DEEPSEEK_API_KEY` set as a masked secret

## Webhook App

The webhook app remains in `gitlab-app/` and is not part of the review runner changes. Configure it with the GitLab URL, webhook secret, trigger phrase, bot identity, and the pipeline variables it forwards, including `DIRECT_PROMPT`, `OPENCODE_AGENT_PROMPT`, `OPENCODE_MODEL`, and `AI_*` values.

Webhook variables to check for deployment:

- `GITLAB_URL`
- `WEBHOOK_SECRET`
- `GITLAB_TOKEN`
- `AI_GITLAB_USERNAME`
- `AI_GITLAB_EMAIL`
- `TRIGGER_PHRASE`, default `@ai`
- `OPENCODE_MODEL`
- `OPENCODE_AGENT_PROMPT`

## Dry-run Review

`AI_DRY_RUN=1` lets the review orchestrator run without GitLab or LLM calls. It loads fixture JSON and prints the post plan plus summary.

```bash
cd agent-image/scripts
AI_DRY_RUN=1 \
DIRECT_PROMPT=review \
AI_RESOURCE_TYPE=mr \
AI_RESOURCE_ID=7 \
node ai-runner.js
```

Optional fixture overrides:

- `REVIEW_FIXTURE_MR`
- `REVIEW_FIXTURE_DIFFS`
- `REVIEW_FIXTURE_FINDINGS`
- `REVIEW_FIXTURE_SCORES`

## Testing

Run the fixture test for DiffNote position mapping:

```bash
cd agent-image/scripts
npm test
```

The test covers added lines, context lines, renamed files, deleted lines, and missing `diff_refs`.

## Notes And Limits

- No live GitLab, deployment, or LLM calls are required for local tests.
- Large MRs may exceed model context in thorough mode; v1 documents this but does not chunk diffs.
- Inline DiffNotes depend on GitLab accepting the position object. The runner falls back to plain MR notes when a position is unmappable or rejected.
- The generic `@ai <anything>` path captures opencode stdout and posts it as a note.
