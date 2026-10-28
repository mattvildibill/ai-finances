import test from 'node:test';
import assert from 'node:assert/strict';
import {temporaryDatabase,testEnv} from './helpers.js';
import {append,getEvent,hash} from '../lib/store.js';
import {readCompleteHistory} from '../lib/history.js';
import {createNanoBenchmark} from '../lib/finance.js';
import {MANAGED_AUTHORIZATION,MANAGED_RULES,managedAccountProblem} from '../lib/managed-policy.js';
import {collectCashActivities,cashActivityProblems,CASH_ACTIVITY_LIMITS} from '../lib/cash-activities.js';
import {rebuildLedger,reconcile} from '../lib/reconciliation.js';
import worker,{toolDefs} from '../worker/index.js';
const actor='synthetic:cash-test',env={...testEnv,MANAGED_ENABLED:'false'};
async function setup(t){const {db}=temporaryDatabase(t),at=new Date(Date.now()-10000).toISOString();
 const opening=await append(db,{id:'synthetic-opening-cash',kind:'experiment_opened',actor,payload:{accounting_policy:'usd-nano-v1',initial_cash_cents:10000000,started_at:at,benchmark:createNanoBenchmark({started_at:at,observed_at:at,market_time:at,price_text:'500'})}},at);
 await append(db,{id:'synthetic-managed-cash',kind:'managed_mandate',actor,payload:{opening_id:opening.id,opening_digest:opening.digest,started_at:at,ends_at:new Date(Date.parse(at)+180*86400000).toISOString(),authorization_reference:MANAGED_AUTHORIZATION,protocol_version:1,status:'approved',rules:MANAGED_RULES,revision:'a'.repeat(40),author:actor}});
 return db;
}
const fill=i=>({id:'synthetic-fill-'+i,activity_type:'FILL',type:'fill',transaction_time:'2026-10-27T13:32:40.269422Z',qty:'1',price:'767.50'});
const fee={id:'synthetic-fee',activity_type:'FEE',date:'2026-10-28',net_amount:'-0.01',description:'Synthetic test only: no actual fee evidence'};
function broker(pages){const calls=[];return {calls,fetcher:async(url,o)=>{const u=new URL(url);assert.equal(u.origin,'https://paper-api.alpaca.markets');assert.equal(u.pathname,'/v2/account/activities');assert.equal(o.method,'GET');assert.equal(o.redirect,'manual');assert.equal(o.body,undefined);calls.push(u);const p=pages[calls.length-1];return p instanceof Response?p:Response.json(p);}};}

test('bounded all-type scan retains original receipt fields, paginates, retries without network and never adjusts cash',async t=>{
 const db=await setup(t),before=await readCompleteHistory(db),f=broker([Array.from({length:100},(_,i)=>fill(i)),[fee]]);
 const result=await collectCashActivities(db,env,{idempotency_key:'synthetic-cash-scan'},actor,f.fetcher);
 assert.equal(result.payload.complete,true);assert.equal(result.payload.activity_count,101);assert.equal(result.payload.non_fill_count,1);assert.equal(result.payload.trading_permitted,false);
 assert.equal(f.calls[1].searchParams.get('page_token'),'synthetic-fill-99');assert.equal(f.calls[0].searchParams.get('until'),f.calls[1].searchParams.get('until'));assert.equal(f.calls[0].searchParams.has('activity_types'),false);
 const all=await readCompleteHistory(db),pages=all.filter(e=>e.kind==='cash_activity_page');assert.deepEqual(pages[1].payload.activities,[fee]);assert.deepEqual(pages[0].payload.activities[0],fill(0));assert.ok(pages.every(e=>e.payload.retrieval_started_at<=e.payload.observed_at&&e.payload.observed_at<=e.created_at));
 for(const e of all)assert.equal(e.digest,await hash({kind:e.kind,payload:e.payload}));assert.deepEqual(all.slice(0,before.length),before);
 const ledger=rebuildLedger(all);assert.equal(ledger.portfolio.cash_nanos,'100000000000000');assert.equal(ledger.fill_count,0);assert.equal(ledger.status,'blocked');assert.ok(ledger.problems.some(p=>p.code==='cash_activity_unresolved'));assert.match(managedAccountProblem(all),/activity evidence/);
 assert.deepEqual(await collectCashActivities(db,env,{idempotency_key:'synthetic-cash-scan'},actor,f.fetcher),result);assert.equal(f.calls.length,2);
 assert.equal(rebuildLedger(before).portfolio.cash_nanos,ledger.portfolio.cash_nanos);
 // A subsequent clean fill-only scan cannot erase the retained non-fill evidence.
 const fetcher=async url=>Response.json(new URL(url).pathname==='/v2/account'?{status:'ACTIVE',currency:'USD',cash:'100000'}:[]);
 const recon=await reconcile(db,env,'synthetic-followup-recon',actor,fetcher);assert.equal(recon.payload.status,'blocked');assert.ok(recon.payload.problems.some(p=>p.code==='cash_activity_unresolved'));
});

