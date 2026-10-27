import test from 'node:test';
import assert from 'node:assert/strict';
import {temporaryDatabase,testEnv} from './helpers.js';
import {completedPilot} from './universe-fixtures.js';
import {append,getEvent,canonical} from '../lib/store.js';
import {readCompleteHistory} from '../lib/history.js';
import {transitionManaged,managedControl,MANAGED_RULES,MANAGED_CHECKS,MANAGED_AUTHORIZATION} from '../lib/managed-policy.js';
import {inspectManagedInstrument,managedInstrumentCandidate,approveManagedInstrument,observeManaged} from '../lib/managed-instruments.js';
import {seedManagedCoverage} from './managed-action-fixtures.js';
import {executeManagedDecision,managedStatus} from '../lib/managed-execution.js';
import {reconcile,readLedger} from '../lib/reconciliation.js';
import {submit,state,refresh,observeManagedTarget} from '../lib/service.js';
import {toolDefs} from '../worker/index.js';
import {usdNanos} from '../lib/precision.js';
const now=()=>new Date().toISOString(),revision='c'.repeat(40),actor='managed-engine-fixture';
const env={...testEnv,RELEASE_REVISION:revision,MANAGED_ENABLED:'true'};
const decimal=n=>{const neg=n<0n;n=neg?-n:n;return (neg?'-':'')+String(n/1000000000n)+(n%1000000000n?'.'+String(n%1000000000n).padStart(9,'0').replace(/0+$/,''):'');};
function syntheticBroker(pilot){
 const orders=new Map([...pilot.f.orders].map(([id,o])=>[id,structuredClone(o)]));
 const activities=structuredClone(pilot.f.activities),holdings=new Map([['SPY',{quantity:1,cost:usdNanos('500')}]]);
 const marks={SPY:500,UNH:100,AAPL:100,MSFT:200};let cash=usdNanos('99500'),posts=0,gets=0,failPost=false,hook=null,stale=false,identityChange=false;
 const asset=symbol=>({id:'synthetic-asset-'+symbol,symbol,name:'Synthetic ordinary '+symbol,status:'active',tradable:true,class:'us_equity',exchange:'NASDAQ'});
 const fetcher=async(url,options)=>{
  const u=new URL(url);assert.ok(['https://paper-api.alpaca.markets','https://data.alpaca.markets'].includes(u.origin));
  if(hook)await hook(u,options);
  if(options.method==='POST'){
   assert.equal(u.pathname,'/v2/orders');posts++;const p=JSON.parse(options.body);
   const order={...p,id:'managed-broker-order-'+posts,asset_class:'us_equity',status:'new',filled_qty:'0',filled_avg_price:null,created_at:now(),submitted_at:now(),updated_at:now(),replaces:null,replaced_by:null};orders.set(order.client_order_id,order);
   if(failPost){failPost=false;throw new Error('Synthetic timeout after broker accepted request');}return Response.json(order);
  }
  assert.equal(options.method,'GET');gets++;
  if(u.pathname==='/v2/orders:by_client_order_id'){const order=orders.get(u.searchParams.get('client_order_id'));return order?Response.json(order):new Response('{}',{status:404});}
  if(u.pathname==='/v2/account/activities/FILL')return Response.json(activities);
  if(u.pathname==='/v2/orders')return Response.json([...orders.values()].filter(o=>['new','partially_filled'].includes(o.status)));
  if(u.pathname==='/v2/account'){const value=cash+[...holdings].reduce((n,[s,h])=>n+BigInt(h.quantity)*usdNanos(String(marks[s])),0n);return Response.json({id:'fixture-account',status:'ACTIVE',currency:'USD',cash:decimal(cash),equity:decimal(value),portfolio_value:decimal(value)});}
  if(u.pathname==='/v2/positions')return Response.json([...holdings].map(([symbol,h])=>({symbol,side:'long',qty:String(h.quantity),cost_basis:decimal(h.cost),market_value:decimal(BigInt(h.quantity)*usdNanos(String(marks[symbol]))),unrealized_pl:decimal(BigInt(h.quantity)*usdNanos(String(marks[symbol]))-h.cost)})));
  if(u.pathname==='/v2/clock')return Response.json({is_open:true,timestamp:now(),next_close:new Date(Date.now()+3600000).toISOString(),next_open:new Date(Date.now()+86400000).toISOString()});
  if(u.pathname==='/v2/stocks/trades/latest')return Response.json({trades:Object.fromEntries(u.searchParams.get('symbols').split(',').map(s=>[s,{p:marks[s]??100,t:stale?new Date(Date.now()-121000).toISOString():now(),x:'V'}]))});
  if(u.pathname.startsWith('/v2/assets/')){const a=asset(u.pathname.split('/').at(-1));if(identityChange)a.id='changed';return Response.json(a);}
  throw new Error('Unexpected fixture URL '+u.pathname);
 };
 function fill(clientId,qty,priceText,{fee,terminal}={}){
  const o=orders.get(clientId);assert.ok(o);assert.ok(qty>0&&Number(o.filled_qty)+qty<=Number(o.qty));
  const h=holdings.get(o.symbol)||{quantity:0,cost:0n},value=usdNanos(priceText)*BigInt(qty);
  if(o.side==='buy'){cash-=value;h.quantity+=qty;h.cost+=value;holdings.set(o.symbol,h);}else{assert.ok(h.quantity>=qty);cash+=value;const allocated=qty===h.quantity?h.cost:h.cost*BigInt(qty)/BigInt(h.quantity);h.quantity-=qty;h.cost-=allocated;if(h.quantity)holdings.set(o.symbol,h);else holdings.delete(o.symbol);}
  o.filled_qty=String(Number(o.filled_qty)+qty);o.status=terminal??(o.filled_qty===o.qty?'filled':'partially_filled');o.updated_at=now();if(o.status==='filled')o.filled_at=now();o.filled_avg_price=priceText;
  activities.push({id:'managed-fill-'+activities.length,activity_type:'FILL',type:'fill',order_id:o.id,symbol:o.symbol,side:o.side,qty:String(qty),price:priceText,transaction_time:now(),...(fee===undefined?{}:{fee})});
 }
 return {fetcher,asset,fill,orders,activities,holdings,marks,get cash(){return cash;},get posts(){return posts;},get gets(){return gets;},set failPost(v){failPost=v;},set hook(v){hook=v;},set stale(v){stale=v;},set identityChange(v){identityChange=v;}};
}
async function instrument(db,broker,mandate,symbol){
 const obs=await inspectManagedInstrument(db,env,{idempotency_key:'managed-asset-'+symbol,symbol},actor,broker.fetcher);
 const source={url:'https://issuer.example.com/'+symbol,content_sha256:'a'.repeat(64),observed_at:now(),excerpt:'Synthetic primary identity/classification fixture only.',publisher_name:'Synthetic issuer',source_type:'issuer'};
 const classification=symbol==='SPY'?'unleveraged_noninverse_fund':'ordinary_us_stock';
 const r=await append(db,{id:'managed-instrument-research-'+symbol,kind:'research',actor,payload:{role:'researcher',author:'instrument-researcher',evidence:[{url:source.url}]}});
 const c=await append(db,{id:'managed-instrument-challenge-'+symbol,kind:'challenge',actor,payload:{role:'challenger',author:'instrument-challenger',research_id:r.id,evidence:[{url:source.url}],instrument_review:{symbol,observation_id:obs.id,classification,source_url:source.url,source_sha256:source.content_sha256,outcome:'supported',source_provenance_verified:true,no_leveraged_or_inverse_objective:true,ordinary_stock_or_fund:true}}});
 const input={symbol,observation_id:obs.id,research_id:r.id,challenge_id:c.id,classification,issuer_name:'Synthetic issuer',instrument_assessment:'Ordinary security with disclosed objective; no leverage/inverse, no account options.',primary_source:source};
 const candidate=await managedInstrumentCandidate(db,input);
 return approveManagedInstrument(db,env,{idempotency_key:'managed-instrument-approved-'+symbol,payload:{...input,status:'approved',author:'instrument-manager',mandate_id:mandate.id,binding:candidate.binding}},actor);
}
async function fixture(t){
 const {db}=temporaryDatabase(t),pilot=await completedPilot(db),before=await readCompleteHistory(db),broker=syntheticBroker(pilot);
 const checks={};for(const check of MANAGED_CHECKS){const r=await append(db,{id:'managed-review-'+check,kind:'verification',actor,payload:{check,revision,outcome:'passed',author:'independent-'+check,summary:'Synthetic completed isolated review fixture, not production evidence'}});checks[check]=r.id;}
 const mandate=await transitionManaged(db,env,{idempotency_key:'managed-engine-mandate',payload:{protocol_version:1,status:'approved',authorization_reference:MANAGED_AUTHORIZATION,revision,author:'mandate-manager',rules:MANAGED_RULES,checks}},actor);
 const approved={};for(const s of ['SPY','UNH'])approved[s]=await instrument(db,broker,mandate,s);
 await seedManagedCoverage(db,['SPY','UNH'],approved,broker.fetcher);
 return {db,pilot,before,broker,checks,mandate,approved};
}
async function decision(f,id,{symbol='UNH',side='buy',qty=500,limit=10000,size=qty*limit/100}={}){
 const snapshot=await append(f.db,{id:id+'-snapshot',kind:'snapshot',actor,payload:await observeManaged(env,[...new Set([...f.broker.holdings.keys(),symbol])],f.approved,f.broker.fetcher)});
 const shared={title:'Isolated researched allocation',summary:'Synthetic research, no production claim',snapshot_ids:[snapshot.id],evidence:[{title:'Synthetic issuer',url:'https://issuer.example.com/'+symbol,observed_at:now(),excerpt:'Isolated evidence fixture'}],thesis:'Synthetic investment case',horizon:'180-day experiment',uncertainties:'Prices may fall',change_mind:'Underlying case changes'};
 const r=await submit(f.db,{idempotency_key:id+'-research',kind:'research',payload:{...shared,role:'researcher',author:'investment-researcher'}},actor);
 const c=await submit(f.db,{idempotency_key:id+'-challenge',kind:'challenge',payload:{...shared,role:'challenger',author:'investment-challenger',research_id:r.id,counterargument:'Concentration and valuation may disappoint'}},actor);
 return submit(f.db,{idempotency_key:id,kind:'decision',payload:{...shared,role:'portfolio_manager',author:'investment-manager',research_id:r.id,challenge_id:c.id,challenge_response:'Considered the actual contrary evidence',managed_mandate_id:f.mandate.id,instrument_approval_id:f.approved[symbol]?.id,symbol,action:side,quantity:qty,size,limit_price_cents:limit,valid_until:new Date(Date.now()+60000).toISOString(),why_asset:'Synthetic supported business',why_now:'Reviewed current evidence',why_size:'Explicit concentration judgment',correlated_exposure:'Account-level portfolio risks considered',downside_case:'Material loss remains possible'}},actor);
}
async function execute(f,d){const receipt=await executeManagedDecision(f.db,env,d.id,actor,f.broker.fetcher);return {receipt,intent:(await readCompleteHistory(f.db)).find(e=>e.kind==='order_intent'&&e.payload.decision_id===d.id)};}
async function settle(f,key){return reconcile(f.db,env,key,actor,f.broker.fetcher);}

