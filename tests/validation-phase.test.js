import test from 'node:test';
import assert from 'node:assert/strict';
import {append,listEvents,getEvent,appendLeased,acquire,release} from '../lib/store.js';
import {observe} from '../lib/alpaca.js';
import {activateValidation,activateExperiment} from '../lib/activation.js';
import {executeValidationDecision,executeDecision} from '../lib/execution.js';
import {stageValidation,validationOrderLimits,VALIDATION_AUTHORIZATION,VALIDATION_LIMITS,VALIDATION_PENDING,VALIDATION_CHECKS} from '../lib/validation-policy.js';
import {reconcile,readLedger} from '../lib/reconciliation.js';
import {initialPortfolio} from '../lib/finance.js';
import {temporaryDatabase,brokerFixture,testEnv} from './helpers.js';
import {seedCoverage} from './action-fixtures.js';
const revision='b'.repeat(40),actor='synthetic:validation';
const env={...testEnv,RELEASE_REVISION:revision,VALIDATION_ENABLED:'true'};
const now=()=>new Date().toISOString();
const records=db=>listEvents(db,now());
function broker({ambiguous=false,price='500.00',quantity='1',clock}={}){
 const base=brokerFixture({clock});let posts=0,lookups=0,order=null,settled=false,fillTime=null;
 const fetcher=async(url,options)=>{
  const u=new URL(url);assert.ok(['https://paper-api.alpaca.markets','https://data.alpaca.markets'].includes(u.origin));
  if(options.method==='POST'){
   assert.equal(u.pathname,'/v2/orders');posts++;order={id:'synthetic-validation-order',...JSON.parse(options.body),status:'new',filled_qty:'0',asset_class:'us_equity',created_at:now()};
   if(ambiguous)throw new Error('Synthetic ambiguous submission');return Response.json(order);
  }
  assert.equal(options.method,'GET');
  if(u.pathname==='/v2/assets/SPY')return Response.json({symbol:'SPY',status:'active',tradable:true,class:'us_equity',exchange:'ARCA'});
  if(u.pathname==='/v2/orders:by_client_order_id'){lookups++;assert.equal(u.searchParams.get('client_order_id'),order.client_order_id);return Response.json({...order,...(settled?{status:'filled',filled_qty:quantity,filled_avg_price:price}:{})});}
  if(u.pathname==='/v2/stocks/trades/latest')return Response.json({trades:Object.fromEntries([['AAPL',100],['MSFT',200],['SPY',500]].map(([s,p])=>[s,{p,t:now(),x:'V'}]))});
  if(settled&&u.pathname==='/v2/account')return Response.json({status:'ACTIVE',currency:'USD',cash:quantity!=='1'?'99750.00':price==='499.999'?'99500.001':'99500.00',equity:'100000.00'});
  if(settled&&u.pathname==='/v2/positions')return Response.json([{symbol:'SPY',side:'long',qty:quantity,cost_basis:quantity==='1'?price:'250.00'}]);
  if(settled&&u.pathname==='/v2/account/activities/FILL')return Response.json([{id:'synthetic-validation-fill',activity_type:'FILL',type:'fill',order_id:order.id,symbol:'SPY',side:'buy',qty:quantity,price,transaction_time:fillTime}]);
  return base.fetcher(url,options);
 };
 return {fetcher,settle(){settled=true;fillTime=now();},get posts(){return posts;},get lookups(){return lookups;}};
}
async function seed(db,{stage=true,decisionPatch={}}={}){
 const f=broker();await append(db,{id:'validation-snapshot',kind:'snapshot',actor,payload:await observe(testEnv,f.fetcher)});
 const common={snapshot_ids:['validation-snapshot']};
 await append(db,{id:'validation-research',kind:'research',actor,payload:{...common,role:'researcher',author:'researcher',thesis:'Synthetic test only'}});
 await append(db,{id:'validation-challenge',kind:'challenge',actor,payload:{...common,role:'challenger',author:'challenger',research_id:'validation-research',counterargument:'Synthetic test only'}});
 const decision=await append(db,{id:'validation-decision',kind:'decision',actor,payload:{...common,role:'portfolio_manager',author:'manager',research_id:'validation-research',challenge_id:'validation-challenge',challenge_response:'Synthetic response',action:'buy',symbol:'SPY',size:500,limit_price_cents:50000,valid_until:new Date(Date.now()+60000).toISOString(),...decisionPatch}});
 await seedCoverage(db);
 const protocol={revision,status:'approved',mandate_version:1,protocol_version:1,authorization_reference:VALIDATION_AUTHORIZATION,general_trading_enabled:false,limits:VALIDATION_LIMITS,pending_evidence:VALIDATION_PENDING,decision_id:decision.id,valid_until:decision.payload.valid_until};
 const checks={};for(const check of VALIDATION_CHECKS){const id='validation-check:'+check;await append(db,{id,kind:'verification',actor,payload:{check,revision,outcome:'passed',summary:'Synthetic measured evidence only'}});checks[check]=id;}
 const release={revision,status:'approved',protocol_id:'validation-protocol',checks};
 if(stage){await stageValidation(db,env,{idempotency_key:'validation-protocol',kind:'validation_protocol',payload:protocol},actor);await stageValidation(db,env,{idempotency_key:'validation-release',kind:'validation_release',payload:release},actor);}
 return {protocol,release,decision};
}
async function prepared(db){await seed(db);const f=broker();const opening=await activateValidation(db,env,{idempotency_key:'validation-inception'},actor,f.fetcher);await reconcile(db,env,'validation-preorder-recon',actor,f.fetcher);return {f,opening};}

