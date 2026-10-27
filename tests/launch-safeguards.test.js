import { seedCoverage,releaseChecks } from './action-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { append, getEvent, listEvents, renew, acquire, appendLeased } from '../lib/store.js';
import { createBenchmark } from '../lib/finance.js';
import { executionDecision, executionPrerequisites, activationPreflight } from '../lib/readiness.js';
import { executeDecision } from '../lib/execution.js';
import { state } from '../lib/service.js';
import { temporaryDatabase, testEnv, brokerFixture } from './helpers.js';
const actor='synthetic:safeguards';
const revision='a'.repeat(40);const executionEnv={...testEnv,RELEASE_REVISION:revision};
const now=()=>new Date().toISOString();
async function seed(db,{open=true,control=true,reconciled=true}={}){
 const start=new Date(Date.now()-10000).toISOString();
 if(open)await append(db,{id:'opening-fixture-001',kind:'experiment_opened',actor,payload:{started_at:start,initial_cash_cents:10000000,benchmark:createBenchmark({started_at:start,observed_at:start,market_time:start,price_cents:50000})}},start);
 const f=brokerFixture(); const snapshot=(await import('../lib/alpaca.js')).observe;
 await append(db,{id:'snapshot-fixture-001',kind:'snapshot',actor,payload:await snapshot(testEnv,f.fetcher)});
 const common={snapshot_ids:['snapshot-fixture-001']};
 await append(db,{id:'research-fixture-001',kind:'research',actor,payload:{...common,author:'researcher',role:'researcher'}});
 await append(db,{id:'challenge-fixture-001',kind:'challenge',actor,payload:{...common,author:'challenger',role:'challenger',research_id:'research-fixture-001'}});
 await append(db,{id:'decision-fixture-001',kind:'decision',actor,payload:{...common,author:'manager',role:'portfolio_manager',research_id:'research-fixture-001',challenge_id:'challenge-fixture-001',challenge_response:'Synthetic test response',action:'buy',symbol:'AAPL',size:100,limit_price_cents:10000,valid_until:new Date(Date.now()+60000).toISOString()}});
 await append(db,{id:'release-evidence-001',kind:'verification',actor,payload:{outcome:'passed',summary:'Synthetic evidence only'}});
 const checks=await releaseChecks(db,revision);
 for(const kind of ['launch_approval','release_verification'])await append(db,{id:kind+'-fixture',kind,actor,payload:{status:'approved',authorization_reference:'Synthetic authorization fixture only',revision,mandate_version:1,checks,evidence_ids:['release-evidence-001']}});
 if(control)await append(db,{id:'control-fixture-001',kind:'experiment_control',actor,payload:{status:'active',started_at:start,release_revision:revision,approval_id:'launch_approval-fixture',verification_id:'release_verification-fixture'}});
 await seedCoverage(db);
 if(reconciled)await append(db,{id:'reconciliation-fixture-001',kind:'reconciliation',actor,payload:{status:'reconciled',ledger_status:'ready',problems:[]}});
 return start;
}
// Test-only module adaptation: private engine is never exported by the production module.
// All callers below use fixture credentials and in-memory fetchers. No environment flag bypass exists.
async function privateEngine(){
 let source=await readFile(new URL('../lib/execution.js',import.meta.url),'utf8');
 source=source.replace(/from '(.+?)'/g,(_,path)=>`from '${new URL(path,new URL('../lib/execution.js',import.meta.url)).href}'`);
 source+='\nexport { executeVerifiedDecision as testEngine };';
 return (await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).testEngine;
}
function tradingBroker({postFailure=false,postHook,observeHook,assetPatch={},clock}={}){
 const fixture=brokerFixture({clock});let posts=0;let gets=0;let order;
 const fetcher=async(url,options)=>{
  const path=new URL(url).pathname;
  if(options.method==='POST'){
   posts++;order={id:'broker-fixture-001',...JSON.parse(options.body),status:'new',filled_qty:'0'};
   if(postHook)await postHook();
   if(postFailure)throw new Error('Synthetic ambiguous response');
   return Response.json(order);
  }
  if(path==='/v2/assets/AAPL')return Response.json({symbol:'AAPL',status:'active',tradable:true,class:'us_equity',exchange:'NASDAQ',...assetPatch});
  if(path==='/v2/orders:by_client_order_id'){gets++;return Response.json(order);}
  const response=await fixture.fetcher(url,options);if(observeHook)await observeHook(path);return response;
 };
 return {fetcher,get posts(){return posts;},get gets(){return gets;}};
}
test('engine refuses missing opening, active control, reconciliation and revisions before any request',async t=>{
 const engine=await privateEngine();
 for(const patch of [{open:false},{control:false},{reconciled:false},{revision:true}]){
  const {db}=temporaryDatabase(t);await seed(db,patch);
  if(patch.revision)await append(db,{id:'later-revision-001',kind:'revision',actor,payload:{supersedes:'research-fixture-001'}});
  let calls=0;await assert.rejects(engine(db,executionEnv,'decision-fixture-001',actor,async()=>{calls++;throw new Error('No broker call expected');}));assert.equal(calls,0);
 }
});
test('fresh prerequisites validate, while later accounting evidence invalidates reconciliation',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);
 assert.equal((await executionPrerequisites(db,'decision-fixture-001',now(),revision)).ledger.status,'ready');
 await append(db,{id:'later-activity-001',kind:'broker_activity',actor,payload:{activity:{id:'new-observation'}}});
 await assert.rejects(executionPrerequisites(db,'decision-fixture-001',now(),revision),/requires reconciliation/);
});
test('ambiguous POST retains durable intent; identical retry only looks up client ID',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const engine=await privateEngine();const f=tradingBroker({postFailure:true});
 await assert.rejects(engine(db,executionEnv,'decision-fixture-001',actor,f.fetcher),/ambiguous/);
 assert.equal(f.posts,1);assert.equal((await listEvents(db,now())).filter(e=>e.kind==='order_intent').length,1);
 await engine(db,executionEnv,'decision-fixture-001',actor,f.fetcher);assert.equal(f.posts,1);assert.equal(f.gets,1);
});
test('concurrent attempts cannot submit twice; competitor fails while first holds lease',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const engine=await privateEngine();let other;
 const f=tradingBroker({postHook:async()=>{other=engine(db,executionEnv,'decision-fixture-001',actor,f.fetcher);await assert.rejects(other,/progress/);}});
 await engine(db,executionEnv,'decision-fixture-001',actor,f.fetcher);assert.equal(f.posts,1);
});
test('lease loss during observation prevents intent/POST and preserves new owner',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const engine=await privateEngine();let stolen=false;
 const f=tradingBroker({observeHook:async()=>{if(!stolen){stolen=true;db.sqlite.exec("UPDATE locks SET token='other-owner'");}}});
 await assert.rejects(engine(db,executionEnv,'decision-fixture-001',actor,f.fetcher),/lease/);assert.equal(f.posts,0);
 assert.equal((await listEvents(db,now())).filter(e=>e.kind==='order_intent').length,0);
 assert.equal((await db.prepare('SELECT token FROM locks').first()).token,'other-owner');
});
test('lease loss after broker acceptance leaves an unresolved intent without pretending failure',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const engine=await privateEngine();
 const f=tradingBroker({postHook:async()=>{db.sqlite.exec("UPDATE locks SET token='new-owner'");}});
 await assert.rejects(engine(db,executionEnv,'decision-fixture-001',actor,f.fetcher),/lease/);assert.equal(f.posts,1);
 const rows=await listEvents(db,now());assert.equal(rows.filter(e=>e.kind==='order_intent').length,1);assert.equal(rows.filter(e=>e.kind==='order_submitted').length,0);
});
test('expired lease cannot be resurrected or used for a durable receipt',async t=>{
 const {db}=temporaryDatabase(t);const past=new Date(Date.now()-130000).toISOString();await acquire(db,'execution','old',past);
 await assert.rejects(renew(db,'execution','old'),/expired/);
 await assert.rejects(appendLeased(db,{id:'fenced-record-001',kind:'verification',payload:{},actor},'execution','old'),/lease/);
 assert.equal(await getEvent(db,'fenced-record-001'),null);
});
test('activation preflight never mutates or approves a release with unmet evidence',async t=>{
 const {db}=temporaryDatabase(t);await seed(db,{open:false,control:false});const before=await listEvents(db,now());
 const result=await activationPreflight(db,'snapshot-fixture-001');assert.equal(result.ready,false);assert.equal(result.trading_permitted,false);
 assert.ok(result.problems.some(p=>p.includes('revision')));assert.equal(result.gate,'hard_disabled');
 assert.equal((await listEvents(db,now())).length,before.length);
});
test('public state preserves ledger quantities but suppresses marks when broker snapshot still predates the fill',async t=>{
 const {db}=temporaryDatabase(t);const start=await seed(db);
 await append(db,{id:'ledger-fill-fixture',kind:'ledger_fill',actor,payload:{fill:{id:'fill-view-001',symbol:'AAPL',side:'buy',quantity:2,price_cents:10000,occurred_at:start,observed_at:now()}}});
 await append(db,{id:'post-fill-reconciliation',kind:'reconciliation',actor,payload:{status:'reconciled',ledger_status:'ready',problems:[]}});
 const current=await state(db);assert.equal(current.experiment.started_at,start);assert.equal(current.experiment.status,'paused');assert.equal(current.portfolio.cash,99800);assert.equal(current.portfolio.holdings[0].quantity,2);assert.equal(current.portfolio.value,null);assert.equal(current.account_drift,true);assert.equal(current.benchmark.status,'unavailable');
 const stale=await state(db,new Date(Date.now()+121000).toISOString());assert.equal(stale.portfolio.value,null);assert.equal(stale.portfolio.total_return,null);assert.equal(stale.portfolio.cash,99800);assert.equal(stale.portfolio.holdings[0].quantity,2);assert.equal(stale.benchmark.value,null);assert.equal(stale.risk.largest_position,null);
});
test('blocked ledger never displays invented initial balances or a reassuring empty portfolio',async t=>{
 const {db}=temporaryDatabase(t);const start=now();await append(db,{id:'broken-opening-001',kind:'experiment_opened',actor,payload:{started_at:start,initial_cash_cents:10000000,benchmark:null}},start);
 const result=await state(db);assert.equal(result.portfolio.cash,null);assert.equal(result.portfolio.value,null);assert.equal(result.portfolio.holdings_status,'unknown');assert.equal(result.risk.gross_exposure,null);
});
test('production gate remains closed with fully seeded synthetic prerequisites',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);let calls=0;
 await assert.rejects(executeDecision(db,{...testEnv,TRADING_ENABLED:'true'},'decision-fixture-001',actor,async()=>{calls++;}),/paused/);assert.equal(calls,0);
});

