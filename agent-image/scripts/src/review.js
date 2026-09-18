import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import logger from "./logger.js";
import { riskSourcePolicy, validateRiskContext, promptBundle } from "./risk-context.js";
import { runOpencode } from "./opencode.js";
import { fetchCiEvidence } from "./ci-evidence.js";
import { loadAdapter } from "./platforms/interface.js";
import { buildGitLabPosition } from "./platforms/gitlab.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = { loose: 80, strict: 60, excessive: 40 };
const PROFILE_PASSES = {
  risk: ["B", "D", "E", "G", "H", "I"],
  quick: ["B", "C", "D"],
  standard: ["B", "C", "D", "A", "E", "G", "H"],
  thorough: ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
};

export function isReviewRequest(prompt = "") {
  return /^\s*review\b/i.test(prompt);
}

export async function runReview(context) {
  if (!context.mrIid) {
    throw new Error("@ai review only supports merge requests in this runner");
  }

  const focus = String(context.prompt || "").replace(/^\s*review\b/i, "").trim();
  const reviewData = context.dryRun ? loadDryRunData(context) : await prefetchReviewData(context);
  if (!context.dryRun && context.reviewProfile === "risk") {
    const head = reviewData.mr?.diff_refs?.head_sha;
    if (!head || (context.pipelineSha && context.pipelineSha !== head)) {
      throw new Error("MR head differs from the triggering pipeline; trigger a new review.");
    }
    execFileSync("git", ["checkout", "--detach", head], { stdio: "pipe" });
    context.sourcePolicy = riskSourcePolicy();
    try { validateRiskContext(reviewData, context.sourcePolicy); } catch (error) { context.sourcePolicy.dispose(); throw error; }
  }
  try {
    const rawFindings = context.dryRun
      ? normalizeFindings(reviewData.findings)
      : await findIssues(context, reviewData, focus);
    const scoredFindings = context.reviewScoring === "agents"
      ? context.dryRun
        ? applyScores(rawFindings, reviewData.scores, context.reviewProfile === "risk")
        : await scoreIssues(context, reviewData, rawFindings)
      : rawFindings;

    if (context.reviewProfile === "risk") {
      const metadataOnly = reviewData.diffs.filter(d => !d.diff).map(d => d.new_path || d.old_path);
      if (metadataOnly.length) scoredFindings.limitations.push(`Metadata-only diff entries (rename, mode, empty or binary): ${metadataOnly.join(", ")}`);
    }
    if (context.sourcePolicy?.excluded.length) scoredFindings.limitations.push(`Source inspection excludes ${context.sourcePolicy.excluded.length} TruffleHog-detected or structurally unsupported files.`);
    for (const file of context.sourceReadFailures || []) scoredFindings.limitations.push(`Tool-observed unsuccessful read: ${file}`);
    const threshold = THRESHOLDS[context.reviewMode] || THRESHOLDS.strict;
    const filtered = filterFindings(scoredFindings, threshold);
    const platform = await loadAdapter(context);
    const postPlan = buildPostPlan(reviewData, filtered, context, platform.buildPosition || buildGitLabPosition);

    if (context.dryRun) {
      const summary = formatSummary(context, reviewData.mr, filtered, postPlan);
      const result = { dryRun: true, threshold, postPlan, summary };
      logger.info(JSON.stringify(result, null, 2));
      return result;
    }

    if (context.reviewProfile === "risk") {
      const platform = await loadAdapter(context);
      const current = await platform.fetchMergeRequest(context);
      if (current.diff_refs?.head_sha !== reviewData.mr.diff_refs.head_sha) {
        throw new Error("MR changed during review; findings were not posted. Trigger a new review.");
      }
    }
    const posted = await postReview(context, reviewData, filtered, postPlan);
    return {
      prompt: context.prompt,
      branch: context.branch,
      review: true,
      head_sha: reviewData.mr.diff_refs?.head_sha,
      trigger_note_id: context.triggerNoteId,
      source_reads: context.verifiedSourceReads,
      issues: filtered.issues.length,
      suggestions: filtered.suggestions.length,
      posted,
    };
  } finally { context.sourcePolicy?.dispose?.(); }
}