test('managed real engine buys50k, reconciles partial/full fills, sells owned shares and reinvests above100k lifetime turnover',async t=>{
 const f=await fixture(t);const first=await execute(f,await decision(f,'managed-large-buy'));
 assert.equal(f.broker.posts,1);assert.equal(first.intent.payload.order.qty,'500');
 f.broker.fill(first.intent.payload.client_order_id,200,'100');let r=await settle(f,'managed-partial-buy');assert.equal(r.payload.new_fills,1);assert.equal(r.payload.status,'blocked');let ledger=await readLedger(f.db);assert.equal(ledger.portfolio.holdings.UNH.quantity,200);
 const next=await decision(f,'managed-while-open',{qty:1});await assert.rejects(execute(f,next),/reconciliation|Unresolved|commitment/);assert.equal(f.broker.posts,1);
 f.broker.fill(first.intent.payload.client_order_id,300,'100');r=await settle(f,'managed-complete-buy');assert.equal(r.payload.status,'reconciled');ledger=await readLedger(f.db);assert.equal(ledger.portfolio.cash_nanos,'49500000000000');assert.equal(ledger.portfolio.holdings.UNH.cost_nanos,'50000000000000');
 const sell=await execute(f,await decision(f,'managed-owned-sale',{side:'sell',qty:500,limit:12000}));
 f.broker.fill(sell.intent.payload.client_order_id,250,'120');r=await settle(f,'managed-partial-sale');assert.equal(r.payload.status,'blocked');ledger=await readLedger(f.db);assert.equal(ledger.portfolio.holdings.UNH.cost_nanos,'25000000000000');assert.equal(ledger.portfolio.realized_pnl_nanos,'5000000000000');
 f.broker.fill(sell.intent.payload.client_order_id,250,'120');r=await settle(f,'managed-full-sale');assert.equal(r.payload.status,'reconciled');ledger=await readLedger(f.db);assert.equal(ledger.portfolio.holdings.UNH,undefined);assert.equal(ledger.portfolio.cash_nanos,'109500000000000');assert.equal(ledger.portfolio.realized_pnl_nanos,'10000000000000');
 const reinvest=await execute(f,await decision(f,'managed-reinvest',{qty:1095,size:109500}));f.broker.fill(reinvest.intent.payload.client_order_id,1095,'100');r=await settle(f,'managed-reinvest-fill');assert.equal(r.payload.status,'reconciled');ledger=await readLedger(f.db);assert.equal(ledger.portfolio.cash_nanos,'0');assert.equal(ledger.portfolio.holdings.UNH.quantity,1095);assert.equal(ledger.portfolio.holdings.SPY.quantity,1);
 const final=await readCompleteHistory(f.db);assert.equal(final.filter(e=>e.kind==='experiment_opened').length,1);assert.equal(final.filter(e=>e.kind==='managed_mandate').length,1);for(const e of f.before)assert.deepEqual(await getEvent(f.db,e.id),e);
 const before=canonical(ledger.portfolio);r=await settle(f,'managed-no-double-fill');assert.equal(r.payload.new_fills,0);assert.equal(canonical((await readLedger(f.db)).portfolio),before);assert.equal(f.broker.posts,3);
});