test('validation and general execution stay disabled before any write or broker request without exact gate',async t=>{
 const {db}=temporaryDatabase(t);let calls=0;const forbidden=async()=>{calls++;throw new Error('Unexpected broker call');};
 for(const flag of [undefined,'false','TRUE']){
  await assert.rejects(activateValidation(db,{...env,VALIDATION_ENABLED:flag},{idempotency_key:'disabled-validation'},actor,forbidden),/disabled/);
  await assert.rejects(executeValidationDecision(db,{...env,VALIDATION_ENABLED:flag},'validation-decision',actor,forbidden),/disabled/);
 }
 await assert.rejects(activateExperiment(db,{...env,TRADING_ENABLED:'true'},{idempotency_key:'general-activation'},actor,forbidden),/hard-disabled/);
 await assert.rejects(executeDecision(db,{...env,TRADING_ENABLED:'true'},'validation-decision',actor,forbidden),/paused/);
 assert.equal(calls,0);assert.equal((await records(db)).length,0);
});

test('typed protocol requires exact authorization, limits, pending evidence, revision and measured release checks',async t=>{
 const {db}=temporaryDatabase(t);const {protocol,release}=await seed(db,{stage:false});
 for(const patch of [{authorization_reference:'invented'},{revision:'c'.repeat(40)},{general_trading_enabled:true},{limits:{...VALIDATION_LIMITS,quantity:2}},{pending_evidence:[]},{valid_until:'2020-01-01T00:00:00Z'}])await assert.rejects(stageValidation(db,env,{idempotency_key:'invalid-protocol',kind:'validation_protocol',payload:{...protocol,...patch}},actor));
 const p=await stageValidation(db,env,{idempotency_key:'validation-protocol',kind:'validation_protocol',payload:protocol},actor);assert.equal(p.kind,'validation_protocol');
 await assert.rejects(stageValidation(db,env,{idempotency_key:'second-protocol',kind:'validation_protocol',payload:protocol},actor),/single/);
 await assert.rejects(stageValidation(db,env,{idempotency_key:'bad-release',kind:'validation_release',payload:{...release,checks:{}}},actor),/evidence/);
 assert.equal((await stageValidation(db,env,{idempotency_key:'validation-release',kind:'validation_release',payload:release},actor)).kind,'validation_release');
 await assert.rejects(append(db,{id:'db-second-protocol',kind:'validation_protocol',payload:protocol,actor}),/UNIQUE/);
});

test('validation inception is fresh and atomic with simultaneous SPY benchmark and no trade',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const f=broker(),before=Date.now();
 const opening=await activateValidation(db,env,{idempotency_key:'validation-inception'},actor,f.fetcher);
 assert.ok(Date.parse(opening.created_at)>=before);assert.equal(opening.payload.started_at,opening.created_at);assert.equal(opening.payload.benchmark.started_at,opening.created_at);assert.equal(opening.payload.control.started_at,opening.created_at);assert.equal(opening.payload.control.status,'validation_pending');assert.equal(opening.payload.control.general_trading_enabled,false);assert.equal(opening.payload.benchmark.holdings.SPY.quantity,200);assert.equal(f.posts,0);
 assert.deepEqual(await activateValidation(db,env,{idempotency_key:'validation-inception'},actor,f.fetcher),opening);
 await assert.rejects(activateValidation(db,env,{idempotency_key:'different-inception'},actor,f.fetcher),/already started/);
 assert.equal((await records(db)).filter(e=>e.kind==='experiment_opened').length,1);
});