async function prefetchReviewData(context) {
  const platform = await loadAdapter(context);
  logger.start(`Fetching ${context.platform === "github" ? "GitHub PR" : "GitLab MR"} !${context.mrIid} review context`);
  const [mr, diffs, notes, diffStatus] = await Promise.all([
    platform.fetchMergeRequest(context),
    platform.fetchMergeRequestDiffs(context),
    platform.fetchMergeRequestNotes(context),
    context.reviewProfile === "risk" ? platform.fetchMergeRequestDiffStatus(context) : null,
  ]);
  if (context.reviewProfile === "risk") validateReviewDiffs(mr, diffs, diffStatus);
  const ciEvidence = context.reviewProfile === "risk" ? await fetchCiEvidence(context, mr.diff_refs.head_sha) : undefined;
  return { mr, diffs, notes, ciEvidence };
}

async function findIssues(context, reviewData, focus) {
  const prompt = buildPrompt("find.md", context, reviewData, {
    focus,
    outputPath: "/tmp/review-findings.json",
  });
  const parsed = await runJsonOpencode(context, prompt, "/tmp/review-findings.json", "findings");
  if (context.reviewProfile === "risk") validateRiskFindings(parsed);
  return normalizeFindings(parsed);
}

async function scoreIssues(context, reviewData, findings) {
  if (!findings.issues.length) return findings;
  const prompt = buildPrompt("score.md", context, reviewData, {
    findings,
    outputPath: "/tmp/review-scores.json",
  });
  const scores = await runJsonOpencode(context, prompt, "/tmp/review-scores.json", "scores");
  return applyScores(findings, scores, context.reviewProfile === "risk");
}

async function runJsonOpencode(context, prompt, filePath, label) {
  rmSync(filePath, { force: true });
  let output = await runOpencode(context, prompt, { captureOutput: true });
  try {
    return parseModelJson(output, filePath, label);
  } catch (error) {
    logger.warn(`${label} JSON was malformed; retrying once: ${error.message}`);
  }

  rmSync(filePath, { force: true });
  output = await runOpencode(
    context,
    context.reviewProfile === "risk" ? promptBundle([...prompt.parts, {kind:"prompt", text:`\nYour previous ${label} output was malformed. Return only valid JSON matching the requested schema. Also write the same JSON to ${filePath}.`}]) : `${prompt}\n\n---\nYour previous ${label} output was malformed. Return only valid JSON matching the requested schema. Also write the same JSON to ${filePath}.`,
    { captureOutput: true },
  );
  return parseModelJson(output, filePath, label);
}

export function buildPrompt(name, context, reviewData, extras) {
  const template = readPrompt(context.reviewProfile === "risk" ? `risk-${name}` : name);
  if (context.reviewProfile === "risk") {
    const metadata = { project_id: context.projectId, project_path: context.projectPath, mr_iid: context.mrIid,
      mode: context.reviewMode, profile: context.reviewProfile, scoring: context.reviewScoring, lang: context.reviewLang,
      audience: context.reviewAudience, threshold: THRESHOLDS[context.reviewMode] || THRESHOLDS.strict,
      passes: PROFILE_PASSES.risk, mr: reviewData.mr, notes: reviewData.notes, ci_evidence: reviewData.ciEvidence, ...extras };
    const strings = value => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
    const parts = [{kind:"prompt", text: `${template}\n\n## Runner-provided GitLab context\n${JSON.stringify(metadata, null, 2)}\n`, raw:strings(metadata)}];
    for (const diff of reviewData.diffs) {
      const {diff: patch = "", ...metadata} = diff;
      parts.push({kind:"prompt", text:`\nDiff metadata: ${JSON.stringify(metadata)}\n`, raw:strings(metadata)});
      parts.push({kind:"source", paths:Object.freeze([...new Set([diff.old_path,diff.new_path].filter(Boolean))]), text:patch + "\n", raw:[patch.replace(/^[ +\-]/gm, "")]});
    }
    return promptBundle(parts);
  }
  return `${template}

---
## Runner-provided GitLab context

${JSON.stringify({
    project_id: context.projectId,
    project_path: context.projectPath,
    mr_iid: context.mrIid,
    mode: context.reviewMode,
    profile: context.reviewProfile,
    scoring: context.reviewScoring,
    lang: context.reviewLang,
    audience: context.reviewAudience,
    threshold: THRESHOLDS[context.reviewMode] || THRESHOLDS.strict,
    passes: PROFILE_PASSES[context.reviewProfile] || PROFILE_PASSES.standard,
    mr: reviewData.mr,
    diffs: reviewData.diffs,
    notes: reviewData.notes,
    ...extras,
  }, null, 2)}
`;
}