test('uncertain managed intent retries are GET-only after pause and changed release',async t=>{
 const f=await fixture(t),d=await decision(f,'managed-ambiguous',{qty:1});f.broker.failPost=true;await assert.rejects(execute(f,d),/timeout/);assert.equal(f.broker.posts,1);
 await managedControl(f.db,env,{idempotency_key:'managed-paused-after-timeout',payload:{mandate_id:f.mandate.id,status:'paused',author:'manager',reason:'Reconcile uncertain order only'}},actor);
 const before=f.broker.gets;const result=await executeManagedDecision(f.db,{...env,MANAGED_ENABLED:'false',RELEASE_REVISION:'d'.repeat(40)},d.id,actor,f.broker.fetcher);assert.equal(result.kind,'broker_order');assert.ok(f.broker.gets>before);assert.equal(f.broker.posts,1);
 const intent=(await readCompleteHistory(f.db)).find(e=>e.kind==='order_intent'&&e.payload.decision_id===d.id);f.broker.fill(intent.payload.client_order_id,1,'100');const r=await settle(f,'ambiguous-eventual-fill');assert.equal(r.payload.status,'reconciled');assert.equal((await readLedger(f.db)).portfolio.holdings.UNH.quantity,1);
 await executeManagedDecision(f.db,{...env,MANAGED_ENABLED:'false'},d.id,actor,f.broker.fetcher);assert.equal(f.broker.posts,1);
});