test('one-share limits independently enforce dollar cap, NAV cap, symbol, decision and expiry',()=>{
 const order={symbol:'SPY',side:'buy',quantity:1,limit_price_cents:50000};const context={prices:{SPY:{price_cents:50000}},portfolio:initialPortfolio()};
 const decision={id:'test-decision',payload:{size:1000}};const protocol={payload:{decision_id:decision.id,valid_until:new Date(Date.now()+60000).toISOString()}};
 assert.doesNotThrow(()=>validationOrderLimits(order,context,decision,protocol));
 for(const patch of [{quantity:2},{symbol:'AAPL'},{side:'sell'},{limit_price_cents:100001}])assert.throws(()=>validationOrderLimits({...order,...patch},context,decision,protocol));
 assert.throws(()=>validationOrderLimits(order,{...context,portfolio:{...initialPortfolio(),cash_cents:4999999}},decision,protocol),/1%/);
 assert.throws(()=>validationOrderLimits(order,context,{...decision,id:'different'},protocol));
 assert.throws(()=>validationOrderLimits(order,context,decision,{payload:{...protocol.payload,valid_until:'2020-01-01T00:00:00Z'}}));
});

test('bounded execution submits one share once and ambiguous retry is GET-only even after expiry',async t=>{
 const {db}=temporaryDatabase(t);await prepared(db);const f=broker({ambiguous:true});
 await assert.rejects(executeValidationDecision(db,env,'validation-decision',actor,f.fetcher),/ambiguous/);assert.equal(f.posts,1);
 const intent=(await records(db)).find(e=>e.kind==='order_intent');assert.equal(intent.payload.order.qty,'1');assert.equal(intent.payload.order.symbol,'SPY');assert.equal(intent.payload.order.limit_price,'500.00');assert.equal(intent.payload.validation_protocol_id,'validation-protocol');
 await assert.rejects(append(db,{id:'second-validation-intent',kind:'order_intent',actor,payload:{...intent.payload,decision_id:'another'}}),/UNIQUE/);
 t.mock.timers.enable({apis:['Date'],now:Date.now()+120000});
 await executeValidationDecision(db,env,'validation-decision',actor,f.fetcher);assert.equal(f.posts,1);assert.equal(f.lookups,1);t.mock.timers.reset();
 await assert.rejects(executeValidationDecision(db,env,'another-decision',actor,f.fetcher));assert.equal(f.posts,1);
});

test('expired validation cannot submit first intent and another decision cannot use its authorization',async t=>{
 const {db}=temporaryDatabase(t);await prepared(db);const f=broker();
 await assert.rejects(executeValidationDecision(db,env,'another-decision',actor,f.fetcher),/one specific/);
 t.mock.timers.enable({apis:['Date'],now:Date.now()+120000});await assert.rejects(executeValidationDecision(db,env,'validation-decision',actor,f.fetcher),/expiry|expired|future/);t.mock.timers.reset();
 assert.equal(f.posts,0);assert.equal((await records(db)).filter(e=>e.kind==='order_intent').length,0);
});

test('actual synthetic nonzero broker activity settles once; unsupported fractional precision stays raw and blocked',async t=>{
 for(const options of [{},{price:'499.999'},{quantity:'0.5'},{price:'499.9990000001'}]){
  const {db}=temporaryDatabase(t);await prepared(db);const f=broker(options);await executeValidationDecision(db,env,'validation-decision',actor,f.fetcher);f.settle();
  const receipt=await reconcile(db,env,'validation-fill-reconcile',actor,f.fetcher);const ledger=await readLedger(db);
  if(!Object.keys(options).length||options.price==='499.999'){assert.equal(receipt.payload.new_fills,1);assert.equal(receipt.payload.orders_closed,1);assert.equal(ledger.portfolio.cash_cents,9950000);assert.equal(ledger.portfolio.cash_nanos,options.price==='499.999'?'99500001000000':'99500000000000');assert.equal(ledger.portfolio.holdings.SPY.cost_nanos,options.price==='499.999'?'499999000000':'500000000000');assert.equal(ledger.portfolio.holdings.SPY.quantity,1);const retry=await reconcile(db,env,'validation-fill-retry',actor,f.fetcher);assert.equal(retry.payload.new_fills,0);assert.equal(retry.payload.status,'reconciled');
   const prior=await getEvent(db,'validation-decision');await append(db,{id:'second-validation-decision',kind:'decision',actor,payload:prior.payload});
   await assert.rejects(executeValidationDecision(db,env,'second-validation-decision',actor,f.fetcher),/one specific/);
   await executeValidationDecision(db,env,'validation-decision',actor,f.fetcher);assert.equal(f.posts,1);
  }
  else{assert.equal(receipt.payload.new_fills,0);assert.equal(receipt.payload.status,'blocked');assert.equal((await records(db)).filter(e=>e.kind==='broker_activity').length,1);assert.equal((await records(db)).filter(e=>e.kind==='ledger_fill').length,0);}
  assert.equal(f.posts,1);
 }
});

