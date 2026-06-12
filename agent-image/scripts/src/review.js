import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import logger from "./logger.js";
import { runOpencode } from "./opencode.js";
import {
  fetchMergeRequest,
  fetchMergeRequestDiffs,
  fetchMergeRequestNotes,
  postMergeRequestDiscussion,
  postMergeRequestNote,
} from "./gitlab.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = { loose: 80, strict: 60, excessive: 40 };
const PROFILE_PASSES = {
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
  const rawFindings = context.dryRun
    ? normalizeFindings(reviewData.findings)
    : await findIssues(context, reviewData, focus);
  const scoredFindings = context.reviewScoring === "agents"
    ? context.dryRun
      ? applyScores(rawFindings, reviewData.scores)
      : await scoreIssues(context, reviewData, rawFindings)
    : rawFindings;

  const threshold = THRESHOLDS[context.reviewMode] || THRESHOLDS.strict;
  const filtered = filterFindings(scoredFindings, threshold);
  const postPlan = buildPostPlan(context, reviewData, filtered);

  if (context.dryRun) {
    const summary = formatSummary(context, reviewData.mr, filtered, postPlan);
    const result = { dryRun: true, threshold, postPlan, summary };
    logger.info(JSON.stringify(result, null, 2));
    return result;
  }

  const posted = await postReview(context, reviewData, filtered, postPlan);
  return {
    prompt: context.prompt,
    branch: context.branch,
    review: true,
    issues: filtered.issues.length,
    suggestions: filtered.suggestions.length,
    posted,
  };
}

async function prefetchReviewData(context) {
  logger.start(`Fetching GitLab MR !${context.mrIid} review context`);
  const [mr, diffs, notes] = await Promise.all([
    fetchMergeRequest(context),
    fetchMergeRequestDiffs(context),
    fetchMergeRequestNotes(context),
  ]);
  return { mr, diffs, notes };
}

async function findIssues(context, reviewData, focus) {
  const prompt = buildPrompt("find.md", context, reviewData, {
    focus,
    outputPath: "/tmp/review-findings.json",
  });
  const parsed = await runJsonOpencode(context, prompt, "/tmp/review-findings.json", "findings");
  return normalizeFindings(parsed);
}

async function scoreIssues(context, reviewData, findings) {
  if (!findings.issues.length) return findings;
  const prompt = buildPrompt("score.md", context, reviewData, {
    findings,
    outputPath: "/tmp/review-scores.json",
  });
  const scores = await runJsonOpencode(context, prompt, "/tmp/review-scores.json", "scores");
  return applyScores(findings, scores);
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
    `${prompt}

---
Your previous ${label} output was malformed. Return only valid JSON matching the requested schema. Also write the same JSON to ${filePath}.`,
    { captureOutput: true },
  );
  return parseModelJson(output, filePath, label);
}

function buildPrompt(name, context, reviewData, extras) {
  const template = readPrompt(name);
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
    return JSON.parse(readFileSync(filePath, "utf8"));
  }

  try {
    return JSON.parse(output);
  } catch {
    const match = output.match(/```json\s*([\s\S]*?)```/i) || output.match(/({[\s\S]*})/);
    if (match) return JSON.parse(match[1]);
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
  return { issues, suggestions, strengths };
}

function applyScores(findings, scoreInput) {
  const scoreList = Array.isArray(scoreInput) ? scoreInput : scoreInput?.scores || [];
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

function buildPostPlan(context, reviewData, findings) {
  const diffRefs = reviewData.mr?.diff_refs || {};
  return findings.issues.map((finding, index) => {
    const position = buildDiffPosition(reviewData.diffs, finding, diffRefs);
    return {
      index,
      file: finding.file,
      line: finding.line_start,
      inline: Boolean(position),
      position,
      body: formatInlineComment(finding),
    };
  });
}

async function postReview(context, reviewData, findings, postPlan) {
  const noteLinks = [];
  for (const plan of postPlan) {
    let response = null;
    try {
      if (plan.position) {
        response = await postMergeRequestDiscussion(context, context.mrIid, plan.body, plan.position);
      }
    } catch (error) {
      logger.warn(`Inline note failed for ${plan.file}:L${plan.line}; falling back to MR note: ${error.message}`);
    }

    if (!response) {
      response = await postMergeRequestNote(context, context.mrIid, `${plan.body}\n\n${plan.file}:L${plan.line}`);
    }

    const noteId = response?.notes?.[0]?.id || response?.id;
    if (noteId) noteLinks.push({ index: plan.index, noteId });
  }

  const summary = formatSummary(context, reviewData.mr, findings, postPlan, noteLinks);
  const summaryResponse = await postMergeRequestNote(context, context.mrIid, summary);
  return {
    inline_or_fallback_notes: noteLinks.length,
    summary_note_id: summaryResponse?.id,
  };
}

export function buildDiffPosition(diffs, finding, diffRefs) {
  const diff = (diffs || []).find((candidate) => {
    return candidate.new_path === finding.file || candidate.old_path === finding.file;
  });
  if (!diff || !diff.diff || !diffRefs?.base_sha || !diffRefs?.head_sha || !diffRefs?.start_sha) {
    return null;
  }

  const line = findLineInPatch(diff.diff, finding);
  if (!line) return null;

  const position = {
    position_type: "text",
    base_sha: diffRefs.base_sha,
    head_sha: diffRefs.head_sha,
    start_sha: diffRefs.start_sha,
    old_path: diff.old_path || finding.file,
    new_path: diff.new_path || finding.file,
  };

  if (line.old_line) position.old_line = line.old_line;
  if (line.new_line) position.new_line = line.new_line;
  return position;
}

function findLineInPatch(patch, finding) {
  let oldLine = 0;
  let newLine = 0;
  const targetNew = numberOrNull(finding.line_start);
  const targetOld = numberOrNull(finding.old_line);

  for (const rawLine of patch.split("\n")) {
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (!rawLine || rawLine.startsWith("\\ No newline")) continue;
    const prefix = rawLine[0];

    if (prefix === "+") {
      if (newLine === targetNew) return { new_line: newLine };
      newLine += 1;
      continue;
    }

    if (prefix === "-") {
      if (targetOld && oldLine === targetOld) return { old_line: oldLine };
      oldLine += 1;
      continue;
    }

    if ((targetOld && oldLine === targetOld) || newLine === targetNew) {
      return { old_line: oldLine, new_line: newLine };
    }
    oldLine += 1;
    newLine += 1;
  }

  return null;
}

function formatInlineComment(finding) {
  const emoji = tierFor(finding.confidence).emoji;
  const evidence = finding.evidence ? `\n\n**Evidence**: ${finding.evidence}` : "";
  return `${emoji} **${finding.title}** (Confidence: ${finding.confidence}/100)

${finding.description}${evidence}

**Suggestion**: ${finding.suggestion || "No concrete suggestion provided."}`;
}

function formatSummary(context, mr, findings, postPlan, noteLinks = []) {
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
  const findings = readFixture(context.dryRunFixtures.findings, join(fixtureDir, "findings.json"));
  const scores = context.dryRunFixtures.scores && existsSync(context.dryRunFixtures.scores)
    ? readFixture(context.dryRunFixtures.scores)
    : null;
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