test('managed runtime denies insufficient cash, unowned sale, unknown instrument and stale/changed broker evidence with zeroPOST',async t=>{
 const f=await fixture(t);
 for(const [id,input] of [['too-much-cash',{qty:996}],['unowned-sale',{side:'sell',qty:1}]])await assert.rejects(execute(f,await decision(f,'managed-'+id,input)),/cash|unowned/);
 await assert.rejects(decision(f,'managed-unknown',{symbol:'UNKNOWN',qty:1}),/approved instrument/);
 const d=await decision(f,'managed-stale-price',{qty:1});f.broker.stale=true;await assert.rejects(execute(f,d),/Fresh actual IEX/);f.broker.stale=false;
 f.broker.identityChange=true;await assert.rejects(execute(f,d),/identity/);assert.equal(f.broker.posts,0);
});

test('later failed release evidence beforePOST and lease theft block submission without deleting intent',async t=>{
 const f=await fixture(t),d=await decision(f,'managed-late-review',{qty:1});
 const original=f.db.prepare.bind(f.db);let injected=false;
 f.db.prepare=sql=>{const stmt=original(sql);if(!sql.startsWith('INSERT INTO events'))return stmt;const oldBind=stmt.bind;stmt.bind=(...args)=>{oldBind(...args);if(args[1]==='order_intent'&&!injected){const run=stmt.run;stmt.run=async()=>{const result=await run();injected=true;await append(f.db,{id:'late-managed-review-failed',kind:'verification',actor,payload:{check:MANAGED_CHECKS[0],revision,outcome:'failed',author:'independent-reviewer',summary:'Synthetic late withdrawal'}});return result;};}return stmt;};return stmt;};
 await assert.rejects(execute(f,d),/failed|pending/);assert.equal(f.broker.posts,0);assert.equal((await readCompleteHistory(f.db)).filter(e=>e.kind==='order_intent'&&e.payload.decision_id===d.id).length,1);
 const g=await fixture(t),gd=await decision(g,'managed-lease-theft',{qty:1});let stolen=false;g.broker.hook=async(u)=>{if(!stolen&&u.pathname==='/v2/stocks/trades/latest'){stolen=true;g.db.sqlite.prepare("UPDATE locks SET token='stolen' WHERE name='execution'").run();}};
 await assert.rejects(execute(g,gd),/lease/);assert.equal(g.broker.posts,0);
});

