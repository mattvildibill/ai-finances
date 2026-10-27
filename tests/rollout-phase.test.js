import test from 'node:test';
import assert from 'node:assert/strict';
import {append,getEvent,listEvents,canonical,appendLeased,acquire,release} from '../lib/store.js';
import {observe} from '../lib/alpaca.js';
import {activateValidation,activateExperiment} from '../lib/activation.js';
import {executeValidationDecision,executeDecision,executeRolloutDecision} from '../lib/execution.js';
import {stageValidation,VALIDATION_AUTHORIZATION,VALIDATION_LIMITS,VALIDATION_PENDING,VALIDATION_CHECKS} from '../lib/validation-policy.js';
import {reconcile,readLedger} from '../lib/reconciliation.js';
import {temporaryDatabase,testEnv,brokerFixture} from './helpers.js';
import {seedCoverage} from './action-fixtures.js';
import {rolloutReviewCandidate,stageRollout,rolloutPrerequisites,rolloutOrderLimits,ROLLOUT_LIMITS,ROLLOUT_AUTHORIZATION} from '../lib/rollout-policy.js';
import {marketDate} from '../lib/action-ledger.js';
const actor='synthetic:rollout-manager',pilotRevision='a'.repeat(40),releaseRevision='b'.repeat(40);
const pilotEnv={...testEnv,RELEASE_REVISION:pilotRevision,VALIDATION_ENABLED:'true'};
const rolloutEnv={...testEnv,RELEASE_REVISION:releaseRevision,ROLLOUT_ENABLED:'true'};
const now=()=>new Date().toISOString();
const records=db=>listEvents(db,now());

