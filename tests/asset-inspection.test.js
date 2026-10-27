import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectAsset,observe,assertEligibleAsset,PAPER} from '../lib/alpaca.js';
import {refresh,state} from '../lib/service.js';
import {getEvent,listEvents} from '../lib/store.js';
import {temporaryDatabase,testEnv,brokerFixture} from './helpers.js';
const actor='synthetic:asset-review';
const eligible={id:'fixture-asset-id',name:'Synthetic SPY',symbol:'SPY',status:'active',tradable:true,class:'us_equity',exchange:'ARCA'};

test('asset inspection uses only fixed paper GET and returns sanitized observed metadata without inferred permissions',async()=>{
 const calls=[];
 const metadata=await inspectAsset({...testEnv,ALPACA_BASE_URL:'https://api.alpaca.markets'},'SPY',async(url,options)=>{
  calls.push({url,method:options.method,body:options.body,redirect:options.redirect});
  return Response.json({...eligible,marginable:true,shortable:true,fractionable:true,extra_secret:'not-an-allowed-metadata-field'});
 });
 assert.deepEqual(calls,[{url:PAPER+'/v2/assets/SPY',method:'GET',body:undefined,redirect:'manual'}]);
 assert.deepEqual(Object.fromEntries(Object.entries(metadata).filter(([key])=>!['retrieved_at','source','source_url'].includes(key))),eligible);
 assert.equal(metadata.source_url,PAPER+'/v2/assets/SPY');assert.equal(metadata.source,'Alpaca paper API');assert.ok(Number.isFinite(Date.parse(metadata.retrieved_at)));
 assert.equal(metadata.marginable,undefined);assert.equal(metadata.shortable,undefined);assert.equal(metadata.fractionable,undefined);assert.equal(metadata.extra_secret,undefined);
 let callsOutside=0;await assert.rejects(inspectAsset(testEnv,'https://example.com',async()=>{callsOutside++;}),/approved symbol/);assert.equal(callsOutside,0);
});

test('asset metadata must match identity, active tradability, equity class and approved exchange',async()=>{
 for(const patch of [{symbol:'AAPL'},{status:'inactive'},{tradable:false},{tradable:'true'},{class:'crypto'},{class:'us_option'},{exchange:'OTC'},{symbol:undefined},{exchange:undefined}]){
  const fixture=brokerFixture({asset:patch});await assert.rejects(observe(testEnv,fixture.fetcher),/not a verified/);assert.ok(fixture.calls.every(c=>c.method==='GET'));
 }
 assert.throws(()=>assertEligibleAsset({...eligible,symbol:'PENNY'},'PENNY'),/not a verified/);
});

test('refresh persists real asset endpoint receipt and readback while same-key retry sends no new requests',async t=>{
 const {db}=temporaryDatabase(t);const fixture=brokerFixture();
 const saved=await refresh(db,testEnv,'asset-refresh-fixture',actor,fixture.fetcher);
 const assetCalls=fixture.calls.filter(c=>new URL(c.url).pathname==='/v2/assets/SPY');assert.equal(assetCalls.length,1);assert.equal(assetCalls[0].method,'GET');
 assert.equal(saved.payload.asset_metadata.SPY.symbol,'SPY');assert.equal(saved.payload.asset_metadata.SPY.id,'fixture-spy-asset');
 const count=fixture.calls.length;assert.deepEqual(await refresh(db,testEnv,'asset-refresh-fixture',actor,fixture.fetcher),saved);assert.equal(fixture.calls.length,count);
 const readback=await state(db);assert.deepEqual(readback.latest_snapshot.payload.asset_metadata.SPY,saved.payload.asset_metadata.SPY);assert.equal(readback.experiment.status,'paused');
 assert.equal((await listEvents(db,new Date().toISOString())).some(e=>['order_intent','experiment_opened'].includes(e.kind)),false);assert.ok(fixture.calls.every(c=>c.method==='GET'));
});

test('asset endpoint failure preserves prior snapshot and records failed refresh with no orders',async t=>{
 const {db}=temporaryDatabase(t);const good=brokerFixture();const prior=await refresh(db,testEnv,'asset-good-baseline',actor,good.fetcher);
 const calls=[];const fallback=brokerFixture();const fetcher=async(url,options)=>{calls.push({url,method:options.method});return new URL(url).pathname==='/v2/assets/SPY'?new Response('{}',{status:503}):fallback.fetcher(url,options);};
 await assert.rejects(refresh(db,testEnv,'asset-failed-refresh',actor,fetcher),/HTTP 503/);
 assert.deepEqual(await getEvent(db,prior.id),prior);assert.equal(await getEvent(db,'asset-failed-refresh'),null);
 const readback=await state(db);assert.equal(readback.latest_snapshot.id,prior.id);assert.equal(readback.health.source_status,'failed');
 const events=await listEvents(db,new Date().toISOString());assert.equal(events.filter(e=>e.kind==='refresh_failed').length,1);assert.equal(events.some(e=>e.kind==='order_intent'),false);assert.ok(calls.every(c=>c.method==='GET'));
});