test('protocol expiry during final activation renewal blocks inception before database insertion',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const f=broker();const prepare=db.prepare.bind(db);let heads=0,advanced=false;
 db.prepare=sql=>{const statement=prepare(sql);
  if(sql==='SELECT COALESCE(MAX(seq),0) AS seq FROM events'){const first=statement.first.bind(statement);statement.first=async()=>{const result=await first();heads++;return result;};}
  if(sql.startsWith('UPDATE locks SET expires_at=')){const bind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=bind(...args),run=bound.run.bind(bound);bound.run=async()=>{const result=await run();if(heads>=2&&!advanced){advanced=true;t.mock.timers.enable({apis:['Date'],now:Date.now()+61000});}return result;};return bound;};}
  return statement;
 };
 await assert.rejects(activateValidation(db,env,{idempotency_key:'expiry-during-opening'},actor,f.fetcher),/expired|expiry/);
 t.mock.timers.reset();assert.equal(advanced,true);assert.equal((await records(db)).filter(e=>e.kind==='experiment_opened').length,0);assert.equal(f.posts,0);
});

test('protocol staging refuses oversized or non-SPY manager decisions before reserving authorization',async t=>{
 for(const decisionPatch of [{symbol:'AAPL'},{size:1000.01},{limit_price_cents:100001},{action:'sell'}]){
  const {db}=temporaryDatabase(t);const {protocol}=await seed(db,{stage:false,decisionPatch});
  await assert.rejects(stageValidation(db,env,{idempotency_key:'validation-protocol',kind:'validation_protocol',payload:protocol},actor),/capped SPY/);
  assert.equal((await records(db)).filter(e=>e.kind==='validation_protocol').length,0);
 }
});

test('database-time authorization deadline fences validation opening and intent independently of caller time',async t=>{
 const {db}=temporaryDatabase(t);await acquire(db,'execution','deadline-test');
 const expired=new Date(Date.now()-1000).toISOString(),callerTime=new Date(Date.now()-2000).toISOString();
 const payloads=[['experiment_opened',{started_at:callerTime,control:{status:'validation_pending',submission_valid_until:expired}}],['order_intent',{validation_protocol_id:'synthetic-protocol',submission_valid_until:expired}]];
 for(const [kind,payload] of payloads)await assert.rejects(appendLeased(db,{id:'expired-'+kind,kind,payload,actor},'execution','deadline-test',callerTime),/lease|journal/);
 assert.equal((await records(db)).length,0);await release(db,'execution','deadline-test');
});

test('validation rechecks observed session close after final asynchronous renewal before sending',async t=>{
 const {db}=temporaryDatabase(t);await prepared(db);
 const f=broker({clock:{next_close:new Date(Date.now()+10000).toISOString()}});const prepare=db.prepare.bind(db);let arm=false,advanced=false;
 db.prepare=sql=>{const statement=prepare(sql);
  if(sql==='SELECT MAX(seq) AS seq FROM events'){const first=statement.first.bind(statement);statement.first=async()=>{const result=await first();arm=true;return result;};}
  if(sql.startsWith('UPDATE locks SET expires_at=')){const bind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=bind(...args),run=bound.run.bind(bound);bound.run=async()=>{const result=await run();if(arm&&!advanced){advanced=true;t.mock.timers.enable({apis:['Date'],now:Date.now()+11000});}return result;};return bound;};}
  return statement;
 };
 await assert.rejects(executeValidationDecision(db,env,'validation-decision',actor,f.fetcher),/expired|expiry/);
 t.mock.timers.reset();assert.equal(advanced,true);assert.equal(f.posts,0);assert.equal((await records(db)).filter(e=>e.kind==='order_intent').length,1);
});

