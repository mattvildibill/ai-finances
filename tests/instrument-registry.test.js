import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical} from '../lib/store.js';
import {INSTRUMENT_REGISTRY,compilePolicyRegistry,CONFIGURATION_VERSIONS,policyDigest,policyForVersion,candidatePolicyVersions,policyVersionAt,registeredInstrument} from '../lib/investment-policy.js';
import {approvedPrimaryActionSource} from '../lib/issuer-source-policy.js';
const definitions=[{version:1,parent_version:null,symbols:['AAPL','MSFT','SPY']},{version:2,parent_version:1,symbols:['AAPL','MSFT','SPY','IJR']}];
const hypothetical={...INSTRUMENT_REGISTRY,TEST:{symbol:'TEST',instrument_type:'stock',asset_class:'us_equity',primary_sources:{hosts:[],urls:['https://example.org/isolated-fixture-only']}}};
const third={version:3,parent_version:2,symbols:['AAPL','MSFT','SPY','IJR','TEST']};
const amendment=(registry,id,seq,from,to,previous,at)=>({id,seq,kind:'mandate_amendment',created_at:at,payload:{from_version:from,configuration_version:to,mandate_version:to,status:'approved',configuration:canonical(registry.policyForVersion(to)),effective_at:at,...(previous?{previous_amendment_id:previous}:{})}});
test('registry retains exact historical canonical policies and admits no unregistered actual candidate',async()=>{
 assert.equal(await policyDigest(1),'cef281ea88344441b877f36731c895411a1812f57a2021efd0c410d35a411acb');
 assert.equal(await policyDigest(2),'30fd4f563ed9dd0bbe8bac8a6213dd446f65b2658a423583afecf7cc475a690e');
 assert.deepEqual(CONFIGURATION_VERSIONS,[1,2]);assert.deepEqual(candidatePolicyVersions(1),[2]);assert.deepEqual(candidatePolicyVersions(2),[]);
 for(const v of [null,0,-1,3,'2',{},2.1])assert.throws(()=>policyForVersion(v));
 assert.equal(registeredInstrument('TEST',2),null);assert.equal(approvedPrimaryActionSource('TEST','https://example.org/isolated-fixture-only',2),false);
 assert.equal(policyVersionAt([]),1);assert.throws(()=>{INSTRUMENT_REGISTRY.IJR.instrument_type='stock';},TypeError);
});
test('pure compiler supports future reviewed additions and chained historical as-of resolution without enabling them in runtime',()=>{
 const registry=compilePolicyRegistry(hypothetical,[...definitions,third]);
 assert.deepEqual(registry.candidatePolicyVersions(2),[3]);assert.equal(registry.policyParentVersion(3),2);
 assert.equal(registry.policyForVersion(3).instruments.at(-1).max_weight,.10);
 assert.deepEqual(registry.policyForVersion(3).limits,policyForVersion(1).limits);
 const a=amendment(registry,'first',10,1,2,null,'2026-10-27T14:00:00Z'),b=amendment(registry,'second',20,2,3,'first','2026-10-28T14:00:00Z');
 assert.equal(registry.policyVersionAt([a,b],'2026-10-27T13:59:59Z'),1);
 assert.equal(registry.policyVersionAt([a,b],'2026-10-27T14:00:00Z'),2);
 assert.equal(registry.policyVersionAt([a,b],'2026-10-28T14:00:00Z'),3);
 assert.equal(registry.latestPolicyAmendment([a,b],'2026-10-28T14:00:00Z').id,'second');
 for(const patch of [{previous_amendment_id:'wrong'},{previous_amendment_id:undefined},{from_version:1},{mandate_version:2},{configuration:'{}'},{status:'pending'},{effective_at:'2020-01-01T00:00:00Z'}])assert.throws(()=>registry.policyVersionAt([a,{...b,payload:{...b.payload,...patch}}],'2026-10-28T15:00:00Z'));
 assert.throws(()=>registry.policyVersionAt([b],'2026-10-28T15:00:00Z'));
 assert.throws(()=>policyForVersion(3));
 assert.throws(()=>compilePolicyRegistry(hypothetical,[...definitions,third,{version:4,parent_version:1,symbols:['AAPL','MSFT','SPY','TEST']}]));
});
test('registry compiler rejects unsupported products, arbitrary symbols, deletions and changed historical classification',()=>{
 for(const e of [{...hypothetical.TEST,instrument_type:'leveraged_etf'},{...hypothetical.TEST,asset_class:'crypto'},{...hypothetical.TEST,symbol:'OTHER'},{...hypothetical.TEST,primary_sources:{hosts:[],urls:[]}}])assert.throws(()=>compilePolicyRegistry({...hypothetical,TEST:e},[...definitions,third]));
 for(const d of [{...third,symbols:['AAPL','MSFT','SPY','TEST']},{...third,symbols:['AAPL','MSFT','SPY','IJR']},{...third,parent_version:9},{...third,symbols:[...third.symbols,'TEST']},{...third,symbols:[...third.symbols,'UNKNOWN']}])assert.throws(()=>compilePolicyRegistry(hypothetical,[...definitions,d]));
 assert.throws(()=>compilePolicyRegistry({...hypothetical,AAPL:{...hypothetical.AAPL,instrument_type:'diversified_equity_etf'}},definitions));
});
