import {state,refresh,submit} from '../lib/service.js';
import {AppError,isoNow,listEvents} from '../lib/store.js';
import {executeDecision} from '../lib/execution.js';
import {reconcile} from '../lib/reconciliation.js';
import {validateWriteRequest} from '../lib/request-security.js';
import {assets} from './assets.generated.js';
const schemaRecord={type:'object',additionalProperties:false,required:['idempotency_key','kind','payload'],properties:{idempotency_key:{type:'string',minLength:8,maxLength:160},kind:{enum:['research','challenge','decision','revision','verification']},payload:{type:'object',description:'Authored summary, never private chain of thought. Requires title, summary, author. Research/challenge/decision additionally role, evidence [{title,url,observed_at,excerpt}], snapshot_ids. Research/decision: thesis,horizon,uncertainties,change_mind. Challenge: research_id,counterargument. Decision: research_id,challenge_id,action (hold/buy/sell),size USD,symbol for buy/sell,challenge_response. Revision: supersedes. Distinct authors for each role.'}}};
const toolDefs=[
{name:'portfolio_state',description:'Read the paused Blue Capital experiment, latest actual IEX observations, immutable journal, mandate and health. Optionally replay knowledge as of a UTC time.',inputSchema:{type:'object',properties:{as_of:{type:'string'}},additionalProperties:false}},
{name:'refresh_market',description:'Fetch Alpaca paper account and AAPL/MSFT/SPY IEX observations into persistent storage. No trade. Use a stable idempotency key for retries.',inputSchema:{type:'object',required:['idempotency_key'],properties:{idempotency_key:{type:'string'}},additionalProperties:false}},
{name:'submit_record',description:'Append structured researcher, independent challenger or portfolio-manager output. Originals cannot be edited. A hold decision is valid. This does not execute trades.',inputSchema:schemaRecord},
{name:'execute_decision',description:'Attempt a permitted paper order for an existing approved decision. Fails closed while the experiment or its operating checks are paused. Never live trading.',inputSchema:{type:'object',required:['decision_id'],properties:{decision_id:{type:'string'}},additionalProperties:false}},
{name:'reconcile_paper',description:'GET-only inspection of paper fill activities, known orders, cash and positions. Appends reconciliation receipts; never submits or cancels orders, activates trading, or initializes the experiment. Unsupported precision and corporate actions remain blockers.',inputSchema:{type:'object',required:['idempotency_key'],properties:{idempotency_key:{type:'string'}},additionalProperties:false}},
{name:'export_history',description:'Export immutable records after a sequence number, up to 500 per page. Digests are SHA-256 of canonical {kind,payload}.',inputSchema:{type:'object',properties:{after_seq:{type:'integer',minimum:0}},additionalProperties:false}}
];
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
async function body(request){if(Number(request.headers.get('content-length'))>70000)throw new AppError('Request too large.',413);const str=await request.text();if(str.length>70000)throw new AppError('Request too large.',413);try{return JSON.parse(str);}catch{throw new AppError('Invalid JSON.');}}
function authorize(request,env){
 // Dispatch verifies the private Site audience and strips/spoof-protects identity headers.
 // Service access is intentionally limited by an additional server-only bearer.
 const user=request.headers.get('oai-authenticated-user-id');
 if(user)return 'chatgpt:'+user;
 const service=request.headers.get('authorization');
 if(env.SERVICE_TOKEN&&service==='Bearer '+env.SERVICE_TOKEN)return 'cloud-service';
 throw new AppError('Sign in to this private Site with ChatGPT.',401);
}
async function call(name,args,env,actor){
 if(!env.DB)throw new AppError('Persistent database is not bound.',503);
 if(name==='portfolio_state')return state(env.DB,args.as_of);
 if(name==='refresh_market')return refresh(env.DB,env,args.idempotency_key,actor);
 if(name==='submit_record')return submit(env.DB,args,actor);
 if(name==='reconcile_paper')return reconcile(env.DB,env,args.idempotency_key,actor);
 if(name==='execute_decision')return executeDecision(env.DB,env,args.decision_id,actor);
 if(name==='export_history'){
  if(!Number.isSafeInteger(args.after_seq??0)||(args.after_seq??0)<0)throw new AppError('Invalid sequence.');
  const r=await env.DB.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 500').bind(args.after_seq??0).all();
  return {records:r.results.map(e=>({...e,payload:JSON.parse(e.payload)})),next_after_seq:r.results.at(-1)?.seq??null};
 }
 throw new AppError('Unknown tool.',404);
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 try {
  if(request.method==='POST'&&(url.pathname==='/mcp'||url.pathname.startsWith('/api/')))validateWriteRequest(request);
  if(url.pathname==='/mcp'&&request.method==='POST'){
   const b=await body(request);let result;
   if(b.method==='server/discover')result={supportedVersions:['2026-07-28'],capabilities:{tools:{}}};
   else if(b.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'blue-capital',version:'1.0.0'}};
   else if(b.method==='tools/list')result={tools:toolDefs};
   else if(b.method==='notifications/initialized')return new Response(null,{status:204});
   else if(b.method==='tools/call'){
    try{const actor=authorize(request,env);result={content:[{type:'text',text:JSON.stringify(await call(b.params.name,b.params.arguments||{},env,actor))}]};}
    catch(e){result={isError:true,content:[{type:'text',text:e instanceof AppError?e.message:'Operation failed. No new trade should be assumed.'}]};}
   }else return json({jsonrpc:'2.0',id:b.id??null,error:{code:-32601,message:'Method not found'}});
   return json({jsonrpc:'2.0',id:b.id??null,result});
  }
  const actor=authorize(request,env);
  if(url.pathname.startsWith('/api/')){
   if(url.pathname==='/api/state'&&request.method==='GET')return json(await call('portfolio_state',{as_of:url.searchParams.get('as_of')||undefined},env,actor));
   if(url.pathname==='/api/refresh'&&request.method==='POST')return json(await call('refresh_market',await body(request),env,actor));
   if(url.pathname==='/api/records'&&request.method==='POST')return json(await call('submit_record',await body(request),env,actor));
   if(url.pathname==='/api/export'&&request.method==='GET')return json(await call('export_history',{after_seq:Number(url.searchParams.get('after_seq')||0)},env,actor));
   if(url.pathname==='/api/reconcile'&&request.method==='POST')return json(await call('reconcile_paper',await body(request),env,actor));
   if(url.pathname==='/api/execute'&&request.method==='POST')return json(await call('execute_decision',await body(request),env,actor));
   return json({error:'Not found'},404);
  }
  if(request.method!=='GET')return json({error:'Method not allowed'},405);
  const asset=assets[url.pathname==='/'?'/index.html':url.pathname];
  if(!asset)return json({error:'Not found'},404);
  return new Response(asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
 }catch(e){return json({error:e instanceof AppError?e.message:'Service unavailable. Records are retained and trading stays paused.'},e instanceof AppError?e.status:503);}
}};
export {toolDefs,authorize};