test('validation MCP operations enforce authentication, write origin and disabled execution gate',async t=>{
 const {db}=temporaryDatabase(t);const {default:app}=await import('../worker/index.js');
 const runtime={...env,DB:db,VALIDATION_ENABLED:'false',TRADING_ENABLED:'true'};
 const invoke=(operation,headers={})=>app.fetch(new Request('https://private.test/mcp',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'validation_phase',arguments:{operation,input:{idempotency_key:'route-disabled-validation',decision_id:'validation-decision'}}}})}),runtime);
 for(const operation of ['stage','readiness','status','activate','execute']){
  const response=await (await invoke(operation)).json();assert.equal(response.result.isError,true);assert.match(response.result.content[0].text,/Sign in/);
 }
 for(const operation of ['activate','execute']){
  const response=await (await invoke(operation,{'oai-authenticated-user-id':'synthetic-owner'})).json();assert.equal(response.result.isError,true);assert.match(response.result.content[0].text,/disabled/);
  assert.equal((await invoke(operation,{'oai-authenticated-user-id':'synthetic-owner',origin:'https://evil.test'})).status,403);
 }
 assert.equal((await records(db)).length,0);
});

// Later authored evidence must invalidate a pinned pass, without destroying recovery.
async function invalidateCheck(db,outcome,check='independent_code_review',suffix='one'){
 const {submit}=await import('../lib/service.js');
 return submit(db,{idempotency_key:'later-validation-'+suffix,kind:'verification',payload:{title:'Synthetic later review',summary:'Synthetic invalidation regression only',author:'independent-test-reviewer',check,revision,outcome}},actor);
}
test('later failed and pending measured checks block release staging through supported submit',async t=>{
 for(const outcome of ['failed','pending'])for(const check of VALIDATION_CHECKS){
  const {db}=temporaryDatabase(t),{protocol,release}=await seed(db,{stage:false});
  await stageValidation(db,env,{idempotency_key:'validation-protocol',kind:'validation_protocol',payload:protocol},actor);
  await invalidateCheck(db,outcome,check);
  await assert.rejects(stageValidation(db,env,{idempotency_key:'validation-release',kind:'validation_release',payload:release},actor),/superseded/);
  assert.equal((await records(db)).filter(e=>e.kind==='validation_release').length,0);
 }
});
test('stale pinned approvals cannot activate or execute after later non-passed evidence',async t=>{
 for(const outcome of ['failed','pending']){
  const first=temporaryDatabase(t);await seed(first.db);const f=broker();await invalidateCheck(first.db,outcome);
  await assert.rejects(activateValidation(first.db,env,{idempotency_key:'blocked-inception'},actor,f.fetcher),/superseded/);
  assert.equal((await records(first.db)).filter(e=>e.kind==='experiment_opened').length,0);assert.equal(f.posts,0);
  const second=temporaryDatabase(t);const {f:g}=await prepared(second.db);await invalidateCheck(second.db,outcome);
  await assert.rejects(executeValidationDecision(second.db,env,'validation-decision',actor,g.fetcher),/superseded/);
  assert.equal((await records(second.db)).filter(e=>e.kind==='order_intent').length,0);assert.equal(g.posts,0);
 }
});
test('later non-passed evidence does not prevent GET-only recovery of an ambiguous existing intent',async t=>{
 const {db}=temporaryDatabase(t);await prepared(db);const f=broker({ambiguous:true});
 await assert.rejects(executeValidationDecision(db,env,'validation-decision',actor,f.fetcher),/ambiguous/);
 await invalidateCheck(db,'failed');await invalidateCheck(db,'pending','private_hosting','two');
 await executeValidationDecision(db,env,'validation-decision',actor,f.fetcher);
 assert.equal(f.posts,1);assert.equal(f.lookups,1);assert.equal((await records(db)).filter(e=>e.kind==='order_intent').length,1);
});
test('final submission fence rejects non-passed evidence arriving after durable intent',async t=>{
 for(const outcome of ['failed','pending']){
  const {db}=temporaryDatabase(t);await prepared(db);const f=broker(),prepare=db.prepare.bind(db);let injected=false;
  db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('UPDATE locks SET expires_at=')){
   const bind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=bind(...args),run=bound.run.bind(bound);bound.run=async()=>{const result=await run();
    if(!injected&&await prepare("SELECT id FROM events WHERE kind='order_intent' LIMIT 1").first()){
     injected=true;
     // Adversarial journal insertion at the last asynchronous renewal; ordinary submit is lease-serialized.
     await append(db,{id:'final-fence-invalidation',kind:'verification',actor,payload:{check:'independent_code_review',revision,outcome,summary:'Synthetic final fence'}});
    }return result;};return bound;};}return statement;};
  await assert.rejects(executeValidationDecision(db,env,'validation-decision',actor,f.fetcher),/superseded|Journal changed/);
  assert.equal(injected,true);assert.equal(f.posts,0);assert.equal((await records(db)).filter(e=>e.kind==='order_intent').length,1);
 }
});
test('staging journal fence rejects evidence changed after checks before receipt insertion',async t=>{
 const {db}=temporaryDatabase(t),{protocol,release}=await seed(db,{stage:false});
 await stageValidation(db,env,{idempotency_key:'validation-protocol',kind:'validation_protocol',payload:protocol},actor);
 const prepare=db.prepare.bind(db);let injected=false;
 db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('UPDATE locks SET expires_at=')){const bind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=bind(...args),run=bound.run.bind(bound);bound.run=async()=>{const result=await run();if(!injected){injected=true;await append(db,{id:'stage-fence-invalidation',kind:'verification',actor,payload:{check:'private_hosting',revision,outcome:'pending',summary:'Synthetic stage race'}});}return result;};return bound;};}return statement;};
 await assert.rejects(stageValidation(db,env,{idempotency_key:'validation-release',kind:'validation_release',payload:release},actor),/journal changed/);
 assert.equal((await records(db)).filter(e=>e.kind==='validation_release').length,0);
});

