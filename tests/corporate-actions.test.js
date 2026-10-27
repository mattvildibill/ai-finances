import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCorporateActions } from '../lib/corporate-actions.js';
import { alpaca } from '../lib/alpaca.js';
import { listEvents } from '../lib/store.js';
import { temporaryDatabase,testEnv } from './helpers.js';
const query={idempotency_key:'actions-fixture-001',start:'2026-10-01',end:'2026-10-27'};
const actor='synthetic:actions';
test('action acquisition uses fixed data host GET, all quality/types, pagination and immutable retry',async t=>{
 const {db}=temporaryDatabase(t);let calls=0;
 const fetcher=async(url,options)=>{calls++;const u=new URL(url);assert.equal(u.origin,'https://data.alpaca.markets');assert.equal(u.pathname,'/v1/corporate-actions');assert.equal(options.method,'GET');assert.equal(u.searchParams.get('types'),null);assert.equal(u.searchParams.get('data_quality'),'all');assert.equal(u.searchParams.get('symbols'),'AAPL,MSFT,SPY');
  if(calls===1)return Response.json({corporate_actions:{cash_dividends:[{id:'incomplete-announcement',symbol:'SPY'}],spin_offs:[{id:'unsupported-action'}]},next_page_token:'next'});
  assert.equal(u.searchParams.get('page_token'),'next');return Response.json({corporate_actions:{},next_page_token:null});};
 const first=await collectCorporateActions(db,testEnv,query,actor,fetcher);assert.equal(first.payload.status,'evidence_only');assert.equal(first.payload.trading_permitted,false);assert.equal(first.payload.pages.length,2);
 assert.deepEqual(await collectCorporateActions(db,testEnv,query,actor,fetcher),first);assert.equal(calls,2);
 await assert.rejects(collectCorporateActions(db,testEnv,{...query,end:'2026-10-28'},actor,fetcher),/different query/);
 const rows=await listEvents(db,new Date().toISOString());assert.equal(rows.filter(e=>e.kind==='ledger_fill'||e.kind==='experiment_opened').length,0);
});
test('repeated pages and malformed action responses are preserved and fail closed',async t=>{
 for(const body of [{corporate_actions:{},next_page_token:'repeat'},{corporate_actions:[]}]){
  const {db}=temporaryDatabase(t);await assert.rejects(collectCorporateActions(db,testEnv,query,actor,async()=>Response.json(body)),/pagination|shape/);
  const rows=await listEvents(db,new Date().toISOString());assert.ok(rows.some(e=>e.kind==='corporate_action_page'));assert.ok(rows.some(e=>e.kind==='corporate_action_fetch_failed'));assert.ok(!rows.some(e=>e.kind==='corporate_action_fetch'));
 }
});
test('corporate-action transport exception does not permit a paper/live POST or arbitrary v1 path',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({});};
 for(const options of [{data:false},{data:true,method:'POST'}])await assert.rejects(alpaca(testEnv,'/v1/corporate-actions',{...options,fetcher}),/Invalid Alpaca path/);
 await assert.rejects(alpaca(testEnv,'/v1/other',{data:true,fetcher}),/Invalid Alpaca path/);assert.equal(calls,0);
});
