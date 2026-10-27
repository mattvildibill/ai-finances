import test from 'node:test';
import assert from 'node:assert/strict';
import {collectCorporateActions} from '../lib/corporate-actions.js';
import {actionEvents,recordActionEvidence,confirmCorporateAction,approveActionCoverage,coverageState} from '../lib/action-settlement.js';
import {actionCoverage,actionApproval,marketDate,replaySharedActions,normalizeAction} from '../lib/action-ledger.js';
import {policyCanonical,policyDigest,symbolsForVersion,policyVersionAt} from '../lib/investment-policy.js';
import {IJR_PRIMARY_PRODUCT} from '../lib/issuer-source-policy.js';
import {createBenchmark} from '../lib/finance.js';
import {append,canonical} from '../lib/store.js';
import {temporaryDatabase,testEnv} from './helpers.js';
import {seedCoverage} from './action-fixtures.js';
const actor='synthetic:version-tests';const now=()=>new Date().toISOString();const day=()=>marketDate(now());
const fetchActions=response=>async(url,options)=>{assert.equal(new URL(url).origin,'https://data.alpaca.markets');assert.equal(options.method,'GET');return Response.json(response);};
const query=(id,version=2)=>({idempotency_key:id,start:day(),end:day(),configuration_version:version});
async function candidateSource(db,symbol='IJR'){
 const url={AAPL:'https://investor.apple.com/test',MSFT:'https://news.microsoft.com/test',SPY:'https://www.ssga.com/test',IJR:IJR_PRIMARY_PRODUCT}[symbol];
 return recordActionEvidence(db,{idempotency_key:'source-candidate-'+symbol,kind:'action_source',payload:{configuration_version:2,symbol,url,observed_at:now(),excerpt:'Synthetic evidence only',content_sha256:'a'.repeat(64)}},actor);
}
async function candidateCoverage(db,{omitIJR=false,reuseV1Binding=false}={}){
 const fetch=await collectCorporateActions(db,testEnv,query('candidate-coverage-fetch'),actor,fetchActions({corporate_actions:{}}));
 const source_ids=[];for(const symbol of symbolsForVersion(2).filter(s=>!omitIJR||s!=='IJR'))source_ids.push((await candidateSource(db,symbol)).id);
 const core={configuration_version:2,configuration:policyCanonical(2),date:day(),policy:'ordinary-cash-and-whole-splits-v1',fetch_id:fetch.id,source_ids,action_ids:[]};
 const binding=canonical(reuseV1Binding?Object.fromEntries(Object.entries(core).filter(([k])=>!['configuration_version','configuration'].includes(k))):core);const review_ids=[];
 for(const author of ['version-reviewer-one','version-reviewer-two'])review_ids.push((await recordActionEvidence(db,{idempotency_key:author,kind:'coverage_review',payload:{configuration_version:2,author,status:'approved',binding}},author)).id);
 return approveActionCoverage(db,{idempotency_key:'candidate-coverage-approved',payload:{...core,status:'approved',review_ids}},'version-manager');
}
function amendment(at){return {id:'prospective-mandate-v2',kind:'mandate_amendment',actor,payload:{from_version:1,configuration_version:2,mandate_version:2,status:'approved',configuration:policyCanonical(2),effective_at:at}};}

test('candidate-only acquisition/source stays evidence-only and leaves existing active-v1 coverage intact',async t=>{
 const {db}=temporaryDatabase(t);const prior=await seedCoverage(db);const calls=[];
 const result=await collectCorporateActions(db,testEnv,query('ijr-candidate-only'),actor,async(url,options)=>{calls.push({url,method:options.method});return Response.json({corporate_actions:{cash_dividends:[{id:'candidate-dividend',symbol:'IJR',cusip:'fixture',rate:'0.01',special:false,foreign:false,ex_date:day(),payable_date:day()}]}});});
 await candidateSource(db);assert.equal(result.payload.configuration_version,2);assert.equal(result.payload.configuration_digest,await policyDigest(2));assert.equal(new URL(calls[0].url).searchParams.get('symbols'),'AAPL,MSFT,SPY,IJR');assert.ok(calls.every(c=>c.method==='GET'));
 const events=await actionEvents(db);assert.equal(policyVersionAt(events),1);assert.equal((await coverageState(db)).ok,true);assert.equal((await coverageState(db)).coverage_id,prior.id);assert.equal(actionCoverage(events,now(),2).ok,false);
});

test('shared-symbol adverse rows and all-symbol candidate failures still invalidate active-v1 coverage',async t=>{
 for(const mode of ['shared','failure']){
  const {db}=temporaryDatabase(t);await seedCoverage(db);
  if(mode==='shared')await collectCorporateActions(db,testEnv,query('shared-candidate-adverse'),actor,fetchActions({corporate_actions:{spin_offs:[{id:'shared-unsupported',symbol:'SPY',cusip:'fixture',ex_date:day()}]}}));
  else await assert.rejects(collectCorporateActions(db,testEnv,query('candidate-source-failure'),actor,async()=>new Response('{}',{status:503})),/HTTP 503/);
  const result=await coverageState(db);assert.equal(result.ok,false);assert.ok(result.problems.some(p=>/Unsupported|New action evidence/.test(p)));
 }
});