test('later failure requires a newly pinned measured pass; an unrelated revision does not invalidate',async t=>{
 const {db}=temporaryDatabase(t),{protocol,release}=await seed(db,{stage:false});
 await stageValidation(db,env,{idempotency_key:'validation-protocol',kind:'validation_protocol',payload:protocol},actor);
 await append(db,{id:'other-revision-failure',kind:'verification',actor,payload:{check:'private_hosting',revision:'c'.repeat(40),outcome:'failed',summary:'Another release only'}});
 await invalidateCheck(db,'pending');
 const {submit}=await import('../lib/service.js');
 const pass=await submit(db,{idempotency_key:'new-measured-code-pass',kind:'verification',payload:{title:'New actual check in isolated fixture',author:'reviewer',summary:'Synthetic fresh measured check',check:'independent_code_review',revision,outcome:'passed'}},actor);
 await assert.rejects(stageValidation(db,env,{idempotency_key:'stale-release-pins',kind:'validation_release',payload:release},actor),/superseded/);
 await stageValidation(db,env,{idempotency_key:'validation-release',kind:'validation_release',payload:{...release,checks:{...release.checks,independent_code_review:pass.id}}},actor);
 const f=broker();await activateValidation(db,env,{idempotency_key:'fresh-approval-opening'},actor,f.fetcher);assert.equal(f.posts,0);
});
test('inception journal fence rejects a later failed review arriving at final renewal',async t=>{
 const {db}=temporaryDatabase(t);await seed(db);const f=broker(),prepare=db.prepare.bind(db);let heads=0,injected=false;
 db.prepare=sql=>{const statement=prepare(sql);
  if(sql==='SELECT COALESCE(MAX(seq),0) AS seq FROM events'){const first=statement.first.bind(statement);statement.first=async()=>{const result=await first();heads++;return result;};}
  if(sql.startsWith('UPDATE locks SET expires_at=')){const bind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=bind(...args),run=bound.run.bind(bound);bound.run=async()=>{const result=await run();if(heads>=2&&!injected){injected=true;await append(db,{id:'activation-fence-failure',kind:'verification',actor,payload:{check:'independent_code_review',revision,outcome:'failed',summary:'Synthetic final inception race'}});}return result;};return bound;};}
  return statement;
 };
 await assert.rejects(activateValidation(db,env,{idempotency_key:'invalidation-during-opening'},actor,f.fetcher),/journal changed|superseded/);
 assert.equal(injected,true);assert.equal((await records(db)).filter(e=>e.kind==='experiment_opened').length,0);assert.equal(f.posts,0);
});
