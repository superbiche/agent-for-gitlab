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