function readPrompt(name) {
  const candidates = [
    resolve(__dirname, "..", "prompts", "review", name),
    resolve(__dirname, "..", "..", "..", "prompts", "review", name),
    resolve(process.cwd(), "prompts", "review", name),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(`Missing review prompt ${name}; checked ${candidates.join(", ")}`);
  }
  return readFileSync(path, "utf8");
}

function parseModelJson(output, filePath, label) {
  if (existsSync(filePath)) {
    try { return JSON.parse(readFileSync(filePath, "utf8")); } catch { throw new Error(`Malformed ${label} JSON; raw output suppressed.`); }
  }

  try {
    return JSON.parse(output);
  } catch {
    const match = output.match(/```json\s*([\s\S]*?)```/i) || output.match(/({[\s\S]*})/);
    if (match) { try { return JSON.parse(match[1]); } catch { throw new Error(`Malformed ${label} JSON; raw output suppressed.`); } }
  }

  throw new Error(`Could not parse ${label} JSON from opencode output`);
}

function normalizeFindings(input) {
  const source = Array.isArray(input) ? { issues: input } : input || {};
  const issues = (source.issues || source.findings || []).map((finding, index) => ({
    id: String(finding.id || index + 1),
    file: finding.file || finding.path || finding.new_path,
    line_start: numberOrNull(finding.line_start ?? finding.line ?? finding.new_line),
    line_end: numberOrNull(finding.line_end),
    old_line: numberOrNull(finding.old_line),
    category: finding.category || finding.pass || "B",
    severity_hint: finding.severity_hint || finding.severity || "",
    title: finding.title || "Review finding",
    description: finding.description || finding.body || "",
    evidence: finding.evidence || "",
    suggestion: finding.suggestion || "",
    confidence: clampConfidence(finding.confidence),
    confidence_reason: finding.confidence_reason || finding.reason || "",
  })).filter((finding) => finding.file && finding.line_start && finding.title);

  const suggestions = (source.suggestions || []).map((suggestion) => ({
    file: suggestion.file || suggestion.path || "",
    line: numberOrNull(suggestion.line ?? suggestion.line_start),
    title: suggestion.title || "Suggestion",
    description: suggestion.description || suggestion.suggestion || "",
  })).filter((suggestion) => suggestion.file || suggestion.description);

  const strengths = Array.isArray(source.strengths) ? source.strengths.filter(Boolean) : [];
  return { issues, suggestions, strengths, inspected: source.inspected || [], limitations: source.limitations || [] };
}

export function applyScores(findings, scoreInput, requireComplete = false) {
  const scoreList = Array.isArray(scoreInput) ? scoreInput : scoreInput?.scores || [];
  if (requireComplete && (!Array.isArray(scoreInput?.scores) || scoreList.length !== findings.issues.length || new Set(scoreList.map(s => s.id)).size !== findings.issues.length || scoreList.some(s => !findings.issues.some(f => f.id === s.id) || !Number.isFinite(s.confidence) || s.confidence < 0 || s.confidence > 100))) {
    throw new Error("SCORE must return one valid score for every candidate; refusing unverified findings.");
  }
  const scoresById = new Map(scoreList.map((score, index) => [
    String(score.id || score.finding_id || index + 1),
    score,
  ]));

  return {
    ...findings,
    issues: findings.issues.map((finding, index) => {
      const score = scoresById.get(finding.id) || scoresById.get(String(index + 1));
      if (!score) return finding;
      return {
        ...finding,
        confidence: clampConfidence(score.confidence),
        confidence_reason: score.reason || score.confidence_reason || finding.confidence_reason,
      };
    }),
  };
}

