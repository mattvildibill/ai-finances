import test from 'node:test';
import assert from 'node:assert/strict';
import {temporaryDatabase,testEnv} from './helpers.js';
import {append,listEvents,canonical} from '../lib/store.js';
import {createNanoBenchmark} from '../lib/finance.js';
import {MANAGED_RULES,MANAGED_AUTHORIZATION} from '../lib/managed-policy.js';
import {inspectManagedInstrument,managedInstrumentCandidate,approveManagedInstrument} from '../lib/managed-instruments.js';
import {collectManagedActions,recordManagedAction,managedActionCandidate,managedCoverageCandidate,managedCoverage,managedReplay,managedActionScope} from '../lib/managed-actions.js';
import {marketDate,normalizeAction} from '../lib/action-ledger.js';
import {readLedger} from '../lib/reconciliation.js';
import {seedAction} from './action-fixtures.js';
const now=()=>new Date().toISOString(),actor='isolated-manager';
const history=db=>listEvents(db,now(),1000);
async function fixture(t,{notice=true}={}){
 const {db}=temporaryDatabase(t),started=new Date(Date.now()-4*86400000).toISOString();
 const opening=await append(db,{id:'original-opening',kind:'experiment_opened',actor,payload:{accounting_policy:'usd-nano-v1',initial_cash_cents:10000000,started_at:started,benchmark:createNanoBenchmark({started_at:started,observed_at:started,market_time:started,price_text:'100'})}},started);
 const mandate=await append(db,{id:'managed-mandate-test',kind:'managed_mandate',actor,payload:{protocol_version:1,status:'approved',authorization_reference:MANAGED_AUTHORIZATION,opening_id:opening.id,opening_digest:opening.digest,started_at:started,ends_at:new Date(Date.parse(started)+180*86400000).toISOString(),revision:'a'.repeat(40),author:actor,rules:MANAGED_RULES}});
 const ex=marketDate(new Date(Date.now()-2*86400000).toISOString()),pay=marketDate(new Date(Date.now()-86400000).toISOString());
 const raw={id:'xyz-dividend',symbol:'XYZ',cusip:'123456789',ex_date:ex,record_date:ex,payable_date:pay,process_date:pay,rate:'0.123456789',special:false,foreign:false};
 let response={corporate_actions:notice?{cash_dividends:[raw]}:{},next_page_token:null};const calls=[];
 const fetcher=async(url,options)=>{calls.push({url,method:options.method});assert.equal(options.method,'GET');const u=new URL(url);if(u.pathname.startsWith('/v2/assets/')){const symbol=u.pathname.split('/').at(-1);return Response.json({symbol,id:'broker-'+symbol,name:'Synthetic '+symbol,class:'us_equity',exchange:'ARCA',status:'active',tradable:true});}if(u.pathname==='/v1/corporate-actions')return Response.json(response);throw Error('Unexpected endpoint');};
 const instrument={};for(const symbol of ['SPY','XYZ']){
  const observation=await inspectManagedInstrument(db,testEnv,{idempotency_key:'observe-'+symbol,symbol},actor,fetcher);
  const primary_source={url:'https://issuer.example.com/'+symbol,content_sha256:'a'.repeat(64),observed_at:now(),excerpt:'Synthetic isolated evidence only',publisher_name:'Synthetic issuer',source_type:'issuer'};
  const input={symbol,observation_id:observation.id,research_id:'research-'+symbol,challenge_id:'challenge-'+symbol,classification:symbol==='SPY'?'unleveraged_noninverse_fund':'ordinary_us_stock',issuer_name:'Synthetic issuer',instrument_assessment:'Isolated ordinary share/fund classification; no leverage objective.',primary_source};
  await append(db,{id:input.research_id,kind:'research',actor,payload:{author:'researcher',role:'researcher',evidence:[{url:primary_source.url}]}});
  await append(db,{id:input.challenge_id,kind:'challenge',actor,payload:{author:'challenger',role:'challenger',research_id:input.research_id,evidence:[{url:primary_source.url}],instrument_review:{symbol,observation_id:observation.id,classification:input.classification,source_url:primary_source.url,source_sha256:primary_source.content_sha256,outcome:'supported',source_provenance_verified:true,no_leveraged_or_inverse_objective:true,ordinary_stock_or_fund:true}}});
  const c=await managedInstrumentCandidate(db,input);instrument[symbol]=await approveManagedInstrument(db,testEnv,{idempotency_key:'admit-'+symbol,payload:{...input,status:'approved',author:actor,mandate_id:mandate.id,binding:c.binding}},actor);
 }
 const scope=['SPY','XYZ'],query={start:marketDate(started),end:marketDate(new Date(Date.now()+90*86400000).toISOString()),scope_symbols:scope};
 const fetched=await collectManagedActions(db,testEnv,{idempotency_key:'initial-actions',...query},actor,fetcher);
 const sources={};for(const symbol of scope){
  const terms=symbol==='XYZ'&&notice?normalizeAction('cash_dividends',raw,1,scope):undefined;
  sources[symbol]=await recordManagedAction(db,{idempotency_key:'source-'+symbol,kind:'managed_action_source',payload:{symbol,instrument_id:instrument[symbol].id,url:'https://issuer.example.com/'+symbol+'/actions',source_type:'issuer',publisher_name:'Synthetic issuer',content_sha256:'b'.repeat(64),observed_at:now(),excerpt:'Actual-source-shaped isolated fixture, not production evidence',scope_description:'Bounded source scan, no universal absence claim',...(terms?{terms}:{})}},actor);
 }
 if(notice){const input={action_id:raw.id,raw_event_id:fetched.payload.pages[0],source_id:sources.XYZ.id};const candidate=managedActionCandidate(await history(db),input);
  const review=await recordManagedAction(db,{idempotency_key:'action-review',kind:'managed_action_review',payload:{author:'action-reviewer',status:'approved',summary:'Independently checked isolated exact economics',binding:candidate.binding}},actor);
  await recordManagedAction(db,{idempotency_key:'action-confirmation',kind:'managed_action_confirmed',payload:{...input,author:actor,binding:candidate.binding,review_id:review.id}},actor);
 }
 const input={scope_symbols:scope,fetch_id:fetched.id,source_ids:Object.values(sources).map(x=>x.id)},candidate=managedCoverageCandidate(await history(db),input);
 const review=await recordManagedAction(db,{idempotency_key:'coverage-review',kind:'managed_coverage_review',payload:{author:'coverage-reviewer',status:'approved',summary:'Bounded inventory/source scope reviewed, not universal absence',binding:candidate.binding}},actor);
 const coverage=await recordManagedAction(db,{idempotency_key:'coverage-approval',kind:'managed_action_coverage',payload:{...input,status:'approved',author:actor,binding:candidate.binding,review_id:review.id,valid_until:new Date(Date.now()+7*86400000).toISOString()}},actor);
 return {db,opening,mandate,raw,fetcher,calls,query,coverage,scope,instrument,sources,setResponse:r=>response=r};
}
test('scoped current acquisition with unchanged inventory reuses reviewed evidence without a daily reviewer ceremony',async t=>{
 const f=await fixture(t);const before=await history(f.db);assert.equal(managedCoverage(before,now(),f.scope).ok,true);
 await collectManagedActions(f.db,testEnv,{idempotency_key:'repeat-acquisition',...f.query},actor,f.fetcher);
 const after=await history(f.db);assert.equal(managedCoverage(after,now(),f.scope).ok,true);assert.deepEqual(after.slice(0,before.length),before);
 assert.equal(after.filter(e=>e.kind==='managed_coverage_review').length,1);assert.ok(f.calls.every(c=>c.method==='GET'));
 assert.ok(f.calls.filter(c=>c.url.includes('corporate-actions')).every(c=>new URL(c.url).searchParams.get('symbols')==='SPY,XYZ'));
 assert.deepEqual(managedActionScope({holdings:{XYZ:{quantity:1}}},'UNH'),['SPY','UNH','XYZ']);
 assert.equal(managedCoverage(after,now(),['SPY','UNH']).ok,false);
});
test('shared exact distribution replay preserves sold-holder entitlement, broker cash and original benchmark',async t=>{
 const f=await fixture(t);const buyAt=new Date(Date.parse(f.opening.created_at)+86400000).toISOString(),sellAt=new Date(Date.now()-86400000).toISOString();
 const add=async(id,side,occurred,price)=>append(f.db,{id,kind:'ledger_fill',actor,payload:{fill:{id,symbol:'XYZ',side,quantity:3,quantity_text:'3',price_text:price,fee_cents:0,occurred_at:occurred,observed_at:now()}}});
 await add('buy-before-ex','buy',buyAt,'100.000000001');await add('sell-after-ex','sell',sellAt,'101.000000001');
 let events=await history(f.db),result=managedReplay(f.opening,events,now());
 assert.equal(result.portfolio.cash_nanos,'100003000000000');assert.equal(result.portfolio.realized_pnl_nanos,'3000000000');assert.deepEqual(result.portfolio.holdings,{});
 assert.equal(result.economic.active.income_nanos,'370370367');assert.equal(result.economic.active.distribution_cash_nanos,'370370367');assert.equal(result.economic.benchmark.income_nanos,'0');assert.equal(result.pending.length,2);
 for(const p of result.pending)await append(f.db,{...p,actor});events=await history(f.db);result=managedReplay(f.opening,events,now());assert.deepEqual(result.problems,[]);assert.equal(result.pending.length,0);
 const ledger=await readLedger(f.db);assert.equal(ledger.status,'ready');assert.equal(ledger.portfolio.cash_nanos,'100003000000000');assert.equal(ledger.benchmark.holdings.SPY.quantity,1000);
 const historical=await readLedger(f.db,f.opening.created_at);assert.equal(historical.fill_count,0);assert.equal(historical.portfolio.cash_nanos,'100000000000000');
});
test('changed, malformed or unsupported scoped action evidence fails closed and preserves original receipts',async t=>{
 const f=await fixture(t);const base=await history(f.db);
 for(const groups of [{cash_dividends:[{...f.raw,rate:'0.2'}]},{mergers:[{id:'merger',symbol:'XYZ',cusip:'123456789',ex_date:f.raw.ex_date}]},{cash_dividends:[{...f.raw,special:true}]}]){
  const e={id:'adverse',seq:base.at(-1).seq+1,kind:'managed_action_page',created_at:now(),payload:{scope_symbols:f.scope,response:{corporate_actions:groups,next_page_token:null}}};
  assert.equal(managedCoverage([...base,e],now(),f.scope).ok,false);assert.ok(managedReplay(f.opening,[...base,{kind:'ledger_fill',id:'held',seq:base.at(-1).seq+1,created_at:now(),payload:{fill:{id:'held',symbol:'XYZ',side:'buy',quantity:1,price_text:'1',fee_cents:0,occurred_at:now(),observed_at:now()}}},e],now()).problems.length>0);
 }
 f.setResponse({corporate_actions:{cash_dividends:'malformed'}});await assert.rejects(collectManagedActions(f.db,testEnv,{idempotency_key:'failed-retrieval',...f.query},actor,f.fetcher));
 const after=await history(f.db);assert.ok(after.some(e=>e.kind==='managed_action_fetch_failed'));assert.deepEqual(after.slice(0,base.length),base);assert.equal(managedCoverage(after,now(),f.scope).ok,false);
});
test('coverage rejection, unseen target, expiry, unsafe provenance and duplicate shared action all block',async t=>{
 const f=await fixture(t),base=await history(f.db);
 assert.equal(managedCoverage([...base,{id:'rejected',seq:9999,kind:'managed_coverage_review',created_at:now(),payload:{binding:f.coverage.payload.binding,status:'rejected',author:'other'}}],now(),f.scope).ok,false);
 assert.equal(managedCoverage(base,new Date(Date.now()+8*86400000).toISOString(),f.scope).ok,false);
 await assert.rejects(recordManagedAction(f.db,{idempotency_key:'unsafe-source',kind:'managed_action_source',payload:{...f.sources.XYZ.payload,url:'https://127.0.0.1/private'}},actor));
 const c=base.find(e=>e.kind==='managed_action_confirmed');await assert.rejects(recordManagedAction(f.db,{idempotency_key:'duplicate-confirmation',kind:'managed_action_confirmed',payload:c.payload},actor),/already confirmed/);
 assert.equal((await history(f.db)).filter(e=>e.kind==='managed_action_confirmed').length,1);
});
test('legacy shared adverse receipts remain visible while unrelated unheld symbols do not expand managed scope',async t=>{
 const f=await fixture(t,{notice:false}),base=await history(f.db),seq=base.at(-1).seq+1;
 const legacy=(symbol,type='mergers')=>({id:'legacy-'+symbol,seq,kind:'corporate_action_page',created_at:now(),payload:{query:{symbols:'AAPL,MSFT,SPY'},response:{corporate_actions:{[type]:[{id:'legacy-action',symbol,cusip:'123456789',ex_date:marketDate(now())}]},next_page_token:null}}});
 assert.equal(managedCoverage([...base,legacy('AAPL')],now(),f.scope).ok,true);
 assert.equal(managedCoverage([...base,legacy('SPY')],now(),f.scope).ok,false);
 assert.ok(managedReplay(f.opening,[...base,legacy('SPY')],now()).problems.some(p=>p.includes('Unsupported corporate action')));
 const failure={id:'legacy-failure',seq,kind:'corporate_action_fetch_failed',created_at:now(),payload:{query:{symbols:'SPY'}}};
 assert.equal(managedCoverage([...base,failure],now(),f.scope).ok,false);
 const outside={id:'outside-query',seq,kind:'managed_action_page',created_at:now(),payload:{scope_symbols:f.scope,response:{corporate_actions:{cash_dividends:[{...f.raw,symbol:'UNH'}]}}}};
 assert.equal(managedCoverage([...base,outside],now(),f.scope).ok,false);
});

test('managed replay reuses original legacy SPY confirmation without duplicate economics',async t=>{
 const f=await fixture(t,{notice:false});
 const legacy=await seedAction(f.db,{...f.raw,id:'legacy-spy',symbol:'SPY',rate:'0.25'}),events=await history(f.db);
 const result=managedReplay(f.opening,events,now());
 assert.deepEqual(result.problems,[]);assert.equal(result.economic.benchmark.income_nanos,'250000000000');
 assert.equal(result.economic.active.income_nanos,'0');assert.equal(result.pending.length,2);
 assert.ok(result.pending.every(e=>e.payload.confirmation_id===legacy.confirmation.id));
 assert.equal(events.filter(e=>e.kind==='action_confirmed').length,1);
});