test('unresolved reconciliation correction suppresses performance without erasing known ledger facts',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);
 await append(db,{id:'reconciliation-correction',kind:'reconciliation',actor,payload:{status:'blocked',problems:[{code:'activity_changed',message:'Raw fill corrected'}]}});
 const result=await state(db);assert.equal(result.portfolio.cash,100000);assert.equal(result.portfolio.value,null);assert.equal(result.portfolio.total_return,null);assert.equal(result.benchmark.return,null);assert.equal(result.benchmark.excess_return,null);
});

test('atomic journal fence rejects an evidence change immediately before intent insertion',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const engine=await privateEngine();const f=tradingBroker();
 const original=db.prepare;let changed=false;
 db.prepare=sql=>{
  const statement=original(sql);
  if(sql.startsWith('INSERT INTO events')&&sql.includes('SELECT ?,?,?,?,?,?')){
   const run=statement.run.bind(statement);
   statement.run=async()=>{
    if(!changed){changed=true;await append(db,{id:'raced-revision-001',kind:'revision',actor,payload:{supersedes:'decision-fixture-001'}});}
    return run();
   };
  }
  return statement;
 };
 await assert.rejects(engine(db,executionEnv,'decision-fixture-001',actor,f.fetcher),/journal changed/);assert.equal(f.posts,0);
 assert.equal((await listEvents(db,now())).filter(e=>e.kind==='order_intent').length,0);
});
test('record submission shares execution lease and cannot revise an in-flight decision',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);await acquire(db,'execution','in-flight');
 const {submit}=await import('../lib/service.js');
 await assert.rejects(submit(db,{idempotency_key:'racing-revision-001',kind:'revision',payload:{}},actor),/progress/);
 assert.equal(await getEvent(db,'racing-revision-001'),null);
});
test('database execution time rejects a lease valid at captured time but now expired',async t=>{
 const {db}=temporaryDatabase(t);await acquire(db,'execution','captured');const captured=new Date(Date.now()-1000).toISOString();
 await db.prepare('UPDATE locks SET expires_at=?').bind(new Date(Date.now()-500).toISOString()).run();
 await assert.rejects(renew(db,'execution','captured',captured),/expired/);
 await assert.rejects(appendLeased(db,{id:'queued-receipt-001',kind:'verification',actor,payload:{}},'execution','captured',captured),/lease/);
 assert.equal(await getEvent(db,'queued-receipt-001'),null);
});
test('decision expiry and source revision do not inherit prior authorization',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);
 await assert.rejects(executionDecision(db,'decision-fixture-001',new Date(Date.now()+120000).toISOString()),/expiry/);
 await append(db,{id:'research-revision-002',kind:'revision',actor,payload:{supersedes:'research-fixture-001'}});
 await assert.rejects(executionDecision(db,'decision-fixture-001'),/revised/);
});