function filterFindings(findings, threshold) {
  return {
    ...findings,
    issues: findings.issues.filter((finding) => finding.confidence >= threshold),
  };
}

function buildPostPlan(reviewData, findings, context, buildPosition) {
  const diffRefs = reviewData.mr?.diff_refs || {};
  return findings.issues.map((finding, index) => {
    const position = buildPosition(reviewData.diffs, finding, diffRefs);
    return {
      index,
      file: finding.file,
      line: finding.line_start,
      inline: Boolean(position),
      position,
      body: formatInlineComment(finding, context),
    };
  });
}

async function postReview(context, reviewData, findings, postPlan) {
  const platform = await loadAdapter(context);
  const noteLinks = [];
  for (const plan of postPlan) {
    let response = null;
    try {
      if (plan.position) {
        response = await platform.postMergeRequestDiscussion(context, context.mrIid, plan.body, plan.position);
      }
    } catch (error) {
      logger.warn(`Inline note failed for ${plan.file}:L${plan.line}; falling back to MR note: ${error.message}`);
    }

    if (!response) {
      response = await platform.postMergeRequestNote(context, context.mrIid, `${plan.body}\n\n${plan.file}:L${plan.line}`);
    }

    const noteId = response?.notes?.[0]?.id || response?.id;
    if (noteId) noteLinks.push({ index: plan.index, noteId });
  }

  const summary = formatSummary(context, reviewData.mr, findings, postPlan, noteLinks);
  const summaryResponse = await platform.postMergeRequestNote(context, context.mrIid, summary);
  return {
    inline_or_fallback_notes: noteLinks.length,
    summary_note_id: summaryResponse?.id,
  };
}

export function buildDiffPosition(diffs, finding, diffRefs, context = { platform: "gitlab" }) {
  // Synchronous: pure line-mapping, no I/O. The async loadAdapter seam is
  // used for fetch/post paths; position mapping dispatches on platform here
  // so the GitHub adapter can slot in next slice without touching callers.
  if ((context.platform || "gitlab") === "github") {
    throw new Error("GitHub platform adapter is not implemented yet");
  }
  return buildGitLabPosition(diffs, finding, diffRefs);
}

function formatInlineComment(finding, context) {
  if (context.reviewProfile === "risk") return `**${finding.severity_hint}: ${finding.title}** (confidence ${finding.confidence}/100)\n\n${finding.description}\n\n**Evidence:** ${finding.evidence}\n\n**Proposed remedy:** ${finding.suggestion}\n\n-- ${context.opencodeModel}`;
  const emoji = tierFor(finding.confidence).emoji;
  const evidence = finding.evidence ? `\n\n**Evidence**: ${finding.evidence}` : "";
  return `${emoji} **${finding.title}** (Confidence: ${finding.confidence}/100)

${finding.description}${evidence}

**Suggestion**: ${finding.suggestion || "No concrete suggestion provided."}`;
}