async function assertAccountBlocked(f){
 const view=await state(f.db,now(),env),status=await managedStatus(f.db,env);
 assert.equal(view.experiment.status,'paused');assert.equal(view.experiment.phase,'managed_blocked');
 assert.match(view.operation.problem,/Awaiting order\/account checks/);assert.equal(status.problem,view.operation.problem);assert.equal(view.health.trading,'blocked');
}
test('both managed status views show unresolved open orders as awaiting account checks',async t=>{
 const f=await fixture(t);await execute(f,await decision(f,'managed-status-open-order',{qty:1}));
 const recon=await settle(f,'managed-status-open-recon');assert.equal(recon.payload.status,'blocked');await assertAccountBlocked(f);
});
test('both managed status views show unsupported corrections, but not closed or stale observations, as account blocks',async t=>{
 const f=await fixture(t);await decision(f,'managed-status-observed-only',{qty:1});await settle(f,'managed-status-clean');
 const latest=(await readCompleteHistory(f.db)).filter(e=>e.kind==='snapshot').at(-1);
 const old=structuredClone(latest.payload);old.clock.is_open=false;old.clock.timestamp=new Date(Date.now()-3600000).toISOString();for(const q of Object.values(old.quotes))q.market_data_at=old.clock.timestamp;
 await append(f.db,{id:'managed-status-closed-observation',kind:'snapshot',actor,payload:old});
 assert.equal((await state(f.db,now(),env)).operation.problem,null);assert.equal((await managedStatus(f.db,env)).problem,null);
 f.broker.activities.push({id:'managed-unsupported-correction',activity_type:'FILL',type:'trade_correction',order_id:'unsupported',symbol:'SPY',side:'buy',qty:'1',price:'500',transaction_time:now()});
 const recon=await settle(f,'managed-status-correction');assert.equal(recon.payload.status,'blocked');await assertAccountBlocked(f);
});


