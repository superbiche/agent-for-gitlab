# StudioNet Review Deployment Checklist

This checklist is for deploying the review-capable `@ai` runner to StudioNet GitLab.

## Build And Publish Agent Image

This repo is mirrored to `studio-net/gitlab-review-agent` on gitlab.gedeon.im. Its own pipeline (root `.gitlab-ci.yml`, dind) builds and pushes both images to the project registry on every branch push:

- `$CI_REGISTRY_IMAGE/agent:<sha|ref-slug|latest>` — the CI review runner (`AI_AGENT_IMAGE`)
- `$CI_REGISTRY_IMAGE/webhook:<sha|ref-slug|latest>` — the gitlab-app webhook

`latest` is only published from the default branch. Set `AI_AGENT_IMAGE=registry.gedeon.im/studio-net/gitlab-review-agent/agent:latest` (or pin a sha).

Manual fallback from the repository root:

```bash
docker build -f agent-image/Dockerfile -t registry.gedeon.im/studio-net/gitlab-review-agent/agent:<tag> .
```

Note: consumer projects' CI pulls `AI_AGENT_IMAGE` with per-job registry credentials. If `studio-net/gitlab-review-agent` is private, either allow the consumer projects in its job token allowlist or rely on group-internal visibility.

## GitLab Group Or Project CI Variables

Set these variables at the StudioNet group or project level. Values must be masked/protected according to StudioNet policy; do not commit values to the repo.

Required:

- `AI_AGENT_IMAGE`: fork-built review image.
- `GITLAB_TOKEN`: token with API access for notes/discussions and repository reads.
- `OPENCODE_MODEL`: `deepseek/<model-id>`.
- `DEEPSEEK_API_KEY`: DeepSeek provider key.

Review behavior:

- `REVIEW_MODE=excessive`
- `REVIEW_PROFILE=thorough`
- `REVIEW_SCORING=agents`
- `REVIEW_LANG=fr`
- `REVIEW_AUDIENCE=team`

Optional:

- `CUSTOM_AGENT_PROMPT`: repository-specific additions to the base agent prompt.

## Webhook App Environment

Confirm the webhook app forwards the expected pipeline variables:

- `DIRECT_PROMPT`
- `OPENCODE_AGENT_PROMPT`
- `OPENCODE_MODEL`
- `AI_PROJECT_PATH`
- `AI_AUTHOR`
- `AI_RESOURCE_TYPE`
- `AI_RESOURCE_ID`
- `AI_DISCUSSION_ID`
- `AI_BRANCH`

Webhook-side variables to configure:

- `GITLAB_URL`
- `WEBHOOK_SECRET`
- `GITLAB_TOKEN`
- `AI_GITLAB_USERNAME`
- `AI_GITLAB_EMAIL`
- `TRIGGER_PHRASE`
- `OPENCODE_MODEL`
- `OPENCODE_AGENT_PROMPT`

## Offline Smoke Checks

Before live GitLab testing:

```bash
cd agent-image/scripts
npm test
AI_DRY_RUN=1 DIRECT_PROMPT=review AI_RESOURCE_TYPE=mr AI_RESOURCE_ID=7 node ai-runner.js
```

Expected:

- Diff position tests pass.
- Dry-run prints a post plan and summary.
- No GitLab API or LLM call is made in dry-run mode.

## Live Acceptance Checks

Michel runs these on a sandbox MR:

- `@ai review` triggers the review path only when `DIRECT_PROMPT` starts with `review`.
- Inline DiffNotes land on valid changed lines.
- Findings with rejected positions fall back to plain MR notes.
- The summary note links to `#note_<id>` anchors.
- `REVIEW_MODE=excessive` includes the 40-59 confidence tier.
- Generic `@ai hello` still posts a normal opencode response.