function formatSummary(context, mr, findings, postPlan, noteLinks = []) {
  if (context.reviewProfile === "risk") return formatRiskSummary(context, mr, findings, postPlan, noteLinks);
  const threshold = THRESHOLDS[context.reviewMode] || THRESHOLDS.strict;
  const author = mr?.author?.username || context.author || "author";
  const intro = introLine(context, author);
  const lines = [
    `## Review: ${mr?.title || `MR !${context.mrIid}`}`,
    "",
    `Mode: ${context.reviewMode} (threshold: ${threshold}) | Profile: ${context.reviewProfile} | Scoring: ${context.reviewScoring}`,
    "",
    intro,
    "",
  ];

  if (findings.issues.length) {
    lines.push(`**Found ${findings.issues.length} issue(s):**`, "");
    for (const tier of visibleTiers(context.reviewMode)) {
      const tierIssues = findings.issues.filter((finding) => tierFor(finding.confidence).name === tier.name);
      if (!tierIssues.length) continue;
      lines.push(`### ${tier.emoji} ${tier.label}`, "");
      tierIssues.forEach((finding, index) => {
        const link = linkForFinding(finding, postPlan, noteLinks);
        lines.push(`${index + 1}. **${finding.title}** -- ${link}`);
        lines.push("");
        lines.push(`   ${finding.description} | Confidence: ${finding.confidence}/100`);
        if (finding.evidence) lines.push("", `   **Evidence**: ${finding.evidence}`);
        lines.push("", `   **Suggestion**: ${finding.suggestion || "No concrete suggestion provided."}`, "");
      });
    }
  } else {
    lines.push("No issues found above threshold.", "", "Checked for:");
    for (const pass of PROFILE_PASSES[context.reviewProfile] || PROFILE_PASSES.standard) {
      lines.push(`- Pass ${pass}`);
    }
    lines.push("");
  }

  if (findings.suggestions.length) {
    lines.push("---", "## Suggestions (non-blocking)", "", "These are optional improvements, not required for merge:", "");
    for (const suggestion of findings.suggestions) {
      const loc = suggestion.line ? `${suggestion.file}:L${suggestion.line}` : suggestion.file;
      lines.push(`- **${loc}**: ${suggestion.description}`);
    }
    lines.push("");
  }

  if (shouldShowStrengths(context, findings.strengths)) {
    lines.push("---", "## Strengths", "");
    const strengths = findings.strengths.length ? findings.strengths : ["Thanks for keeping the change focused."];
    for (const strength of strengths.slice(0, 4)) lines.push(`- ${strength}`);
  }

  return lines.join("\n").trim();
}

function linkForFinding(finding, postPlan, noteLinks) {
  const plan = postPlan.find((item) => item.file === finding.file && item.line === finding.line_start);
  const note = plan && noteLinks.find((item) => item.index === plan.index);
  const label = `${finding.file}:L${finding.line_start}${finding.line_end ? `-L${finding.line_end}` : ""}`;
  return note ? `[${label}](#note_${note.noteId})` : `\`${label}\``;
}

function introLine(context, author) {
  if (context.reviewLang === "fr") {
    if (context.reviewAudience === "self") return "Revue automatique de la MR :";
    if (context.reviewAudience === "oss") return `@${author} merci pour cette contribution. Voici la revue automatique :`;
    return `@${author} voici la revue automatique de ta MR :`;
  }
  if (context.reviewAudience === "self") return "Automated MR review:";
  if (context.reviewAudience === "oss") return `@${author} thanks for this contribution! Here's the automated review:`;
  return `@${author} here's the automated review for your MR:`;
}

function shouldShowStrengths(context, strengths) {
  return context.reviewAudience === "oss" || strengths.length > 0;
}

function visibleTiers(mode) {
  return [
    { name: "critical", emoji: "🔴", label: "Critical (confidence 90+)" },
    { name: "important", emoji: "🟠", label: "Important (confidence 80-89)" },
    { name: "noteworthy", emoji: "🟡", label: "Noteworthy (confidence 60-79)" },
    ...(mode === "excessive" ? [{ name: "minor", emoji: "🔵", label: "Minor (confidence 40-59)" }] : []),
  ];
}

function tierFor(confidence) {
  if (confidence >= 90) return { name: "critical", emoji: "🔴" };
  if (confidence >= 80) return { name: "important", emoji: "🟠" };
  if (confidence >= 60) return { name: "noteworthy", emoji: "🟡" };
  return { name: "minor", emoji: "🔵" };
}