// The fixture exercises the real protocol, opening, submission and reconciliation
// functions. Its broker never connects to a network or writes official records.
function broker(){
 const base=brokerFixture();const orders=new Map(),activities=[],holdings=new Map();let cash=100000,posts=0,lookups=0;
 const marks={AAPL:100,MSFT:200,SPY:500};
 const fetcher=async(url,options)=>{
  const u=new URL(url);assert.ok(['https://paper-api.alpaca.markets','https://data.alpaca.markets'].includes(u.origin));
  if(options.method==='POST'){
   assert.equal(u.pathname,'/v2/orders');const payload=JSON.parse(options.body);posts++;
   const order={...payload,id:'synthetic-broker-order-'+posts,asset_class:'us_equity',status:'new',filled_qty:'0',created_at:now()};orders.set(order.client_order_id,order);return Response.json(order);
  }
  assert.equal(options.method,'GET');
  if(u.pathname.startsWith('/v2/assets/')){const symbol=u.pathname.split('/').at(-1);return Response.json({symbol,status:'active',tradable:true,class:'us_equity',exchange:symbol==='SPY'?'ARCA':'NASDAQ'});}
  if(u.pathname==='/v2/orders:by_client_order_id'){lookups++;return Response.json(orders.get(u.searchParams.get('client_order_id')));}
  if(u.pathname==='/v2/orders')return Response.json([...orders.values()].filter(o=>o.status==='new'));
  if(u.pathname==='/v2/account/activities/FILL')return Response.json(activities);
  if(u.pathname==='/v2/stocks/trades/latest')return Response.json({trades:Object.fromEntries(Object.entries(marks).map(([s,p])=>[s,{p,t:now(),x:'V'}]))});
  if(u.pathname==='/v2/account'){const value=cash+[...holdings].reduce((v,[s,h])=>v+h.qty*marks[s],0);return Response.json({status:'ACTIVE',currency:'USD',cash:cash.toFixed(2),equity:value.toFixed(2),portfolio_value:value.toFixed(2)});}
  if(u.pathname==='/v2/positions')return Response.json([...holdings].map(([symbol,h])=>({symbol,side:'long',qty:String(h.qty),cost_basis:h.cost.toFixed(2),market_value:(h.qty*marks[symbol]).toFixed(2),unrealized_pl:(h.qty*marks[symbol]-h.cost).toFixed(2)})));
  return base.fetcher(url,options);
 };
 const settle=(terminalStatus='filled')=>{for(const o of orders.values())if(o.status==='new'){const q=Number(o.qty),p=marks[o.symbol],h=holdings.get(o.symbol)||{qty:0,cost:0};assert.equal(o.side,'buy');cash-=q*p;holdings.set(o.symbol,{qty:h.qty+q,cost:h.cost+q*p});o.status=terminalStatus;o.filled_qty=o.qty;o.filled_avg_price=String(p);o.filled_at=now();activities.push({id:'fill-'+o.id,activity_type:'FILL',type:'fill',order_id:o.id,symbol:o.symbol,side:o.side,qty:o.qty,price:String(p),transaction_time:o.filled_at});}};
 return {fetcher,settle,orders,activities,get posts(){return posts;},get lookups(){return lookups;}};
}
async function decisionChain(db,f,id,{symbol='SPY',size=500,limit=50000}={}){
 const snapshot=await append(db,{id:id+'-snapshot',kind:'snapshot',actor,payload:await observe(testEnv,f.fetcher)});
 const common={snapshot_ids:[snapshot.id]};
 const research=await append(db,{id:id+'-research',kind:'research',actor,payload:{...common,role:'researcher',author:'synthetic-researcher',thesis:'Isolated test thesis'}});
 const challenge=await append(db,{id:id+'-challenge',kind:'challenge',actor,payload:{...common,role:'challenger',author:'synthetic-challenger',research_id:research.id,counterargument:'Isolated test counterargument'}});
 return append(db,{id,kind:'decision',actor,payload:{...common,role:'portfolio_manager',author:'synthetic-manager',research_id:research.id,challenge_id:challenge.id,challenge_response:'Isolated test response',symbol,action:'buy',size,limit_price_cents:limit,valid_until:new Date(Date.now()+60000).toISOString()}});
}
async function checks(db,revision,prefix){const result={};for(const check of VALIDATION_CHECKS){const id=prefix+'-'+check;await append(db,{id,kind:'verification',actor,payload:{check,revision,outcome:'passed',summary:'Isolated measured-check fixture only'}});result[check]=id;}return result;}
async function completedPilot(db,{terminalStatus='filled'}={}){
 const f=broker(),decision=await decisionChain(db,f,'pilot-decision');await seedCoverage(db);
 const protocol=await stageValidation(db,pilotEnv,{idempotency_key:'pilot-protocol',kind:'validation_protocol',payload:{revision:pilotRevision,status:'approved',mandate_version:1,protocol_version:1,authorization_reference:VALIDATION_AUTHORIZATION,general_trading_enabled:false,limits:VALIDATION_LIMITS,pending_evidence:VALIDATION_PENDING,decision_id:decision.id,valid_until:decision.payload.valid_until}},actor);
 await stageValidation(db,pilotEnv,{idempotency_key:'pilot-release',kind:'validation_release',payload:{revision:pilotRevision,status:'approved',protocol_id:protocol.id,checks:await checks(db,pilotRevision,'pilot-check')}},actor);
 const opening=await activateValidation(db,pilotEnv,{idempotency_key:'pilot-inception'},actor,f.fetcher);
 await reconcile(db,pilotEnv,'pilot-preorder-reconciliation',actor,f.fetcher);
 await executeValidationDecision(db,pilotEnv,decision.id,actor,f.fetcher);f.settle(terminalStatus);
 const reconciliation=await reconcile(db,pilotEnv,'pilot-filled-reconciliation',actor,f.fetcher);
 assert.equal(reconciliation.payload.status,'reconciled');assert.equal(reconciliation.payload.new_fills,1);
 const ledger=await readLedger(db);assert.equal(ledger.portfolio.holdings.SPY.quantity,1);assert.equal(ledger.portfolio.cash_nanos,'99500000000000');
 return {f,opening,protocol,reconciliation,decision,checks:await checks(db,releaseRevision,'rollout-check')};
}

