import test from "node:test";
import assert from "node:assert/strict";
import { applyScores, validateRiskFindings } from "../src/review.js";
import { fetchMergeRequestDiffs, fetchMergeRequestNotes } from "../src/gitlab.js";
const finding = { id: "f1", file: "a.js", line_start: 1, severity_hint: "P2", title: "Defect", description: "Trigger causes loss", evidence: "INFERRED a.js:1", suggestion: "Restore validation", confidence: 95 };
test("risk result cannot silently accept malformed or unscoped output", () => {
  for (const input of [{}, {issues:[],inspected:[],limitations:[]}, {issues:[{...finding,evidence:""}],inspected:["a.js"],limitations:[]}]) assert.throws(()=>validateRiskFindings(input));
  validateRiskFindings({issues:[],inspected:["a.js:1 caller contract"],limitations:["Static only"]});
});
test("independent scoring refuses missing, duplicated and foreign scores", () => {
  for (const scores of [[], [{id:"other",confidence:95}], [{id:"f1",confidence:95},{id:"f1",confidence:95}], [{id:"f1",confidence:"95"}]]) assert.throws(()=>applyScores({issues:[finding]},{scores},true));
  assert.equal(applyScores({issues:[finding]},{scores:[{id:"f1",confidence:0,reason:"Disproved by caller"}]},true).issues[0].confidence,0);
});
test("review context paginates diffs and notes instead of silently reviewing only page one", async () => {
  const original=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async url=> { requests.push(String(url)); return new Response(JSON.stringify(new URL(url).searchParams.get("page")==="1" ? Array.from({length:100},(_,id)=>({id})) : [{id:100}])); };
  try {
    const context={serverUrl:"https://gitlab.example",projectId:7,mrIid:1};
    assert.equal((await fetchMergeRequestDiffs(context)).length,101);
    assert.equal((await fetchMergeRequestNotes(context)).length,101);
    assert.equal(requests.length,4);
  } finally { globalThis.fetch=original; }
});

import { credentialMaterial, validateRiskContext } from "../src/risk-context.js";
test("credential-bearing infrastructure and discussions never enter external review context", () => {
  assert.equal(credentialMaterial("+kind: Secret\n+data:\n+  value: ZXhhbXBsZQ=="), true);
  assert.equal(credentialMaterial("kind: Deployment\nsecretKeyRef:\n  name: existing"), false);
  const data={mr:{},notes:[],diffs:[{new_path:"all.yaml",diff:"+kind: Secret"}]};
  assert.throws(()=>validateRiskContext(data,{excluded:[]}));
  assert.throws(()=>validateRiskContext({...data,diffs:[],notes:[{body:"-----BEGIN PRIVATE KEY-----"}]},{excluded:[]}));
});

import { riskInvocation } from "../src/opencode.js";
import { readFileSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
test("risk permissions match OpenCode worktree-relative reads and deny commands/untracked files", () => {
  const invocation=riskInvocation({opencodeModel:"deepseek/deepseek-v4-flash"});
  try {
    const config=JSON.parse(readFileSync(invocation.options.env.OPENCODE_CONFIG,"utf8"));
    const key=relative(invocation.options.cwd,resolve("src/review.js"));
    assert.equal(config.permission.read[key],"allow");
    assert.equal(config.permission.read["*"],"deny");
    assert.equal(config.permission["*"],"deny");
    assert.equal(config.permission.edit[relative(invocation.options.cwd,"/tmp/review-findings.json")],"allow");
    assert.equal(invocation.options.env.GITLAB_TOKEN,undefined);
  } finally {rmSync(invocation.options.cwd,{recursive:true,force:true});}
});