function loadDryRunData(context) {
  const fixtureDir = resolve(__dirname, "..", "test", "fixtures");
  const mr = readFixture(context.dryRunFixtures.mr, join(fixtureDir, "mr.json"));
  const diffs = readFixture(context.dryRunFixtures.diffs, join(fixtureDir, "diffs.json"));
  const findings = readFixture(context.dryRunFixtures.findings, join(fixtureDir, context.reviewProfile === "risk" ? "risk-findings.json" : "findings.json"));
  const scores = context.dryRunFixtures.scores && existsSync(context.dryRunFixtures.scores)
    ? readFixture(context.dryRunFixtures.scores)
    : context.reviewProfile === "risk" ? readFixture(null, join(fixtureDir, "risk-scores.json")) : null;
  return { mr, diffs, notes: [], findings, scores };
}

function readFixture(primary, fallback) {
  const path = primary || fallback;
  if (!path || !existsSync(path)) {
    throw new Error(`Missing dry-run fixture: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

export function validateRiskFindings(value) {
  if (!value || !Array.isArray(value.issues) || !Array.isArray(value.inspected) || !value.inspected.length || !Array.isArray(value.limitations)) throw new Error("Risk review requires issues, inspected surfaces and limitations arrays.");
  const ids = new Set();
  for (const f of value.issues) {
    if (!f || typeof f.id !== "string" || ids.has(f.id) || !f.file || !Number.isInteger(f.line_start) || f.line_start < 1 || !["P1", "P2", "P3"].includes(f.severity_hint) || !f.title || !f.description || !f.evidence || !f.suggestion || !Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 100) throw new Error("Risk review returned an incomplete finding.");
    ids.add(f.id);
  }
}

function formatRiskSummary(context, mr, findings, postPlan, noteLinks) {
  const lines = ["## AI risk review", "", `Reviewed head: \`${mr.diff_refs?.head_sha}\``, `Trigger note: ${context.triggerNoteId || "unavailable"}`, `Pipeline: ${context.pipelineUrl || "unavailable"}`, `Model: ${context.opencodeModel} | Confidence threshold: ${THRESHOLDS[context.reviewMode]} | Scoring: ${context.reviewScoring}`, ""];
  lines.push(findings.issues.length ? `**${findings.issues.length} finding(s) to triage.**` : "**No findings above the confidence threshold. This is not merge approval.**", "");
  for (const f of findings.issues) lines.push(`- **${f.severity_hint}: ${f.title}** — ${linkForFinding(f, postPlan, noteLinks)} (confidence ${f.confidence}/100)`);
  lines.push("", "### Inspected (model-reported)", "", ...findings.inspected.map(s => `- ${s}`));
  lines.push("", "### Tool-verified source reads", "", ...(context.verifiedSourceReads?.length ? context.verifiedSourceReads.map(s => `- ${s}`) : ["- Dry-run fixture; no live source reads."]));
  if (context.investigationEvidence?.length) {
    lines.push("", "### Tool-verified investigation", "", ...context.investigationEvidence.map(e => e.type === "search"
      ? `- Source search ${JSON.stringify(e.text)} in ${JSON.stringify(e.path || "/")}: ${e.matches} matches, ${e.files_scanned} files inspected${e.truncated ? "; truncated, pagination required" : ""}.`
      : `- Public source: ${e.url} (SHA-256 ${e.sha256}, ${e.bytes} bytes).`));
  }
  lines.push("", "### Limitations", "", ...(findings.limitations.length ? findings.limitations.map(s => `- ${s}`) : ["- Static review; no runtime verification unless explicitly evidenced above."]));
  lines.push("", "Severity describes impact; confidence describes certainty. Verify each finding and its remedy against the deployed path before fixing. Architectural changes require operator ruling.", "", `-- ${context.opencodeModel}`);
  return lines.join("\n");
}

export function validateReviewDiffs(mr, diffs, diffStatus) {
  if (!mr.diff_refs?.head_sha || diffStatus?.overflow !== false || diffs.some(d => d.too_large || d.collapsed)) throw new Error("Incomplete GitLab diff context; review cannot claim completion.");
}
