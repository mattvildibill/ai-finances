import test from 'node:test';import assert from 'node:assert/strict';
import {managedOrderCheck,transitionManaged,managedAuthorization,managedDecision,MANAGED_RULES,MANAGED_CHECKS,MANAGED_AUTHORIZATION,managedControl} from '../lib/managed-policy.js';
import {initialPortfolio,toNanoPortfolio,applyFill} from '../lib/finance.js';
import {append,getEvent,canonical} from '../lib/store.js';import {readCompleteHistory} from '../lib/history.js';
import {temporaryDatabase,testEnv} from './helpers.js';import {completedPilot} from './universe-fixtures.js';
const now=()=>new Date().toISOString(),rev='c'.repeat(40),env={...testEnv,RELEASE_REVISION:rev,MANAGED_ENABLED:'true'},actor='managed-test-manager';
function context(portfolio=toNanoPortfolio(initialPortfolio())){return {portfolio,now:now(),valid_until:new Date(Date.now()+60000).toISOString(),ends_at:new Date(Date.now()+180*86400000).toISOString(),snapshot:{retrieved_at:now(),clock:{timestamp:now(),is_open:true,next_close:new Date(Date.now()+3600000).toISOString(),next_open:new Date(Date.now()+86400000).toISOString()},quotes:Object.fromEntries(['UNH','SPY',...Object.keys(portfolio.holdings)].map(s=>[s,{price:100,market_data_at:now(),feed:'iex'}])),open_orders:[],account:{cash_text:String(Number(portfolio.cash_nanos)/1e9)},positions:Object.entries(portfolio.holdings).map(([symbol,h])=>({symbol,quantity:h.quantity,cost_basis_text:String(Number(h.cost_nanos)/1e9)}))}};}
const buy={symbol:'UNH',side:'buy',quantity:500,limit_price_cents:10000};
test('managed sizing permits50k concentration and fully funded buys with zero cash floor or turnover cap',()=>{
 let c=context();assert.equal(managedOrderCheck(buy,c).ok,true);assert.equal(managedOrderCheck({...buy,quantity:1000},c).ok,true);assert.equal(managedOrderCheck({...buy,quantity:1001},c).ok,false);
 assert.equal(managedOrderCheck({...buy,quantity:1000},{...c,fee_reserve_cents:1}).ok,false);
 c.portfolio.cash_nanos='99999999999999';c.snapshot.account.cash_text='99999.999999999';assert.equal(managedOrderCheck({...buy,quantity:1000},c).ok,false);
 c=context();c.snapshot.quotes.UNH.price=150;assert.equal(managedOrderCheck({...buy,quantity:1000},c).ok,true,'limit maximum spend controls; last mark is not a forced higher fill');
});
test('owned sales preserve exact basis/realized cash and actual proceeds can be reinvested',()=>{
 let p=toNanoPortfolio(initialPortfolio());const fill=(id,side,quantity,price_text)=>({id,symbol:'UNH',side,quantity,price_text,fee_cents:0,occurred_at:now(),observed_at:now()});
 p=applyFill(p,fill('purchase','buy',500,'100'));assert.equal(managedOrderCheck({...buy,side:'sell',quantity:501},context(p)).ok,false);assert.equal(managedOrderCheck({...buy,side:'sell',quantity:250},context(p)).ok,true);
 p=applyFill(p,fill('partial-sale','sell',250,'120'));assert.equal(p.cash_nanos,'80000000000000');assert.equal(p.realized_pnl_nanos,'5000000000000');assert.equal(p.holdings.UNH.cost_nanos,'25000000000000');
 const full=fill('final-sale','sell',250,'120');p=applyFill(p,full);assert.equal(p.cash_nanos,'110000000000000');assert.equal(p.realized_pnl_nanos,'10000000000000');assert.deepEqual(p.holdings,{});assert.deepEqual(applyFill(p,full),p);
 assert.equal(managedOrderCheck({...buy,quantity:1100},context(p)).ok,true,'initial100k is not a turnover or reinvestment ceiling');assert.equal(managedOrderCheck({...buy,side:'sell',quantity:1},context(p)).ok,false);
});
test('managed orders reject closed/stale/future data, open commitments, expiry and account differences',()=>{
 for(const change of [c=>c.snapshot.clock.is_open=false,c=>c.snapshot.clock.next_close=c.now,c=>c.snapshot.quotes.UNH.market_data_at=new Date(Date.now()-121000).toISOString(),c=>c.snapshot.quotes.SPY.market_data_at=new Date(Date.now()+60000).toISOString(),c=>c.snapshot.retrieved_at='bad',c=>c.snapshot.open_orders=[{id:'pending'}],c=>c.snapshot.account.cash_text='100001',c=>c.valid_until=c.now,c=>c.ends_at=c.now,c=>c.ends_at='bad',c=>c.snapshot.positions=[{symbol:'EXTRA',quantity:1,cost_basis_text:'100'}]]){const c=context();change(c);assert.equal(managedOrderCheck(buy,c).ok,false);}
 for(const quantity of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1])assert.equal(managedOrderCheck({...buy,quantity},context()).ok,false);
});
async function transition(t){const {db}=temporaryDatabase(t),pilot=await completedPilot(db);const checks={};for(const check of MANAGED_CHECKS){const id='managed-'+check;await append(db,{id,kind:'verification',actor,payload:{check,revision:rev,outcome:'passed',author:'independent-'+check,summary:'Isolated review fixture; no production claim'}});checks[check]=id;}
 const payload={protocol_version:1,status:'approved',authorization_reference:MANAGED_AUTHORIZATION,revision:rev,author:actor,rules:MANAGED_RULES,checks};const before=await readCompleteHistory(db);const m=await transitionManaged(db,env,{idempotency_key:'managed-transition',payload},actor);return {db,pilot,payload,m,before};}
test('standing transition preserves inception and holdings, expires180days from original, needs no open session and is idempotent',async t=>{
 const {db,pilot,payload,m,before}=await transition(t);assert.equal(m.payload.opening_id,pilot.opening.id);assert.equal(m.payload.ends_at,new Date(Date.parse(pilot.opening.created_at)+180*86400000).toISOString());
 assert.deepEqual(await transitionManaged(db,env,{idempotency_key:m.id,payload},actor),m);for(const e of before)assert.deepEqual(await getEvent(db,e.id),e);
 assert.equal(managedAuthorization(await readCompleteHistory(db),rev,new Date(Date.now()+86400000).toISOString()).mandate.id,m.id);
 await assert.rejects(transitionManaged(db,env,{idempotency_key:'second-transition',payload},actor),/already/);
 await managedControl(db,env,{idempotency_key:'managed-pause',payload:{mandate_id:m.id,status:'paused',author:actor,reason:'Review new evidence'}},actor);assert.throws(()=>managedAuthorization([...before,m,{kind:'managed_control',created_at:now(),payload:{mandate_id:m.id,status:'paused'}}],rev),/paused/);
});
test('later pending/failed same-release reviews and revised authority fail closed',async t=>{
 const {db,m}=await transition(t),events=await readCompleteHistory(db);for(const outcome of ['pending','failed'])assert.throws(()=>managedAuthorization([...events,{seq:m.seq+1,kind:'verification',payload:{check:MANAGED_CHECKS[0],revision:rev,outcome}}],rev),/failed|pending/);
 assert.throws(()=>managedAuthorization(events,'d'.repeat(40)),/release/);assert.throws(()=>managedAuthorization(events,rev,m.payload.ends_at),/expired/);
});