test('release attestations cannot authorize a different build or omit evidence links',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);
 await assert.rejects(executionPrerequisites(db,'decision-fixture-001',now(),'b'.repeat(40)),/revision-bound/);
 await append(db,{id:'unsubstantiated-approval',kind:'launch_approval',actor,payload:{status:'approved',revision,mandate_version:1,evidence_ids:['missing-evidence']}});
 await assert.rejects(executionPrerequisites(db,'decision-fixture-001',now(),revision),/supporting evidence/);
});
test('broker drift blocks the private engine without writing an intent',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const engine=await privateEngine();const f=brokerFixture({account:{cash:'99999'}});
 await assert.rejects(engine(db,executionEnv,'decision-fixture-001',actor,f.fetcher),/cash differs/);
 assert.ok(f.calls.every(c=>c.method==='GET'));assert.equal((await listEvents(db,now())).filter(e=>e.kind==='order_intent').length,0);
});


test('current asset metadata must confirm eligible instrument before intent',async t=>{
 for(const assetPatch of [{tradable:false},{status:'inactive'},{class:'crypto'},{exchange:'OTC'},{symbol:'OTHER'}]){
  const {db}=temporaryDatabase(t);await seed(db);const engine=await privateEngine();const f=tradingBroker({assetPatch});
  await assert.rejects(engine(db,executionEnv,'decision-fixture-001',actor,f.fetcher),/Asset/);assert.equal(f.posts,0);
  assert.equal((await listEvents(db,now())).filter(e=>e.kind==='order_intent').length,0);
 }
});