test('v2 coverage requires all four sources and new config-bound reviews; legacy review binding cannot graduate',async t=>{
 for(const option of [{omitIJR:true},{reuseV1Binding:true}]){const {db}=temporaryDatabase(t);await assert.rejects(candidateCoverage(db,option),/every approved symbol|Invalid independent/);}
 const {db}=temporaryDatabase(t);const coverage=await candidateCoverage(db);assert.equal(coverage.payload.configuration_version,2);assert.equal((await coverageState(db,now(),2)).ok,true);
 const before=await actionEvents(db);assert.equal(policyVersionAt(before),1);assert.equal((await coverageState(db)).ok,false);
 const at=now();await append(db,amendment(at),at);assert.equal(policyVersionAt(await actionEvents(db)),2);assert.equal((await coverageState(db)).ok,true);
 const old=(await actionEvents(db)).filter(e=>e.kind!=='mandate_amendment');assert.equal(actionCoverage(old,now()).ok,false);
});

test('candidate IJR confirmation is config-bound and has zero pre-admission holdings in economic replay',async t=>{
 const {db}=temporaryDatabase(t);const start='2026-10-01T14:00:00.000Z';
 const opening=await append(db,{id:'version-opening-fixture',kind:'experiment_opened',actor,payload:{started_at:start,initial_cash_cents:10000000,benchmark:createBenchmark({started_at:start,observed_at:start,market_time:start,price_cents:50000})}},start);
 const raw={id:'ijr-reviewed-action',symbol:'IJR',cusip:'fixture',rate:'0.25',special:false,foreign:false,ex_date:'2026-10-05',record_date:'2026-10-05',payable_date:'2026-10-09'};
 const fetch=await collectCorporateActions(db,testEnv,query('ijr-action-candidate'),actor,fetchActions({corporate_actions:{cash_dividends:[raw]}}));
 const terms=normalizeAction('cash_dividends',raw,2);const source=await recordActionEvidence(db,{idempotency_key:'ijr-terms-primary',kind:'action_source',payload:{configuration_version:2,symbol:'IJR',url:IJR_PRIMARY_PRODUCT,observed_at:now(),excerpt:'Synthetic matching terms',content_sha256:'b'.repeat(64),terms}},actor);
 const core={configuration_version:2,configuration:policyCanonical(2),action_id:raw.id,raw_event_id:fetch.payload.pages[0],raw_signature:canonical({type:'cash_dividends',raw}),source_id:source.id,source_digest:source.digest,terms};const review_ids=[];
 for(const author of ['ijr-reviewer-one','ijr-reviewer-two'])review_ids.push((await recordActionEvidence(db,{idempotency_key:author,kind:'action_review',payload:{configuration_version:2,author,status:'approved',binding:canonical(core)}},author)).id);
 const input={configuration_version:2,action_id:raw.id,raw_event_id:fetch.payload.pages[0],source_id:source.id,review_ids};await confirmCorporateAction(db,input,'ijr-review-manager');
 let events=await actionEvents(db);assert.throws(()=>actionApproval(events,{...input,configuration_version:1},'another-manager'),/Exact raw/);
 const before=replaySharedActions(opening,events,now());assert.deepEqual(before.pending,[]);assert.deepEqual(before.problems,[]);assert.equal(before.economic.active.income_cents,0);
 const at=now();await append(db,amendment(at),at);events=await actionEvents(db);const after=replaySharedActions(opening,events,now());assert.deepEqual(after.problems,[]);assert.equal(after.pending.length,2);assert.deepEqual(after.pending[0].payload.quantities,{active:0,benchmark:0});assert.equal(after.economic.active.income_cents,0);assert.equal(after.economic.benchmark.income_cents,0);
});

test('default acquisition resolves immutable active configuration and candidate retry cannot change scope',async t=>{
 const {db}=temporaryDatabase(t);const first=await collectCorporateActions(db,testEnv,{idempotency_key:'default-before-admission',start:day(),end:day()},actor,fetchActions({corporate_actions:{}}));assert.equal(first.payload.query.symbols,'AAPL,MSFT,SPY');assert.equal(first.payload.configuration_version,undefined);
 const at=now();await append(db,amendment(at),at);const second=await collectCorporateActions(db,testEnv,{idempotency_key:'default-after-admission',start:day(),end:day()},actor,fetchActions({corporate_actions:{}}));assert.equal(second.payload.query.symbols,'AAPL,MSFT,SPY,IJR');assert.equal(second.payload.configuration_version,2);
 await assert.rejects(collectCorporateActions(db,testEnv,{idempotency_key:'default-before-admission',start:day(),end:day()},actor,fetchActions({corporate_actions:{}})),/different query or configuration/);
});


test('current v1 and candidate v2 coverage can coexist after all shared source observations are reviewed',async t=>{
 const {db}=temporaryDatabase(t);const initial=await seedCoverage(db);const candidate=await candidateCoverage(db);
 const core={date:day(),policy:'ordinary-cash-and-whole-splits-v1',fetch_id:initial.payload.fetch_id,source_ids:candidate.payload.source_ids.filter(id=>!id.endsWith('IJR')),action_ids:[]};const review_ids=[];
 for(const author of ['shared-v1-review-one','shared-v1-review-two'])review_ids.push((await recordActionEvidence(db,{idempotency_key:author,kind:'coverage_review',payload:{author,status:'approved',binding:canonical(core)}},author)).id);
 const current=await approveActionCoverage(db,{idempotency_key:'shared-current-v1-coverage',payload:{...core,status:'approved',review_ids}},'shared-v1-manager');
 assert.equal((await coverageState(db)).coverage_id,current.id);assert.equal((await coverageState(db)).ok,true);assert.equal((await coverageState(db,now(),2)).coverage_id,candidate.id);assert.equal((await coverageState(db,now(),2)).ok,true);assert.equal(policyVersionAt(await actionEvents(db)),1);
});