test('rollout fixture completes one simulated broker lifecycle without resetting inception',async t=>{
 const {db}=temporaryDatabase(t);const {f,opening}=await completedPilot(db);
 const history=await records(db);assert.equal(f.posts,1);assert.equal(history.filter(e=>e.kind==='order_intent').length,1);assert.equal(history.filter(e=>e.kind==='order_closed').length,1);assert.equal(history.filter(e=>e.kind==='ledger_fill').length,1);assert.equal(history.filter(e=>e.kind==='experiment_opened').length,1);assert.deepEqual(await getEvent(db,opening.id),opening);
 await assert.rejects(executeDecision(db,{...rolloutEnv,TRADING_ENABLED:'true'},'pilot-decision',actor,f.fetcher),/paused/);
 await assert.rejects(activateExperiment(db,{...rolloutEnv,TRADING_ENABLED:'true'},{idempotency_key:'must-not-reset-pilot'},actor,f.fetcher),/hard-disabled/);
 assert.equal(f.posts,1);
});

async function reviewed(db){
 const completed=await completedPilot(db);const intent=(await records(db)).find(e=>e.kind==='order_intent');
 const input={pilot_intent_id:intent.id,reconciliation_id:completed.reconciliation.id};
 const candidate=await rolloutReviewCandidate(db,input);const review_ids=[];
 for(const author of ['synthetic-outcome-review-a','synthetic-outcome-review-b']){
  const review=await append(db,{id:author,kind:'verification',actor:author,payload:{check:'pilot_outcome_review',outcome:'passed',revision:releaseRevision,pilot_binding:candidate.binding,author,summary:'Observed only the complete simulated pilot fixture; no production claim'}});review_ids.push(review.id);
 }
 return {...completed,input,candidate,payload:{...input,pilot_binding:candidate.binding,review_ids,checks:completed.checks,revision:releaseRevision,status:'approved',protocol_version:1,mandate_version:1,authorization_reference:ROLLOUT_AUTHORIZATION,general_trading_enabled:false,author:actor,limits:ROLLOUT_LIMITS,session_date:marketDate(now()),valid_until:new Date(Date.now()+60000).toISOString()}};
}
const stage=(db,payload,id='synthetic-rollout-approval')=>stageRollout(db,rolloutEnv,{idempotency_key:id,payload},actor);

test('rollout disabled gate rejects before broker access or journal mutation',async t=>{
 const {db}=temporaryDatabase(t);let calls=0;
 for(const flag of [undefined,'false','TRUE'])await assert.rejects(executeRolloutDecision(db,{...rolloutEnv,ROLLOUT_ENABLED:flag},'any-decision',actor,async()=>{calls++;}),/disabled/);
 assert.equal(calls,0);assert.equal((await records(db)).length,0);
});

test('graduation binds old pilot evidence to new release without replacing opening or resetting allowance',async t=>{
 const {db}=temporaryDatabase(t);const r=await reviewed(db);const binding=JSON.parse(r.candidate.binding);
 assert.equal(binding.opening_id,r.opening.id);assert.equal(binding.pilot_intent_id,r.input.pilot_intent_id);
 for(const kind of ['experiment_opened','validation_protocol','validation_release','order_intent','broker_order','broker_activity','ledger_fill','order_closed','reconciliation'])assert.ok(binding.records.some(e=>e.kind===kind&&/^[a-f0-9]{64}$/.test(e.digest)),kind);
 const approval=await stage(db,r.payload);assert.equal(approval.kind,'rollout_approval');
 assert.deepEqual(await stage(db,r.payload),approval);
 await assert.rejects(stage(db,r.payload,'different-approval-key'),/already approved|Single/);
 assert.deepEqual(await getEvent(db,r.opening.id),r.opening);assert.equal((await records(db)).filter(e=>e.kind==='experiment_opened').length,1);
 assert.equal(r.f.posts,1);
});

test('approval rejects altered authorization, limits, session, revision, binding and independent-review identity',async t=>{
 const {db}=temporaryDatabase(t);const r=await reviewed(db);
 const patches=[{authorization_reference:'invented'},{general_trading_enabled:true},{revision:pilotRevision},{limits:{...ROLLOUT_LIMITS,recycle_sales:true}},{session_date:'2020-01-01'},{valid_until:'2020-01-01T00:00:00Z'},{valid_until:new Date(Date.now()+86400000).toISOString()},{pilot_binding:r.candidate.binding+' '},{review_ids:[r.payload.review_ids[0],r.payload.review_ids[0]]},{author:'synthetic-outcome-review-a'},{checks:{}}];
 for(let i=0;i<patches.length;i++)await assert.rejects(stage(db,{...r.payload,...patches[i]},'invalid-rollout-'+i));
 assert.equal((await records(db)).filter(e=>e.kind==='rollout_approval').length,0);
 await append(db,{id:'later-failed-pilot-review',kind:'verification',actor:'third-reviewer',payload:{check:'pilot_outcome_review',outcome:'failed',pilot_binding:r.candidate.binding,revision:releaseRevision,author:'third-reviewer',summary:'Synthetic unresolved challenge'}});
 await assert.rejects(stage(db,r.payload),/failed|unresolved/);
});

