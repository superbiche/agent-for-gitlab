import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { scanText, scanSegments, safeSourcePath } from "../src/native-secret-scan.js";
import { riskSourcePolicy, validateRiskContext, promptBundle, validatePromptBundle } from "../src/risk-context.js";
import { buildPrompt } from "../src/review.js";
function fixture(body) {
  const root=mkdtempSync(join(tmpdir(),"scanner-test-"));
  const binary=join(root,"scanner");
  writeFileSync(binary,`#!${process.execPath}\n${body}`,{mode:0o700});
  return {root,binary,close:()=>rmSync(root,{recursive:true,force:true})};
}
test("native adapter uses offline flags, clean environment and repository-relative input",()=>{
  const f=fixture(`const fs=require('fs');const a=process.argv.slice(2); const expected=['filesystem','.','--no-verification','--no-update','--results=verified,unknown,unverified','--fail','--fail-on-scan-errors','--json','--no-color','--concurrency=4','--exclude-paths']; if(!expected.every((v,i)=>a[i]===v)||process.env.GITLAB_TOKEN||process.env.DEEPSEEK_API_KEY||!fs.existsSync('file.txt'))process.exit(2);`);
  try {assert.deepEqual(scanText("channel_id=123456", "file.txt", "", f),[]);}finally{f.close();}
});
test("missing/errors/timeouts/malformed output fail closed without raw diagnostics",()=>{
  for(const body of [`process.stderr.write('DO_NOT_EXPOSE');process.exit(2)`, `process.stdout.write('DO_NOT_EXPOSE')`, `console.log('null')`, `console.log('{}')`, `process.exit(183)`, `setTimeout(()=>{},5000)`]) {
    const f=fixture(body); try {assert.throws(()=>scanText("x","file.txt","",{...f,timeout:100}),e=>!e.message.includes("DO_NOT_EXPOSE"));}finally{f.close();}
  }
  assert.throws(()=>scanText("x","file.txt","",{binary:"/nonexistent/scanner"}),/unavailable/);
});
test("native findings return only validated metadata and reject outside paths",()=>{
  for (const file of ["file.txt","../escape"]) {
    const f=fixture(`console.log(JSON.stringify({Raw:'DO_NOT_EXPOSE',DetectorName:'Github',SourceMetadata:{Data:{Filesystem:{file:${JSON.stringify(file)},line:1}}}}));process.exit(183);`);
    try {if(file==='file.txt')assert.deepEqual(scanText("x",file,"",f),[{file,line:1,detector:"Github"}]);else assert.throws(()=>scanText("x","file.txt","",f),/invalid/);}finally{f.close();}
  }
});
test("structural guards reject unsupported paths without filename secret heuristics",()=>{
  for(const file of [".env.example","credentials.yaml","secrets.txt"])assert.equal(safeSourcePath(file),true);
  for(const file of ["../x","/x","x\n","a/*","a\\b"])assert.equal(safeSourcePath(file),false);
});
test("head snapshot excludes detected unchanged file and reads committed bytes",()=>{
  const f=fixture(`console.log(JSON.stringify({DetectorName:'Github',SourceMetadata:{Data:{Filesystem:{file:'old.txt',line:1}}}}));process.exit(183);`);
  const repo=join(f.root,"repo");mkdirSync(repo);
  const git=(...args)=>execFileSync("git",args,{cwd:repo,stdio:"pipe"});
  try {
    git("init");git("config","user.email","test@example.invalid");git("config","user.name","Test");
    writeFileSync(join(repo,"old.txt"),"fixture");writeFileSync(join(repo,"clean.js"),"committed");git("add",".");git("commit","-m","fixture");
    writeFileSync(join(repo,"clean.js"),"uncommitted");
    const policy=riskSourcePolicy(repo,f);
    try {
      assert.deepEqual(policy.allowed,["clean.js"]);assert.deepEqual(policy.excluded,["old.txt"]);
      assert.equal(readFileSync(join(policy.repo,"clean.js"),"utf8"),"committed");
      const invocation=riskInvocation({opencodeModel:'deepseek/test',sourcePolicy:policy});
      try {
        const config=JSON.parse(readFileSync(invocation.options.env.OPENCODE_CONFIG,'utf8'));
        assert.equal(config.permission.read[join(policy.repo,'clean.js').slice(1)],'allow');
        assert.equal(config.permission.read[join(repo,'clean.js').slice(1)],undefined);
        const event=JSON.stringify({type:'tool_use',part:{tool:'read',state:{status:'completed',input:{filePath:join(policy.repo,'clean.js')}}}});
        assert.deepEqual(parseRiskEvents(event,invocation.sourcePolicy,invocation.options.cwd).reads,['clean.js']);
      }finally{rmSync(invocation.isolationRoot,{recursive:true,force:true});}

      validateRiskContext({diffs:[{new_path:"clean.js",old_path:"clean.js"}]},policy);
      assert.throws(()=>validateRiskContext({diffs:[{new_path:"old.txt"}]},policy));
    }finally{policy.dispose();}
  }finally{f.close();}
});
test("typed prompt keeps source exceptions separate and contains all review fields",()=>{
  const f=fixture(`const fs=require('fs');const a=process.argv;const config=fs.readFileSync(a[a.indexOf('--exclude-paths')+1],'utf8');if(fs.existsSync('prompt.txt')&&config)process.exit(2);`);
  const policy={excluded:[],config:"^fixture.txt$"};
  const bundle=buildPrompt("find.md",{reviewProfile:"risk",reviewMode:"strict"},{mr:{title:"test",description:"body"},notes:[{body:"note"}],diffs:[{old_path:"fixture.txt",new_path:"fixture.txt",diff:"@@ -1 +1 @@\n-old\n+new"}]},{focus:"focus"});
  try {
    const rendered=validatePromptBundle(promptBundle([{kind:"prompt",text:"history\n"},...bundle.parts]),policy,f);
    for(const text of ["body","note","focus","history","-old","+new"])assert.ok(rendered.includes(text));
    assert.ok(bundle.parts.find(p=>p.kind==='source').raw[0].includes("\nold\nnew"));
    assert.throws(()=>validatePromptBundle("untyped",policy,f));
  }finally{f.close();}
});