test('database permits only one official inception while preserving idempotent retry',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const original=await getEvent(db,'opening-fixture-001');
 assert.deepEqual(await append(db,{id:original.id,kind:original.kind,payload:original.payload,actor},original.created_at),original);
 await assert.rejects(append(db,{id:'second-opening-001',kind:'experiment_opened',payload:original.payload,actor},original.created_at),/UNIQUE/);
 assert.deepEqual(await getEvent(db,original.id),original);
});

test('comparison requires a fresh reconciliation after all current accounting and failure evidence',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);assert.equal((await state(db)).portfolio.comparison_complete,true);
 await append(db,{id:'post-recon-failure',kind:'refresh_failed',actor,payload:{summary:'Synthetic failed refresh'}});
 const result=await state(db);assert.equal(result.portfolio.comparison_complete,false);assert.equal(result.portfolio.total_return,null);assert.equal(result.benchmark.return,null);
 const {ledgerView}=await import('../lib/valuation.js');const {readLedger}=await import('../lib/reconciliation.js');const ledger=await readLedger(db);const snapshot=await getEvent(db,'snapshot-fixture-001');
 const stale={seq:Number.MAX_SAFE_INTEGER,created_at:new Date(Date.now()-86400000).toISOString(),payload:{status:'reconciled',problems:[]}};
 assert.equal(ledgerView(ledger,snapshot,now(),stale).portfolio.comparison_complete,false);
 const fresh={...stale,created_at:now()};ledger.economic.active.distribution_cash_cents=Number.MAX_SAFE_INTEGER;
 const overflow=ledgerView(ledger,snapshot,now(),fresh);assert.equal(overflow.portfolio.economic_value,null);assert.equal(overflow.portfolio.comparison_complete,false);
});