test('incomplete or missing pilot proof and digest-altered bindings never certify graduation',async t=>{
 const {db}=temporaryDatabase(t);const r=await reviewed(db);
 await assert.rejects(rolloutReviewCandidate(db,{...r.input,pilot_intent_id:'missing-intent'}),/pilot intent|opening/);
 const pre=(await records(db)).find(e=>e.kind==='reconciliation'&&e.seq<r.reconciliation.seq&&e.payload.ledger_status==='ready');
 await assert.rejects(rolloutReviewCandidate(db,{...r.input,reconciliation_id:pre.id}),/pilot intent|opening|filled/);
 const changed=JSON.parse(r.candidate.binding);changed.records[0].digest='0'.repeat(64);
 await assert.rejects(stage(db,{...r.payload,pilot_binding:canonical(changed)}),/exact reviewed/);
});

test('rollout requires fresh current reconciliation while preserving the reviewed historical proof',async t=>{
 const {db}=temporaryDatabase(t);const r=await reviewed(db);await stage(db,r.payload);
 const decision=await decisionChain(db,r.f,'new-rollout-decision',{symbol:'AAPL',size:1000,limit:10000});
 await reconcile(db,rolloutEnv,'rollout-current-reconcile',actor,r.f.fetcher);
 const ready=await rolloutPrerequisites(db,decision.id,now(),releaseRevision);assert.equal(ready.approval.payload.reconciliation_id,r.reconciliation.id);assert.notEqual(ready.reconciliation.id,r.reconciliation.id);
 await assert.rejects(rolloutPrerequisites(db,r.decision.id,now(),releaseRevision),/newly authored/);
 await append(db,{id:'later-rollout-refresh-failure',kind:'refresh_failed',actor,payload:{summary:'Synthetic failed source read'}});
 await assert.rejects(rolloutPrerequisites(db,decision.id,now(),releaseRevision),/accounting evidence/);
});

test('new approved buy executes once, reconciles actual fixture fill and cannot reset original pilot',async t=>{
 const {db}=temporaryDatabase(t);const r=await reviewed(db);await stage(db,r.payload);
 const decision=await decisionChain(db,r.f,'new-rollout-decision',{symbol:'AAPL',size:1000,limit:10000});
 await reconcile(db,rolloutEnv,'rollout-preorder-reconcile',actor,r.f.fetcher);
 await executeRolloutDecision(db,rolloutEnv,decision.id,actor,r.f.fetcher);assert.equal(r.f.posts,2);
 await executeRolloutDecision(db,rolloutEnv,decision.id,actor,r.f.fetcher);assert.equal(r.f.posts,2);
 r.f.settle();const recon=await reconcile(db,rolloutEnv,'rollout-postfill-reconcile',actor,r.f.fetcher);assert.equal(recon.payload.status,'reconciled');
 const ledger=await readLedger(db);assert.equal(ledger.portfolio.cash_nanos,'98500000000000');assert.equal(ledger.portfolio.holdings.AAPL.quantity,10);assert.equal(ledger.portfolio.holdings.SPY.quantity,1);
 assert.deepEqual(await getEvent(db,r.opening.id),r.opening);assert.equal((await records(db)).filter(e=>e.kind==='experiment_opened').length,1);
 await assert.rejects(executeValidationDecision(db,pilotEnv,decision.id,actor,r.f.fetcher));assert.equal(r.f.posts,2);
});

