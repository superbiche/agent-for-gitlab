# Unicstay risk reviews

This deployment adds an on-demand second opinion for risky agent-authored MRs. It supplements local orthogonal review. The bot never approves or merges an MR.

## Review settings

- Model: `deepseek/deepseek-v4-flash`; existing `DEEPSEEK_API_KEY`.
- `REVIEW_PROFILE=risk`: contracts/callers, security, state/money, failure handling, tests, rollout and available history. Dedicated FIND/SCORE prompts; English, self audience, no teaching or optional style suggestions.
- `REVIEW_MODE=loose`: historical name meaning confidence >=80. Depth comes from profile, not this name. StudioNet's excessive mode admits >=40 and remains available with its original prompts.
- `REVIEW_SCORING=agents`: a separate model invocation verifies candidates; this is not a claim of model-family independence.
- Severity P1/P2/P3 is independent of confidence. Findings require triggers, reach, causal evidence and smallest remedies. Empty results list inspected surfaces and limitations.

Risk runs execute OpenCode outside the reviewed repository with explicit permissions: source reading and the two JSON output writes only, no shell, content search, delegation, plugins or LSP. CI GitLab credentials are not passed to the model subprocess. Only inventoried tracked regular files in the committed source snapshot are readable. Symlinks, submodules, files over 1 MiB and unsupported paths remain excluded. Native TruffleHog 3.97.0 findings remove files from source-read permissions; findings in changed source or submitted prompt content block external review. TruffleHog is the sole credential detector, with the coverage limits of that pinned tool; missing context is reported. This is tool permission enforcement, not an OS sandbox. Runtime tests are performed by the implementing agent outside this credential-bearing job.

The [native secret policy](../README.md#native-secret-policy-for-risk-reviews) defines scanner flags and exceptions. `.trufflehog-exclude-paths` comes from the reviewed head, matching the local hook's staged configuration. Operator approval of exceptions is a workflow requirement; an approved source fixture and its exception may be introduced in the same MR. Source-file exceptions do not exempt discussion, history or model-generated scoring text. A missing scanner, invalid configuration or scanning failure blocks review; an absent configuration file means no exceptions.

The webhook owns model selection: its API pipeline variable takes precedence over the template's Flash fallback for direct API runs. Verify the effective model in the result. Risk requires independent scoring even outside the template.

Each risk model call has a 20-minute timeout and a 512 KiB assembled-input limit; oversized input fails explicitly without submitting a partial review. The source inventory is limited to 2,000 names in the prompt; the model can locate other allowed files with glob. These limits do not change generic/StudioNet invocation timing. OpenCode gets separate isolated workspace and home/config/state directories; The isolated working directory is deliberately outside every Git worktree: the pinned CLI can stall while booting Git-backed location services. A preflight refuses a Git-backed temporary directory. In this verified non-Git mode OpenCode uses `/` as its worktree, so exact read/edit allowlist entries are root-relative, with external-directory access separately constrained. Its required plugin API dependency is installed from a pinned lockfile at image build and supplied to the empty config directory, avoiding cold runtime dependency installation even though OpenCode initializes that dependency under `--pure`.

The runner consumes the pinned OpenCode CLI's JSON tool events. Each FIND/SCORE invocation must complete a successful read of an allowlisted source file, or the review fails as incomplete. Summaries distinguish model-reported inspection from tool-verified reads and report unsuccessful read attempts. A successful read proves access, not exhaustive understanding; findings and coverage still require independent triage.

The runner checks the MR head against the triggering pipeline, checks out that head, paginates diffs/notes, checks GitLab 17.x `/changes` overflow as well as newer diff-size flags, accepts metadata-only rename/mode/binary entries with explicit limitations, rejects incomplete GitLab context and missing scores, then checks head freshness before posting. Each summary identifies head SHA, pipeline and triggering note. A later push makes the old result stale even if posting has already begun.

GitLab's `/changes` endpoint is deprecated and scheduled for removal in API v5. Revalidate completeness detection before a GitLab/API upgrade; an unavailable or unknown overflow result fails closed.

## Deployment

Source mirror: `unicstay/infra/gitlab-review-agent` (project212). Its CI config is `.gitlab-ci.unicstay.yml`, using Unicstay's untagged runner. Build immutable SHA-tagged agent/webhook images in the native registry. Preserve StudioNet's pipeline and deployment.

Upgrade the existing `sombrero / gitlab / ai-webhook` deployment and existing `ai-webhook.gitlab.superbiche.co` ingress. Align the bot username to `ai`, select Flash, set `REVIEW_ONLY=true`, disable pending-pipeline cancellation, and retain the existing webhook secret. Never apply a Secret from the historical all.yaml merely to update the deployment.

Use `AI_AGENT_IMAGE` pointing at the verified immutable agent image. Record its digest alongside the webhook digest, source commit and template ref in the deployment evidence. The bot token must be the existing ai user's credential and have repository-read, note-posting and pipeline privileges. Consumer jobs need private registry pull authorization; validate it with a real job rather than assuming cross-project CI_JOB_TOKEN permissions.

## Enrollment

For main apps and stack, move the original root CI byte-for-byte into `.gitlab/normal-pipeline.yml`. Root conditional includes select the normal pipeline for AI_TRIGGER != true or `gitlab-utils/risk-review.yml` from the mirror at a full commit SHA for equality. Normal and review configurations never merge. Update stack's `.gitlab-ci.yml` changes-watchers to also include the moved normal file. Infra had no CI: include the review template unconditionally so the YAML remains valid, with its workflow denying ordinary pipelines.

CI lint must confirm normal merged configuration equivalence and exactly one review job. Deploy the comma-separated SHA-256 hashes of the validated CI entrypoint files in `REVIEW_CI_CONFIG_SHA256`. In review-only mode, missing/unapproved entrypoints refuse before pipeline creation and post an explanatory MR note. Refresh this allowlist when the router or its pinned ref changes, after validating isolation. This guards old/unenrolled branches; it does not replace GitLab's CI authoring permissions or make arbitrary CI secure. The dedicated source mirror uses its separately validated custom entrypoint during acceptance.

Register note-only hooks after enrollment, SSL verification enabled, using the existing webhook secret. Existing MR branches need the enrolled CI files before invoking the bot.

## Validation

Local gates: `npm --prefix agent-image/scripts test`, `npm --prefix gitlab-app run typecheck`, `bun test gitlab-app/test`, the README dry-run, and `git diff --check`. Build CI runs the runner tests before publishing images. Live acceptance uses a controlled MR, verifies one review-only job and complete summary on its exact SHA, inspects findings, and checks a follow-up review after a corrective commit.

The operator cycle is documented in Unicstay `.agents/gitlab-risk-review.md`, linked from the stack-root AGENTS.md. It uses GitLab artifacts/discussions and normal review triage, without Liaison records for this additional remote review.

## Non-Git runtime acceptance

At OpenCode 1.18.18, the synthetic `git init` context repeatedly stalled before the main model call; model-free `debug v2` reproduced it, while the legacy tool-registry diagnostic passed. An empty Git commit, disabled title generation and disabled native indexing did not resolve it. A fresh non-Git context completed the same service diagnostic immediately and the exact review prompt completed with six verified source reads and the seeded refund finding. This removes an unnecessary synthetic repository, not the permission boundary. The upstream [Git-context startup report](https://github.com/anomalyco/opencode/issues/42857) is similar but describes a different environment; no claim is made that its precise internal deadlock is identical. Runtime acceptance still requires the built-image allowed/denied read/write probe and a correlated real webhook review/fix/re-review cycle.