test('empty complete collection is evidence only; missing or changed non-fill remains blocking across later scans',async t=>{
 const db=await setup(t);await collectCashActivities(db,env,{idempotency_key:'synthetic-first-cash'},actor,broker([[fee]]).fetcher);
 await collectCashActivities(db,env,{idempotency_key:'synthetic-changed-cash'},actor,broker([[{...fee,net_amount:'-0.02'}]]).fetcher);
 const r=await collectCashActivities(db,env,{idempotency_key:'synthetic-empty-cash'},actor,broker([[]]).fetcher);assert.equal(r.payload.complete,true);
 const events=await readCompleteHistory(db);assert.ok(cashActivityProblems(events).some(p=>p.code==='cash_activity_changed'));assert.ok(cashActivityProblems(events).some(p=>p.code==='cash_activity_missing'));assert.equal(rebuildLedger(events).portfolio.cash_nanos,'100000000000000');
});

test('malformed, duplicate and looping pages preserve available evidence and cannot claim completion',async t=>{
 for(const [name,pages] of [['object',[{error:'synthetic malformed'}]],['id',[[{...fee,id:null}]]],['duplicate',[[fee,fee]]],['loop',[Array.from({length:100},(_,i)=>fill(i)),Array.from({length:100},(_,i)=>fill(i))]]]){
  const db=await setup(t),r=await collectCashActivities(db,env,{idempotency_key:'synthetic-bad-'+name},actor,broker(pages).fetcher);assert.equal(r.payload.complete,false);assert.equal(r.payload.status,'blocked');assert.ok(r.payload.page_ids.length);assert.ok(cashActivityProblems(await readCompleteHistory(db)).some(p=>p.code==='cash_activity_incomplete'));
 }
});

test('page, byte and HTTP failure limits stop without retries or adjustments',async t=>{
 const db=await setup(t);let calls=0;
 const r=await collectCashActivities(db,env,{idempotency_key:'synthetic-page-limit'},actor,async()=>Response.json(Array.from({length:100},(_,i)=>fill((calls++)*100+i))));assert.equal(r.payload.complete,false);assert.equal(r.payload.page_ids.length,CASH_ACTIVITY_LIMITS.max_pages);assert.match(r.payload.problem,/page limit/);
 for(const [name,response] of [['bytes',new Response('x'.repeat(CASH_ACTIVITY_LIMITS.page_bytes+1))],['quota',new Response('{}',{status:429})],['redirect',new Response('',{status:302})],['json',new Response('not json')]]){
  const d=await setup(t),f=broker([response]),out=await collectCashActivities(d,env,{idempotency_key:'synthetic-limit-'+name},actor,f.fetcher);assert.equal(out.payload.complete,false);assert.equal(f.calls.length,1);assert.equal(rebuildLedger(await readCompleteHistory(d)).portfolio.cash_nanos,'100000000000000');
 }
});

test('strict input and mandate validation reject alternate URLs, credentials, filters and key collisions before network',async t=>{
 const db=await setup(t);let calls=0;const fetcher=async()=>{calls++;throw Error('unexpected');};
 for(const input of [null,[],{}, {idempotency_key:'short'},...['url','after','until','activity_types','method','ALPACA_API_KEY'].map(k=>({idempotency_key:'synthetic-invalid-input',[k]:'https://evil.invalid'}))])await assert.rejects(collectCashActivities(db,env,input,actor,fetcher));
 await assert.rejects(collectCashActivities(db,env,{idempotency_key:'synthetic-opening-cash'},actor,fetcher),/different operation/);
 const {db:empty}=temporaryDatabase(t);await assert.rejects(collectCashActivities(empty,env,{idempotency_key:'synthetic-no-mandate'},actor,fetcher),/mandate/);assert.equal(calls,0);
});