test('approved unowned target observation stores real research prices without enabling or ordering',async t=>{
 const definition=toolDefs.find(t=>t.name==='managed_portfolio');assert.ok(definition.inputSchema.properties.operation.enum.includes('observe_target'));
 const f=await fixture(t),before=await readCompleteHistory(f.db),calls=[];
 f.broker.hook=async(u,o)=>calls.push({path:u.pathname,method:o.method,symbols:u.searchParams.get('symbols')});
 const input={idempotency_key:'research-target-unh',symbol:'UNH'};
 const snapshot=await observeManagedTarget(f.db,{...env,MANAGED_ENABLED:'false'},input,actor,f.broker.fetcher);
 assert.equal(snapshot.kind,'snapshot');assert.deepEqual(Object.keys(snapshot.payload.quotes).sort(),['SPY','UNH']);
 assert.equal(snapshot.payload.quotes.UNH.price_text,'100');assert.equal(snapshot.payload.quotes.UNH.feed,'iex');
 assert.ok(snapshot.payload.quotes.UNH.market_data_at);assert.ok(snapshot.payload.quotes.UNH.retrieved_at);
 assert.equal(snapshot.payload.target_observation.instrument_id,f.approved.UNH.id);assert.equal(snapshot.payload.target_observation.trading_permitted,false);
 assert.equal(snapshot.payload.positions.some(p=>p.symbol==='UNH'),false);assert.equal(f.broker.posts,0);assert.ok(calls.every(c=>c.method==='GET'));
 const retry=await observeManagedTarget(f.db,env,input,actor,f.broker.fetcher);assert.deepEqual(retry,snapshot);
 await assert.rejects(observeManagedTarget(f.db,env,{...input,symbol:'SPY'},actor,f.broker.fetcher),/different observation/);
 await assert.rejects(refresh(f.db,env,input.idempotency_key,actor,f.broker.fetcher),/different observation/);
 const after=await readCompleteHistory(f.db);assert.deepEqual(after.slice(0,before.length),before);
 assert.ok(after.slice(before.length).every(e=>['snapshot','reconciliation','refresh_failed'].includes(e.kind)));
});

test('target observation rejects unapproved symbols and changed identity; failure creates no price or order',async t=>{
 const f=await fixture(t);let requests=0;f.broker.hook=async()=>requests++;
 for(const symbol of ['UNKNOWN','https://evil.invalid','SPY,UNH',''])await assert.rejects(observeManagedTarget(f.db,env,{idempotency_key:'invalid-target-'+requests,symbol},actor,f.broker.fetcher));
 assert.equal(requests,0);
 await assert.rejects(observeManagedTarget(f.db,env,{idempotency_key:'bad-extra-input',symbol:'UNH',url:'https://evil.invalid'},actor,f.broker.fetcher));
 f.broker.identityChange=true;
 await assert.rejects(observeManagedTarget(f.db,env,{idempotency_key:'changed-target-identity',symbol:'UNH'},actor,f.broker.fetcher));
 assert.equal(await getEvent(f.db,'changed-target-identity'),null);assert.equal(f.broker.posts,0);
});

test('target observation retains stale closed-market prints honestly without execution permission',async t=>{
 const f=await fixture(t);f.broker.stale=true;
 const fetcher=async(url,options)=>new URL(url).pathname==='/v2/clock'?Response.json({is_open:false,timestamp:now(),next_open:new Date(Date.now()+86400000).toISOString(),next_close:new Date(Date.now()+2*86400000).toISOString()}):f.broker.fetcher(url,options);
 const result=await observeManagedTarget(f.db,env,{idempotency_key:'closed-target-observation',symbol:'UNH'},actor,fetcher);
 assert.equal(result.payload.clock.is_open,false);assert.ok(result.payload.quotes.UNH.age_seconds>120);assert.equal(result.payload.execution_ready,false);assert.equal(result.payload.target_observation.trading_permitted,false);assert.equal(f.broker.posts,0);
 await assert.rejects(observeManagedTarget(f.db,env,{idempotency_key:'failed-target-observation',symbol:'UNH'},actor,async()=>new Response('{}',{status:503})));
 assert.equal(await getEvent(f.db,'failed-target-observation'),null);
});
