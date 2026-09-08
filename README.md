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

## Unicstay agent-authored MRs

The opt-in `risk` profile adds evidence-focused second opinions with separate impact/confidence, exact-head summaries, complete independent scoring and restricted source-inspection tools. See [Unicstay deployment](docs/unicstay-review-deployment.md). StudioNet keeps its existing profiles.

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
- `REVIEW_PROFILE`: `quick`, `standard`, `thorough`, or `risk`; default `standard`.
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

### Native secret policy for risk reviews

Risk reviews use TruffleHog 3.97.0, matching the local commit hook. The image pins
its official Linux amd64 archive SHA256; there is no runtime scanner download.
Source files are read from a private snapshot of the reviewed Git head. Native
findings remove a file from model-read permissions; unrelated unchanged findings
do not block every MR. Changes touching an excluded file fail before provider
submission. Symlink, submodule, oversized and unsupported paths remain excluded.

The tracked `.trufflehog-exclude-paths` at that head uses TruffleHog's native
repository-relative path regex semantics, including anchored expressions. Missing
configuration means no exceptions. Invalid configuration and scanner failures
block review. Only the operator should approve narrow whole-file exceptions;
an exception permits that source file and its diff to reach the provider.

Diffs include removed lines and old paths. Source segments are scanned under their
original paths; MR metadata, notes, focus, recent history and scoring/retry text
are scanned separately without source-file exceptions. This prevents a fixture
exception from also exempting a credential pasted into a discussion. TruffleHog
is the sole detector: all result classes are included, verification and updates
are disabled, and raw scanner diagnostics are suppressed. Detection has the same
limits as the pinned native tool; this is not proof that arbitrary text is secret-free.

Offline verification from `agent-image/scripts`:

```sh
npm test
node verification/native-policy.mjs
AI_DRY_RUN=1 DIRECT_PROMPT=review AI_RESOURCE_TYPE=mr AI_RESOURCE_ID=7 node ai-runner.js
```

Unit tests use controlled fake scanner processes and require no installed binary.
The separate native gate requires TruffleHog on PATH (or `NATIVE_SCANNER` pointing
to its binary) and fails if unavailable; it uses generated nonfunctional fixtures,
never live credentials or provider calls. Run that gate inside the built image too.
Official checksum source:
https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.0/trufflehog_3.97.0_checksums.txt
