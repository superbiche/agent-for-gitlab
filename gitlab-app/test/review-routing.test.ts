import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
const approvedCI = "verified review-only router";
process.env.REVIEW_CI_CONFIG_SHA256 = createHash("sha256").update(approvedCI).digest("hex");
process.env.GITLAB_URL="https://gitlab.test";
process.env.GITLAB_TOKEN="test-token";
process.env.WEBHOOK_SECRET="test-secret";
process.env.REVIEW_ONLY="true";
process.env.RATE_LIMITING_ENABLED="false";
process.env.AI_GITLAB_USERNAME="ai";
process.env.LOG_LEVEL="error";
const {default:app}=await import("../src/index");
const payload=(note:string,mr=true)=>({object_kind:"note",project:{id:7,path_with_namespace:"group/repo"},user:{username:"operator"},object_attributes:{id:123,note,discussion_id:"thread"},...(mr?{merge_request:{iid:4,source_branch:"feature"}}:{issue:{iid:2,title:"issue"}})});
const post=(body:any,secret="test-secret")=>app.fetch(new Request("http://localhost/webhook",{method:"POST",headers:{"content-type":"application/json","x-gitlab-event":"Note Hook","x-gitlab-token":secret},body:JSON.stringify(body)}));
test("rejects missing webhook secret and generic/issue requests before external calls",async()=>{
 expect((await post(payload("@ai review"),"wrong")).status).toBe(401);
 const secret=process.env.WEBHOOK_SECRET; delete process.env.WEBHOOK_SECRET;
 expect((await post(payload("@ai review"))).status).toBe(401);
 process.env.WEBHOOK_SECRET=secret;
 for (const b of [payload("@ai fix this"),payload("@ai review",false)]) expect(await (await post(b)).text()).toContain("review-only");
});
test("thread review preserves command and trigger note identity",async()=>{
 const original=globalThis.fetch;
 let submitted:any;
 globalThis.fetch=(async (input:any,init:any)=>{
  const url=String(input);
  if (url.endsWith("/projects/7")) return Response.json({ci_config_path:".gitlab-ci.yml"});
  if (url.includes("/repository/files/")) return new Response(approvedCI);
  if (url.endsWith("/discussions/thread")) return Response.json({notes:[{id:1,body:"Earlier conversation",author:{username:"operator"}},{id:123,body:"@ai review",author:{username:"operator"}}]});
  if(url.endsWith("/pipeline")){submitted=JSON.parse(init.body);return Response.json({id:9,web_url:"https://gitlab.test/p/9"});}
  return Response.json({id:10});
 }) as typeof fetch;
 try {
  expect((await post(payload("@ai REVIEW retry handling"))).status).toBe(200);
  const vars=Object.fromEntries(submitted.variables.map((v:any)=>[v.key,v.value]));
  expect(vars.DIRECT_PROMPT).toBe("REVIEW retry handling");expect(vars.AI_TRIGGER_NOTE_ID).toBe("123");
 }finally{globalThis.fetch=original;}
});
test("unenrolled and changed CI are refused before a pipeline is created",async()=>{
 const original=globalThis.fetch;
 const calls:string[]=[];
 globalThis.fetch=(async(input:any,init:any)=>{
  const url=String(input);calls.push(url);
  if(url.endsWith("/projects/7"))return Response.json({});
  if(url.includes("/repository/files/"))return new Response("ordinary deployment pipeline");
  return Response.json({id:12});
 }) as typeof fetch;
 try {
  const result=await (await post(payload("@ai review"))).json() as any;
  expect(result.status).toBe("refused");
  expect(calls.some(url=>url.endsWith("/pipeline"))).toBe(false);
  expect(calls.some(url=>url.endsWith("/notes"))).toBe(true);
 }finally{globalThis.fetch=original;}
});