test('interrupted refresh cannot certify a newer drifting snapshot with an older reconciliation',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const original=await getEvent(db,'snapshot-fixture-001');assert.equal((await state(db)).portfolio.comparison_complete,true);
 await append(db,{id:'new-drifting-snapshot',kind:'snapshot',actor,payload:{...original.payload,account:{...original.payload.account,cash:99999}}});
 const drift=await state(db);assert.equal(drift.account_drift,true);assert.equal(drift.portfolio.comparison_complete,false);assert.equal(drift.portfolio.total_return,null);
 await append(db,{id:'drift-claims-reconciled',kind:'reconciliation',actor,payload:{status:'reconciled',ledger_status:'ready',problems:[]}});assert.equal((await state(db)).portfolio.comparison_complete,false);
 await append(db,{id:'new-flat-snapshot',kind:'snapshot',actor,payload:original.payload});assert.equal((await state(db)).portfolio.comparison_complete,false);
 await append(db,{id:'flat-fresh-reconciliation',kind:'reconciliation',actor,payload:{status:'reconciled',ledger_status:'ready',problems:[]}});assert.equal((await state(db)).portfolio.comparison_complete,true);
});

test('refresh cannot append failure or snapshot between final journal check and broker submission',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const engine=await privateEngine();const f=tradingBroker();
 const {refresh}=await import('../lib/service.js');const prepare=db.prepare.bind(db);let attempted=false;
 db.prepare=(sql)=>{const statement=prepare(sql);if(sql==='SELECT MAX(seq) AS seq FROM events'){
  const first=statement.first.bind(statement);statement.first=async()=>{const head=await first();attempted=true;
   await assert.rejects(refresh(db,testEnv,'concurrent-refresh-failure',actor,async()=>{throw new Error('Synthetic source failure');}),/already in progress/);
   assert.equal(await getEvent(db,'concurrent-refresh-failure'),null);return head;};
 }return statement;};
 await engine(db,executionEnv,'decision-fixture-001',actor,f.fetcher);
 assert.equal(attempted,true);assert.equal(f.posts,1);
 assert.equal((await listEvents(db,now())).filter(e=>e.kind==='refresh_failed').length,0);
});

test('saved expired decision retries return original receipt but execution still rejects expiry',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const {submit}=await import('../lib/service.js');
 const original=await getEvent(db,'decision-fixture-001');
 const payload={...original.payload,title:'Archived valid decision',summary:'Synthetic previously accepted decision',valid_until:'2020-01-01T00:00:00Z'};
 const receipt=await append(db,{id:'archived-decision-001',kind:'decision',payload,actor});
 assert.deepEqual(await submit(db,{idempotency_key:receipt.id,kind:'decision',payload},actor),receipt);
 await assert.rejects(submit(db,{idempotency_key:receipt.id,kind:'decision',payload:{...payload,size:200}},actor),/different content/);
 await assert.rejects(executionDecision(db,receipt.id),/expiry/);
});

test('session closing during final asynchronous lease renewal prevents broker POST',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const engine=await privateEngine();const f=tradingBroker({clock:{next_close:new Date(Date.now()+10000).toISOString()}});
 const prepare=db.prepare.bind(db);let arm=false;let advanced=false;
 db.prepare=(sql)=>{const statement=prepare(sql);
  if(sql==='SELECT MAX(seq) AS seq FROM events'){const first=statement.first.bind(statement);statement.first=async()=>{const head=await first();arm=true;return head;};}
  if(sql.startsWith('UPDATE locks SET expires_at=')){
   const bind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=bind(...args);const run=bound.run.bind(bound);bound.run=async()=>{const result=await run();if(arm&&!advanced){advanced=true;t.mock.timers.enable({apis:['Date'],now:Date.now()+11000});}return result;};return bound;};
  }return statement;
 };
 await assert.rejects(engine(db,executionEnv,'decision-fixture-001',actor,f.fetcher),/expired before submission/);
 assert.equal(advanced,true);assert.equal(f.posts,0);
 t.mock.timers.reset();assert.equal((await listEvents(db,now())).filter(e=>e.kind==='order_intent').length,1);
});