test('lease theft preserves incomplete marker, makes no unfenced receipt and does not delete new lease owner',async t=>{
 const db=await setup(t);await assert.rejects(collectCashActivities(db,env,{idempotency_key:'synthetic-lease-cash'},actor,async()=>{db.sqlite.prepare("UPDATE locks SET token='new-owner' WHERE name='execution'").run();return Response.json([fee]);}),/lease/);
 const events=await readCompleteHistory(db);assert.equal(events.filter(e=>e.kind==='cash_activity_page').length,0);assert.ok(cashActivityProblems(events).some(p=>p.code==='cash_activity_incomplete'));assert.equal(db.sqlite.prepare("SELECT token FROM locks WHERE name='execution'").get().token,'new-owner');
 const retry=await collectCashActivities(db,env,{idempotency_key:'synthetic-lease-cash'},actor,()=>{throw Error('must not reissue');});assert.equal(retry.kind,'cash_activity_scan');assert.equal(retry.payload.complete,false);
});

test('native schema exposes only typed collector and unauthorized transport cannot reach it',async t=>{
 assert.ok(toolDefs.find(t=>t.name==='managed_portfolio').inputSchema.properties.operation.enum.includes('collect_cash_activities'));
 const db=await setup(t),before=await readCompleteHistory(db);
 const response=await worker.fetch(new Request('https://example.test/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'managed_portfolio',arguments:{operation:'collect_cash_activities',input:{idempotency_key:'synthetic-unauthorized'}}}})}),{...env,DB:db});const body=await response.json();assert.equal(body.result.isError,true);assert.match(body.result.content[0].text,/Sign in/);assert.deepEqual(await readCompleteHistory(db),before);
});

test('collected fills must match retained broker evidence; later old fill responses cannot hide changes',async t=>{
 const db=await setup(t),raw=fill(1);
 await append(db,{id:'synthetic-existing-fill-raw',kind:'broker_activity',actor,payload:{broker_activity_id:raw.id,activity:raw}});
 await collectCashActivities(db,env,{idempotency_key:'synthetic-identical-fill'},actor,broker([[raw]]).fetcher);
 assert.deepEqual(cashActivityProblems(await readCompleteHistory(db)),[]);
 for(const [label,delta] of [['price',{price:'768'}],['fee',{fee:'0.01'}],['unknown',{id:'synthetic-unseen-fill'}]]){
  await collectCashActivities(db,env,{idempotency_key:'synthetic-changed-fill-'+label},actor,broker([[{...raw,...delta}]]).fetcher);
 }
 await collectCashActivities(db,env,{idempotency_key:'synthetic-original-fill-again'},actor,broker([[raw]]).fetcher);
 assert.equal(cashActivityProblems(await readCompleteHistory(db)).filter(p=>p.code==='cash_activity_unresolved').length,2);assert.ok(cashActivityProblems(await readCompleteHistory(db)).some(p=>p.code==='cash_activity_changed'));
});

test('aggregate response bytes and transport failures stay bounded and redact runtime secrets',async t=>{
 const db=await setup(t);let page=0;
 const r=await collectCashActivities(db,env,{idempotency_key:'synthetic-total-byte-limit'},actor,async()=>{const base=page++*100;return Response.json(Array.from({length:100},(_,i)=>({...fill(base+i),description:'x'.repeat(2000)})));});
 assert.equal(r.payload.complete,false);assert.match(r.payload.problem,/byte limit/);assert.ok(r.payload.bytes<=CASH_ACTIVITY_LIMITS.total_bytes);assert.ok(page<CASH_ACTIVITY_LIMITS.max_pages);
 const d=await setup(t),out=await collectCashActivities(d,env,{idempotency_key:'synthetic-redacted-error'},actor,async()=>{throw Error(env.ALPACA_API_KEY+' '+env.ALPACA_SECRET_KEY);});assert.equal(out.payload.complete,false);assert.equal(JSON.stringify(out).includes(env.ALPACA_API_KEY),false);assert.equal(JSON.stringify(out).includes(env.ALPACA_SECRET_KEY),false);
});

test('existing authenticated native route dispatches read-only collector with no execution enablement',async t=>{
 const db=await setup(t),original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url,method:options.method});return Response.json([]);};
 try{
  const response=await worker.fetch(new Request('https://example.test/mcp',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-dispatch-identity'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'managed_portfolio',arguments:{operation:'collect_cash_activities',input:{idempotency_key:'synthetic-native-dispatch'}}}})}),{...env,DB:db});
  const body=await response.json();assert.notEqual(body.result.isError,true);const result=JSON.parse(body.result.content[0].text);assert.equal(result.kind,'cash_activity_result');assert.equal(result.payload.complete,true);assert.equal(result.payload.trading_permitted,false);assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(new URL(calls[0].url).pathname,'/v2/account/activities');
 }finally{globalThis.fetch=original;}
});