test('withdrawn independent pilot review cannot remain authorization for rollout',async t=>{
 const {db}=temporaryDatabase(t);const r=await reviewed(db);await stage(db,r.payload);
 const d=await decisionChain(db,r.f,'withdrawal-test-decision',{symbol:'AAPL',size:1000,limit:10000});
 await reconcile(db,rolloutEnv,'withdrawal-current-reconcile',actor,r.f.fetcher);
 await append(db,{id:'pilot-review-withdrawal',kind:'revision',actor:'synthetic-outcome-review-a',payload:{supersedes:r.payload.review_ids[0],author:'synthetic-outcome-review-a',title:'Withdraw review',summary:'Synthetic newly discovered uncertainty invalidates prior approval'}});
 await assert.rejects(rolloutPrerequisites(db,d.id,now(),releaseRevision),/revis|withdraw|supersed/i);
});

test('cumulative rollout cap includes pilot and preserves exact ninety-thousand cash floor',()=>{
 const approval={payload:{session_date:marketDate(now()),valid_until:new Date(Date.now()+60000).toISOString()}};
 const c={portfolio:{accounting_policy:'usd-nano-v1',cash_nanos:'99500000000000',holdings:{SPY:{quantity:1,cost_nanos:'500000000000'}}},prices:{SPY:{price_nanos:'500000000000'},AAPL:{price_nanos:'100000000000'}}};
 const o={symbol:'AAPL',side:'buy',quantity:95,limit_price_cents:10000};const budget={spent:500000000000n,reserved:0n,total:500000000000n};
 assert.doesNotThrow(()=>rolloutOrderLimits(o,c,approval,budget));
 assert.throws(()=>rolloutOrderLimits(o,c,approval,{...budget,total:budget.total+1n}),/10,000/);
 assert.throws(()=>rolloutOrderLimits(o,{...c,portfolio:{...c.portfolio,cash_nanos:'99499999999999'}},approval,budget),/90,000/);
 assert.throws(()=>rolloutOrderLimits({...o,side:'sell'},c,approval,budget),/purchases/);
});

test('concurrent rollout submission and ambiguous retry never duplicate a POST',async t=>{
 const {db}=temporaryDatabase(t);const r=await reviewed(db);await stage(db,r.payload);
 const d=await decisionChain(db,r.f,'ambiguous-rollout-decision',{symbol:'AAPL',size:1000,limit:10000});await reconcile(db,rolloutEnv,'ambiguous-current-reconcile',actor,r.f.fetcher);
 let competed=false;
 const ambiguous=async(...args)=>{
  if(args[1].method==='POST'){
   competed=true;await assert.rejects(executeRolloutDecision(db,rolloutEnv,d.id,actor,r.f.fetcher),/progress/);
   await r.f.fetcher(...args);throw new Error('Synthetic accepted order with lost acknowledgement');
  }
  return r.f.fetcher(...args);
 };
 await assert.rejects(executeRolloutDecision(db,rolloutEnv,d.id,actor,ambiguous),/lost acknowledgement/);assert.equal(competed,true);assert.equal(r.f.posts,2);
 t.mock.timers.enable({apis:['Date'],now:Date.now()+120000});await executeRolloutDecision(db,rolloutEnv,d.id,actor,r.f.fetcher);t.mock.timers.reset();assert.equal(r.f.posts,2);
 assert.equal((await records(db)).filter(e=>e.kind==='order_intent').length,2);
});

test('rollout expiry during final lease renewal leaves intent but sends no new order',async t=>{
 const {db}=temporaryDatabase(t);const r=await reviewed(db);await stage(db,r.payload);
 const d=await decisionChain(db,r.f,'expiring-rollout-decision',{symbol:'AAPL',size:1000,limit:10000});await reconcile(db,rolloutEnv,'expiring-current-reconcile',actor,r.f.fetcher);
 const prepare=db.prepare.bind(db);let arm=false,advanced=false;
 db.prepare=sql=>{const statement=prepare(sql);
  if(sql==='SELECT MAX(seq) AS seq FROM events'){const first=statement.first.bind(statement);statement.first=async()=>{const head=await first();arm=true;return head;};}
  if(sql.startsWith('UPDATE locks SET expires_at=')){const bind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=bind(...args),run=bound.run.bind(bound);bound.run=async()=>{const result=await run();if(arm&&!advanced){advanced=true;t.mock.timers.enable({apis:['Date'],now:Date.now()+61000});}return result;};return bound;};}
  return statement;
 };
 await assert.rejects(executeRolloutDecision(db,rolloutEnv,d.id,actor,r.f.fetcher),/expired|unexpired/);t.mock.timers.reset();assert.equal(advanced,true);assert.equal(r.f.posts,1);assert.equal((await records(db)).filter(e=>e.kind==='order_intent').length,2);
});

