# GitLab MR Code Review Prompt

## Overview

This prompt is adapted from [Anthropic's official code-review plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review) for GitLab.

## Configuration

```yaml
# Base settings (can be overridden)
confidence_threshold: 80
output_language: "en"  # "en" or "fr"
```

## Customization Hooks

This prompt supports three levels of customization:

1. **CLAUDE.md** (per-project): Project-specific conventions in the repo root
2. **USER_REVIEW_CONFIG** (per-user): User preferences via environment variable
3. **PROJECT_REVIEW_CONFIG** (per-project CI): Project overrides via CI variable

### USER_REVIEW_CONFIG format (JSON):
```json
{
  "exclude_patterns": ["*.generated.ts", "migrations/*"],
  "extra_conventions": ["Always use strict TypeScript"],
  "severity_overrides": {
    "missing_tests": "suggestion"
  }
}
```

### PROJECT_REVIEW_CONFIG format (JSON):
```json
{
  "frameworks": ["laravel", "vue", "nuxt"],
  "extra_claude_md_paths": ["docs/CONVENTIONS.md"],
  "skip_agents": ["historical_context"]
}
```

---

## Prompt

Provide a code review for the given merge request.

To do this, follow these steps precisely:

### Step 1: Eligibility Check (Haiku agent)

Check if the merge request:
- (a) is closed or merged
- (b) is a draft/WIP
- (c) does not need a code review (e.g., automated MR, very simple and obviously ok)
- (d) already has a code review from you from earlier (check MR notes)

If any of these are true, do not proceed. Report why and stop.

Use GitLab MCP tools:
- `glab mr view <MR_IID>` to get MR status
- `glab mr note list <MR_IID>` to check existing reviews

### Step 2: Gather CLAUDE.md Files (Haiku agent)

Return a list of file paths (not contents) for any relevant CLAUDE.md files:
- Root CLAUDE.md (if exists)
- Any CLAUDE.md in directories whose files the MR modified
- Any paths specified in PROJECT_REVIEW_CONFIG.extra_claude_md_paths

Use local filesystem to list files:
```bash
find . -name "CLAUDE.md" -type f
```

### Step 3: MR Summary (Haiku agent)

View the merge request and return:
- Title and description
- Files changed (list)
- Brief summary of the change intent

Use GitLab MCP:
- `glab mr diff <MR_IID>` for the diff
- `glab mr view <MR_IID>` for metadata

### Step 4: Parallel Code Review (5 Sonnet agents)

Launch 5 parallel agents to independently review the change. Each agent returns a list of issues with:
- Issue description
- Reason flagged (CLAUDE.md adherence, bug, historical context, etc.)
- File and line reference

#### Agent #1: CLAUDE.md Compliance

Audit the changes against CLAUDE.md guidelines.

Note: CLAUDE.md is guidance for Claude as it writes code, so not all instructions apply during code review. Focus on:
- Explicit coding standards
- Architecture patterns required
- Naming conventions
- Error handling requirements

#### Agent #2: Bug Detection (Shallow Scan)

Read the file changes and do a shallow scan for obvious bugs:
- Focus ONLY on the diff, avoid reading extra context
- Focus on large bugs, avoid nitpicks
- Ignore likely false positives

Look for:
- Logic errors that will definitely produce wrong results
- Null/undefined access without checks
- Resource leaks
- Security vulnerabilities (injection, XSS, etc.)
- Off-by-one errors
- Race conditions (obvious ones)

#### Agent #3: Historical Context

Read git blame and history of modified code:
```bash
git log --oneline -10 -- <file>
git blame <file>
```

Identify bugs in light of:
- Why the code was written this way
- Previous fixes that might be undone
- Patterns established by history

#### Agent #4: Previous MR Review

Check previous merge requests that touched these files:
- Use `glab mr list --state=merged` filtered by paths
- Look for comments on those MRs that may apply here
- Check for recurring issues

#### Agent #5: Code Comments Compliance

Read code comments in modified files:
- TODO/FIXME that should be addressed
- Documentation comments that contradict changes
- Inline guidance that changes violate

---

### Step 5: Confidence Scoring (Parallel Haiku agents)

For each issue found in Step 4, launch a parallel Haiku agent that scores confidence (0-100).

The agent receives:
- The MR diff
- Issue description
- List of CLAUDE.md files (from Step 2)

#### Scoring Rubric (give verbatim to agent):

- **0**: Not confident at all. False positive that doesn't stand up to light scrutiny, or pre-existing issue.

- **25**: Somewhat confident. Might be real, might be false positive. Agent couldn't verify it's real. If stylistic, not explicitly in CLAUDE.md.

- **50**: Moderately confident. Verified as real issue, but might be nitpick or rare in practice. Not very important relative to rest of MR.

- **75**: Highly confident. Double-checked and very likely real, will be hit in practice. Existing approach is insufficient. Very important for functionality OR directly mentioned in CLAUDE.md.

- **100**: Absolutely certain. Double-checked and confirmed definitely real, will happen frequently. Evidence directly confirms this.

#### For CLAUDE.md issues:
Agent MUST double-check that CLAUDE.md actually calls out that issue specifically. No generic inferences.

---

### Step 6: Filter Results

Filter out issues with score < 80 (or custom threshold from config).

**Also filter out these false positives:**
- Pre-existing issues (not introduced by this MR)
- Something that looks like a bug but isn't
- Pedantic nitpicks a senior engineer wouldn't call out
- Issues a linter/typechecker/compiler would catch (imports, types, formatting)
- General code quality unless explicitly required in CLAUDE.md
- Issues called out in CLAUDE.md but silenced in code (lint ignore comments)
- Intentional functionality changes related to the broader change
- Real issues on lines the user did not modify
- Files matching USER_REVIEW_CONFIG.exclude_patterns

If no issues remain after filtering, proceed to Step 8.

---

### Step 7: Re-check Eligibility (Haiku agent)

Repeat the eligibility check from Step 1 to ensure MR is still open and reviewable.

If no longer eligible, do not post comment.

---

### Step 8: Post Review Comment

Use GitLab MCP to comment on the merge request:
```bash
glab mr note <MR_IID> --message "<review>"
```

#### Output Format (if issues found):

```markdown
### Code review

Found N issue(s):

1. <brief description> (CLAUDE.md says "<exact quote>")

https://gitlab.example.com/group/project/-/blob/<full_sha>/path/to/file.ext#L10-15

2. <brief description> (bug due to <explanation>)

https://gitlab.example.com/group/project/-/blob/<full_sha>/path/to/file.ext#L20-25

---

🤖 Generated with [Claude](https://claude.ai)

<sub>If this review was useful, please react with 👍. Otherwise, react with 👎.</sub>
```

#### Output Format (if no issues):

```markdown
### Code review

No issues found. Checked for bugs and CLAUDE.md compliance.

🤖 Generated with [Claude](https://claude.ai)
```

#### Output Format (French, if configured):

```markdown
### Revue de code

N problème(s) trouvé(s):

1. <description brève> (CLAUDE.md indique "<citation exacte>")

https://gitlab.example.com/group/project/-/blob/<full_sha>/path/to/file.ext#L10-15

---

🤖 Généré avec [Claude](https://claude.ai)

<sub>Si cette revue était utile, réagissez avec 👍. Sinon, avec 👎.</sub>
```

---

## Link Format Rules

When linking to code, use this format precisely:
```
https://gitlab.example.com/group/project/-/blob/<full_sha>/path/to/file#L<start>-<end>
```

Requirements:
- Full git SHA (not HEAD or branch name)
- `#L` prefix for line numbers
- Line range: `L10-15` (not `L10-L15`)
- Provide 1 line of context before/after the issue lines
- Repo path must match the MR's project

---

## Notes

- Do NOT check build signal or attempt to build/typecheck. CI handles that separately.
- Use `glab` MCP tools for GitLab API interactions
- Use local git for blame/history
- Create a todo list before starting
- MUST cite and link each issue (link to CLAUDE.md if referenced)
- Keep output brief, avoid emojis (except footer)

---

## Limitations vs Original

This GitLab adaptation has some differences from the GitHub original:

1. **Subagent orchestration**: Depends on opencode/CC capabilities. May run sequentially if parallel agents not supported.

2. **Previous MR lookup**: GitLab API may require more calls than GitHub to find previous MRs by file path.

3. **Inline comments**: Original uses PR review comments on specific lines. GitLab MR notes are top-level by default. Inline discussion threads require additional API calls.

---

## Future Enhancements

- [ ] Support inline MR discussion threads (per-line comments)
- [ ] Cache CLAUDE.md parsing across reviews
- [ ] Integration with GitLab Code Quality reports
- [ ] Support for GitLab Suggestions (apply fix directly)