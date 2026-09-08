// Required offline native integration; intentionally outside node --test so CI unit
// runners without the image binary do not silently skip this separate gate.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { scanText } from "../src/native-secret-scan.js";
import { promptBundle, validatePromptBundle } from "../src/risk-context.js";
const token = 'ghp_' + randomBytes(18).toString('hex');
const options={binary:process.env.NATIVE_SCANNER || 'trufflehog'};
const policy={excluded:[],config:'^fixture.txt$\n'};
function blocked(fn){let failed=false;try{fn();}catch(error){failed=true;assert.ok(!error.message.includes(token));}assert.equal(failed,true);}
assert.deepEqual(scanText('CLICKUP_CHANNEL_ID=90123456\nAPI_KEY=\n','.env.example','',options),[]);
assert.ok(scanText(`token=${token}\n`,'fixture.txt','',options).length>0);
assert.deepEqual(scanText(`token=${token}\n`,'fixture.txt',policy.config,options),[]);
blocked(()=>scanText('clean','fixture.txt','[',options));
const diff={kind:'source',paths:['fixture.txt'],text:`@@ -1 +0 @@\n-${token}\n`,raw:[token]};
const prompt={kind:'prompt',text:'Review this patch.\n'};
assert.ok(validatePromptBundle(promptBundle([prompt,diff]),policy,options).includes(token));
blocked(()=>validatePromptBundle(promptBundle([prompt,diff]),{...policy,config:''},options));
for(const surface of ['MR description','note','focus','history','SCORE candidate','retry']){
 blocked(()=>validatePromptBundle(promptBundle([{kind:'prompt',text:`${surface}: ${token}\n`},diff]),policy,options));
}
console.log('Native policy: harmless IDs, real detection, anchored exception, malformed config, removed line, source-versus-prompt provenance PASS; no token values logged.');

import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { riskSourcePolicy, validateRiskContext } from '../src/risk-context.js';
const repo=mkdtempSync(join(tmpdir(),'native-policy-repo-'));
const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
try {
 git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test');
 writeFileSync(join(repo,'old.txt'),`token=${token}\n`);writeFileSync(join(repo,'.env.example'),'CLICKUP_CHANNEL_ID=90123456\n');
 git('add','.');git('commit','-m','synthetic fixture');
 writeFileSync(join(repo,'.env.example'),`token=${token}\n`);
 const snapshot=riskSourcePolicy(repo,options);
 try {
  assert.ok(snapshot.excluded.includes('old.txt'));assert.ok(snapshot.allowed.includes('.env.example'));
  assert.ok(readFileSync(join(snapshot.repo,'.env.example'),'utf8') === 'CLICKUP_CHANNEL_ID=90123456\n');
  validateRiskContext({diffs:[{old_path:'.env.example',new_path:'.env.example'}]},snapshot);
  blocked(()=>validateRiskContext({diffs:[{old_path:'old.txt',new_path:'old.txt'}]},snapshot));
 }finally{snapshot.dispose();}
 symlinkSync('old.txt',join(repo,'.trufflehog-exclude-paths'));git('add','.trufflehog-exclude-paths');git('commit','-m','synthetic configuration type');
 blocked(()=>riskSourcePolicy(repo,options));
}finally{rmSync(repo,{recursive:true,force:true});}
console.log('Native committed snapshot, unchanged detection, changed exclusion and symlink-config rejection PASS.');