test('a canceled pilot does not satisfy the required fully filled terminal status',async t=>{
 const {db}=temporaryDatabase(t);const r=await completedPilot(db,{terminalStatus:'canceled'});const intent=(await records(db)).find(e=>e.kind==='order_intent');
 await assert.rejects(rolloutReviewCandidate(db,{pilot_intent_id:intent.id,reconciliation_id:r.reconciliation.id}),/fully filled/);
 assert.equal(r.f.posts,1);
});

test('rollout approval and intent deadlines are checked by database time rather than stale caller time',async t=>{
 const {db}=temporaryDatabase(t);await acquire(db,'execution','rollout-deadline');
 const expired=new Date(Date.now()-1000).toISOString(),before=new Date(Date.now()-2000).toISOString();
 for(const [kind,payload] of [['rollout_approval',{valid_until:expired}],['order_intent',{rollout_approval_id:'synthetic-approval',submission_valid_until:expired}]])await assert.rejects(appendLeased(db,{id:'expired-'+kind,kind,payload,actor},'execution','rollout-deadline',before),/lease|journal/);
 assert.equal((await records(db)).length,0);await release(db,'execution','rollout-deadline');
});

test('opening-rollout MCP keeps anonymous, cross-origin and disabled execution requests inert',async t=>{
 const {db}=temporaryDatabase(t);const {default:app}=await import('../worker/index.js');const runtime={...rolloutEnv,DB:db,ROLLOUT_ENABLED:'false'};
 const invoke=(operation,headers={})=>app.fetch(new Request('https://private.test/mcp',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'opening_rollout',arguments:{operation,input:{decision_id:'synthetic-decision'}}}})}),runtime);
 for(const operation of ['status','review_candidate','stage','execute']){const response=await (await invoke(operation)).json();assert.equal(response.result.isError,true);assert.match(response.result.content[0].text,/Sign in/);}
 const disabled=await (await invoke('execute',{'oai-authenticated-user-id':'fixture'})).json();assert.equal(disabled.result.isError,true);assert.match(disabled.result.content[0].text,/disabled/);
 assert.equal((await invoke('execute',{'oai-authenticated-user-id':'fixture',origin:'https://evil.test'})).status,403);assert.equal((await records(db)).length,0);
});

test('a newer snapshot from interrupted refresh invalidates current graduation reconciliation',async t=>{
 const {db}=temporaryDatabase(t);const r=await reviewed(db);const old=(await records(db)).filter(e=>e.kind==='snapshot').at(-1);
 await append(db,{id:'interrupted-refresh-snapshot',kind:'snapshot',actor,payload:{...old.payload,account:{...old.payload.account,cash:98000,cash_text:'98000'}}});
 await assert.rejects(stage(db,r.payload),/accounting evidence|reconcil/i);
 assert.equal((await records(db)).filter(e=>e.kind==='rollout_approval').length,0);assert.equal(r.f.posts,1);
});

test('a later failed measured release check blocks a previously approved rollout',async t=>{
 const {db}=temporaryDatabase(t);const r=await reviewed(db);await stage(db,r.payload);const d=await decisionChain(db,r.f,'later-check-decision',{symbol:'AAPL',size:1000,limit:10000});await reconcile(db,rolloutEnv,'later-check-reconcile',actor,r.f.fetcher);
 await append(db,{id:'later-failed-hosting-check',kind:'verification',actor,payload:{check:'private_hosting',revision:releaseRevision,outcome:'failed',summary:'Synthetic access verification failure'}});
 await assert.rejects(rolloutPrerequisites(db,d.id,now(),releaseRevision),/later release check failed|unresolved/);assert.equal(r.f.posts,1);
});
