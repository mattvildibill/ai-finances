import test from 'node:test';
import assert from 'node:assert/strict';
import {append,canonical,listEvents} from '../lib/store.js';
import {temporaryDatabase,testEnv} from './helpers.js';
import {inspectManagedInstrument,managedInstrumentCandidate,approveManagedInstrument,managedInstrumentFor,assertManagedAsset,observeManaged,managedSymbol,assertPublicEvidenceURL} from '../lib/managed-instruments.js';
const actor='isolated-manager',now=()=>new Date().toISOString();
function fakeBroker(changes={}){
 const calls=[];
 const asset=symbol=>({id:'broker-'+symbol,symbol,name:'Ordinary '+symbol,status:'active',tradable:true,class:'us_equity',exchange:'NASDAQ',...changes.asset});
 const fetcher=async(url,o)=>{calls.push([url,o.method]);const u=new URL(url);assert.equal(o.method,'GET');assert.ok(['https://paper-api.alpaca.markets','https://data.alpaca.markets'].includes(u.origin));
 if(changes.fail)return new Response('{}',{status:changes.fail});
 if(u.pathname.startsWith('/v2/assets/'))return Response.json(asset(u.pathname.split('/').at(-1)));
 if(u.pathname==='/v2/account')return Response.json({id:'account-1234',status:'ACTIVE',currency:'USD',cash:'100000',equity:'100000',portfolio_value:'100000',...changes.account});
 if(u.pathname==='/v2/clock')return Response.json({is_open:true,timestamp:now(),next_close:new Date(Date.now()+3600000).toISOString(),next_open:new Date(Date.now()+86400000).toISOString(),...changes.clock});
 if(u.pathname==='/v2/positions')return Response.json(changes.positions??[]);
 if(u.pathname==='/v2/orders')return Response.json(changes.orders??[]);
 if(u.pathname==='/v2/stocks/trades/latest')return Response.json({trades:Object.fromEntries(u.searchParams.get('symbols').split(',').filter(s=>s!==changes.missing).map(s=>[s,{p:100,t:now(),...changes.trade}]))});
 throw new Error('Unexpected endpoint');};return {fetcher,calls,asset};
}
async function prepare(t,symbol='UNH',classification='ordinary_us_stock'){
 const {db}=temporaryDatabase(t),broker=fakeBroker();
 const mandate=await append(db,{id:'managed-mandate-fixture',kind:'managed_mandate',payload:{status:'approved'},actor});
 const observation=await inspectManagedInstrument(db,testEnv,{idempotency_key:'asset-observation-fixture',symbol},actor,broker.fetcher);
 const primary_source={url:'https://issuer.example.com/investors',content_sha256:'a'.repeat(64),observed_at:now(),excerpt:'Synthetic primary evidence identifying ordinary common shares; no actual issuer evidence claimed.',publisher_name:'Synthetic issuer',source_type:'issuer'};
 const input={symbol,observation_id:observation.id,research_id:'instrument-research',challenge_id:'instrument-challenge',classification,issuer_name:'Synthetic issuer',instrument_assessment:'Ordinary common shares, no leveraged or inverse objective; isolated fixture.',primary_source};
 await append(db,{id:input.research_id,kind:'research',payload:{author:'independent-researcher',role:'researcher',evidence:[{url:primary_source.url}]},actor});
 await append(db,{id:input.challenge_id,kind:'challenge',payload:{author:'independent-challenger',role:'challenger',research_id:input.research_id,evidence:[{url:primary_source.url}],instrument_review:{symbol,observation_id:observation.id,classification:input.classification,source_url:primary_source.url,source_sha256:primary_source.content_sha256,outcome:'supported',source_provenance_verified:true,no_leveraged_or_inverse_objective:true,ordinary_stock_or_fund:true}},actor});
 const candidate=await managedInstrumentCandidate(db,input);
 const payload={...input,status:'approved',author:'accountable-manager',mandate_id:mandate.id,binding:candidate.binding};
 return {db,broker,input,payload,observation};
}
const events=db=>listEvents(db,now(),1000);
test('on-demand ordinary ticker admitted using actual scoped independent evidence, immutable retry and no source release',async t=>{
 const f=await prepare(t),before=await events(f.db);
 const saved=await approveManagedInstrument(f.db,testEnv,{idempotency_key:'instrument-approval-fixture',payload:f.payload},actor);
 const retry=await approveManagedInstrument(f.db,testEnv,{idempotency_key:saved.id,payload:f.payload},actor);assert.equal(retry.id,saved.id);assert.equal(retry.seq,saved.seq);
 assert.equal(managedInstrumentFor(await events(f.db),'UNH').id,saved.id);assert.equal(managedInstrumentFor(await events(f.db),'ZZZ'),null);
 assert.deepEqual((await events(f.db)).slice(0,before.length),before);assert.equal(saved.payload.classification,'ordinary_us_stock');
 assertManagedAsset(f.broker.asset('UNH'),saved);assert.throws(()=>assertManagedAsset({...f.broker.asset('UNH'),id:'changed'},saved));
 await assert.rejects(approveManagedInstrument(f.db,testEnv,{idempotency_key:saved.id,payload:{...f.payload,instrument_assessment:'Changed'}},actor),/idempotency/);
 const observed=await observeManaged(testEnv,['UNH'],{UNH:saved},f.broker.fetcher);assert.equal(observed.quotes.UNH.price,100);assert.ok(observed.quotes.SPY);assert.equal(observed.managed_mode,true);
 assert.ok(f.broker.calls.every(([,m])=>m==='GET'));assert.ok(f.broker.calls.some(([u])=>u==='https://paper-api.alpaca.markets/v2/assets/UNH'));
});
test('governance identity stays durable without requiring fresh trade timestamps during research',async t=>{
 const f=await prepare(t);const all=await events(f.db);const later=new Date(Date.now()+86400000).toISOString();
 const {managedInstrumentBinding}=await import('../lib/managed-instruments.js');assert.equal(managedInstrumentBinding(all,f.input,later).asset.id,'broker-UNH');
 await approveManagedInstrument(f.db,testEnv,{idempotency_key:'durable-approval',payload:f.payload},actor);
 assert.equal(managedInstrumentFor(await events(f.db),'UNH',later).payload.symbol,'UNH');
});
test('read-only unapproved metadata grants no admission; unsupported identities and approvals fail',async t=>{
 const f=await prepare(t);
 const readOnly=await observeManaged(testEnv,['UNH'],{},f.broker.fetcher);assert.equal(readOnly.asset_metadata.UNH.eligibility_approval_id,null);assert.equal(managedInstrumentFor(await events(f.db),'UNH'),null);
 for(const key of ['classification','binding','mandate_id','author']){const p={...f.payload,[key]:key==='author'?'independent-challenger':'invalid'};await assert.rejects(approveManagedInstrument(f.db,testEnv,{idempotency_key:'reject-'+key,payload:p},actor));}
 for(const asset of [{tradable:false},{status:'inactive'},{class:'crypto'},{exchange:'OTC'},{id:''},{symbol:'DIFFERENT'}])await assert.rejects(inspectManagedInstrument(f.db,testEnv,{idempotency_key:'bad-'+Object.keys(asset)[0],symbol:'ABC'},actor,fakeBroker({asset}).fetcher));
 assert.equal((await events(f.db)).filter(e=>e.kind==='managed_instrument').length,0);
});
test('safe ticker and evidence URL rules reject spoofing, unsupported products and local targets',()=>{
 for(const s of ['../SPY','SPY/','SPY?x',' SPY','spy','BTC/USD','AAPL260101C00100000','https://evil','A'.repeat(11)])assert.throws(()=>managedSymbol(s));
 for(const s of ['SPY','BRK.B','BRK-B','UNH'])assert.equal(managedSymbol(s),s);
 for(const url of ['http://issuer.com','https://user@issuer.com/x','https://issuer.com:8443/x','https://localhost/x','https://127.0.0.1/x','https://[::1]/x','https://issuer.local/x','https://issuer.com/#other','https://xn--issuer-abc.com/x','https://issuer.com\\@evil.com/x','https://issuer.com/a b'])assert.throws(()=>assertPublicEvidenceURL(url),url);
 assert.equal(assertPublicEvidenceURL('https://www.sec.gov/Archives/file.xml'),'https://www.sec.gov/Archives/file.xml');
});
test('later conflicting metadata, failed acquisition, withdrawal and review failure block durable approval',async t=>{
 const f=await prepare(t);const saved=await approveManagedInstrument(f.db,testEnv,{idempotency_key:'adverse-base',payload:f.payload},actor);const base=await events(f.db);
 for(const e of [
 {kind:'managed_asset_observation',payload:{symbol:'UNH',asset:{...saved.payload.asset,id:'changed'}}},
 {kind:'managed_asset_failure',payload:{symbol:'UNH',summary:'Actual source unavailable'}},
 {kind:'revision',payload:{supersedes:f.input.research_id}},
 {kind:'verification',payload:{check:'managed_instrument_review',instrument_id:saved.id,outcome:'failed'}},
 {kind:'verification',payload:{check:'managed_instrument_review',instrument_id:saved.id,outcome:'pending'}}])assert.throws(()=>managedInstrumentFor([...base,{...e,id:'late',seq:saved.seq+1,created_at:now()}],'UNH'),/adverse/);
 const unrelated={id:'unrelated',seq:saved.seq+1,created_at:now(),kind:'managed_asset_failure',payload:{symbol:'OTHER'}};assert.equal(managedInstrumentFor([...base,unrelated],'UNH').id,saved.id);
 const rev=await approveManagedInstrument(f.db,testEnv,{idempotency_key:'instrument-revoked',payload:{symbol:'UNH',status:'revoked',author:'manager',previous_approval_id:saved.id,reason:'New issuer information requires investigation'}},actor);
 const revokedEvents=await events(f.db);assert.throws(()=>managedInstrumentFor(revokedEvents,'UNH'),/revoked/);
 await assert.rejects(approveManagedInstrument(f.db,testEnv,{idempotency_key:'invalid-reapproval',payload:{...f.payload,previous_approval_id:rev.id}},actor),/new independent challenge/);
});
test('observation reports endpoint failure, incomplete data, external holdings and invalid account without invention',async t=>{
 const f=await prepare(t);const approved=await approveManagedInstrument(f.db,testEnv,{idempotency_key:'observe-approval',payload:f.payload},actor);
 for(const overrides of [{fail:503},{missing:'UNH'},{trade:{p:null}},{trade:{t:new Date(Date.now()+60000).toISOString()}},{account:{trading_blocked:true}},{positions:[{symbol:'EXTRA',side:'long',qty:'1'}]},{positions:[{symbol:'UNH',side:'short',qty:'1'}]},{clock:{timestamp:'invalid'}}])await assert.rejects(observeManaged(testEnv,['UNH'],{UNH:approved},fakeBroker(overrides).fetcher));
 await assert.rejects(inspectManagedInstrument(f.db,testEnv,{idempotency_key:'failed-observation',symbol:'UNH'},actor,fakeBroker({fail:404}).fetcher),/HTTP 404/);
 assert.equal((await events(f.db)).at(-1).kind,'managed_asset_failure');const failedEvents=await events(f.db);assert.throws(()=>managedInstrumentFor(failedEvents,'UNH'),/adverse/);
});


test('fund approval explicitly reviews its objective without treating broker options or margin flags as permissions',async t=>{
 const f=await prepare(t,'IJR','unleveraged_noninverse_fund');
 f.payload.instrument_assessment='Fund tracks small US companies without a leveraged/inverse objective; incidental derivatives and securities lending are explicitly disclosed, not account-level options permission.';
 f.payload.binding=(await managedInstrumentCandidate(f.db,f.payload)).binding;
 const approved=await approveManagedInstrument(f.db,testEnv,{idempotency_key:'fund-approval-fixture',payload:f.payload},actor);
 const observed=await observeManaged(testEnv,['IJR'],{IJR:approved},fakeBroker({asset:{marginable:true,shortable:true,fractionable:true,attributes:['has_options']}}).fetcher);
 assert.equal(observed.asset_metadata.IJR.class,'us_equity');assert.equal(observed.asset_metadata.IJR.marginable,undefined);assert.equal(approved.payload.classification,'unleveraged_noninverse_fund');
 assert.match(approved.payload.instrument_assessment,/incidental derivatives/);
});