import { runOpencode, riskInvocation, parseRiskEvents } from "../src/opencode.js";
import { renameSync, existsSync } from "node:fs";
test("native prompt refusal happens before any provider CLI process starts",async()=>{
  const f=fixture(`console.log(JSON.stringify({DetectorName:'Github',SourceMetadata:{Data:{Filesystem:{file:'prompt.txt',line:1}}}}));process.exit(183);`);
  const prior=process.env.PATH;
  try {
    renameSync(f.binary,join(f.root,'trufflehog'));
    writeFileSync(join(f.root,'opencode'),`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(join(f.root,'called'))},'called');`,{mode:0o700});
    process.env.PATH=f.root+':'+prior;
    await assert.rejects(runOpencode({reviewProfile:'risk',opencodeModel:'deepseek/test',sourcePolicy:{repo:process.cwd(),allowed:['src/review.js'],excluded:[],config:''}},promptBundle([{kind:'prompt',text:'synthetic refusal'}]),{captureOutput:true}),/TruffleHog blocked/);
    assert.equal(existsSync(join(f.root,'called')),false);
  }finally{process.env.PATH=prior;f.close();}
});

test("old/new file-directory rename paths retain separate native namespaces",()=>{
  const f=fixture("process.exit(0)");
  try {assert.deepEqual(scanSegments(new Map([['a','old'],['a/b','new']]),'',f),[]);}finally{f.close();}
});

test("failed invocation setup cleans self-owned source snapshot",()=>{
  const f=fixture('');
  const repo=join(f.root,'repo');mkdirSync(repo);
  const record=join(f.root,'snapshot-path');
  writeFileSync(f.binary,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(record)},process.cwd());`,{mode:0o700});
  renameSync(f.binary,join(f.root,'trufflehog'));
  const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
  const previous={cwd:process.cwd(),path:process.env.PATH,tmp:process.env.TMPDIR};
  try {
    git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test');
    writeFileSync(join(repo,'clean.js'),'clean');git('add','.');git('commit','-m','fixture');
    process.chdir(repo);process.env.PATH=f.root+':'+previous.path;process.env.TMPDIR=repo;
    assert.throws(()=>riskInvocation({opencodeModel:'deepseek/test'}),/outside any Git worktree/);
    assert.equal(existsSync(readFileSync(record,'utf8')),false);
  }finally{
    process.chdir(previous.cwd);process.env.PATH=previous.path;
    if(previous.tmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous.tmp;
    f.close();
  }
});


test("GitLab null modes support added/deleted regular files while blocking special modes",()=>{
  const check=(a_mode,b_mode)=>validateRiskContext({diffs:[{old_path:'file.js',new_path:'file.js',a_mode,b_mode}]},{excluded:[],findings:[]});
  for(const modes of [['0','100644'],['100644','0'],['000000','100644'],['100644','000000'],['100644','100644'],['100644','100755'],['100755','100644'],['100755','100755'],['0','100755'],['100755','0']]) assert.doesNotThrow(()=>check(...modes));
  for(const mode of ['120000','160000','100600','unsupported']) {
    assert.throws(()=>check('0',mode),/structurally excluded/);
    assert.throws(()=>check(mode,'0'),/structurally excluded/);
    assert.throws(()=>check('100644',mode),/structurally excluded/);
  }
});
