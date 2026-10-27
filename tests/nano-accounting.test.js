import test from 'node:test';
import assert from 'node:assert/strict';
import {usdNanos,nanosToCents} from '../lib/precision.js';
import {initialPortfolio,toNanoPortfolio,applyFill,portfolioValue,createNanoBenchmark,brokerCashMatches,brokerBasisMatches} from '../lib/finance.js';
import {createOpeningPayload,readLedger,reconcile} from '../lib/reconciliation.js';
import {ledgerView} from '../lib/valuation.js';
import {append,listEvents} from '../lib/store.js';
import {temporaryDatabase,testEnv} from './helpers.js';
import {seedAction,seedCoverage} from './action-fixtures.js';
import {settleCorporateActions} from '../lib/action-settlement.js';
const at='2026-10-01T14:00:00.000Z';
const fill=(id,side,quantity,price)=>({id,symbol:'SPY',side,quantity,price_text:price,occurred_at:at,observed_at:at});
const nano=()=>toNanoPortfolio(initialPortfolio());
function benchmark(start=at,price='500'){return createNanoBenchmark({started_at:start,observed_at:start,market_time:start,price_text:price});}
async function opening(db,start=at){return append(db,{id:'nano-opening-fixture',kind:'experiment_opened',actor:'fixture',payload:{started_at:start,initial_cash_cents:10000000,accounting_policy:'usd-nano-v1',benchmark:benchmark(start)}},start);}
test('nano fills retain exact subcent cash and basis; split fills and retries conserve identical totals',()=>{
 const one=applyFill(nano(),fill('one','buy',3,'500.123456789'));
 let split=nano();for(let i=0;i<3;i++)split=applyFill(split,fill('part'+i,'buy',1,'500.123456789'));
 assert.equal(one.cash_nanos,'98499629629633');assert.equal(one.holdings.SPY.cost_nanos,'1500370370367');
 assert.equal(split.cash_nanos,one.cash_nanos);assert.deepEqual(split.holdings,one.holdings);
 assert.deepEqual(applyFill(one,fill('one','buy',3,'500.123456789')),one);
 assert.equal(one.cash_cents,9849962);assert.ok(brokerCashMatches(one,'98499.629629633'));assert.ok(!brokerCashMatches(one,'98499.63'));
 assert.ok(brokerBasisMatches(one.holdings.SPY,'1500.370370367'));
 assert.throws(()=>applyFill(nano(),fill('precision','buy',1,'500.1234567891')),/precision/);
 assert.throws(()=>applyFill(nano(),fill('quantity','buy',0.5,'500')),/whole/);
 assert.throws(()=>applyFill(initialPortfolio(),fill('legacy','buy',1,'500.123456789')),/fractional-cent/);
});
test('nano partial-sale basis allocation retains smallest-unit residual and closes with conserved P&L',()=>{
 let p=applyFill(nano(),fill('buy1','buy',1,'1.000000001'));p=applyFill(p,fill('buy2','buy',2,'1'));
 const initialCost=BigInt(p.holdings.SPY.cost_nanos);let allocated=0n;
 for(let i=0;i<3;i++){const before=BigInt(p.holdings.SPY.cost_nanos);p=applyFill(p,fill('sell'+i,'sell',1,'1'));allocated+=before-BigInt(p.holdings.SPY?.cost_nanos||'0');}
 assert.equal(allocated,initialCost);assert.equal(p.realized_pnl_nanos,'-1');assert.equal(p.cash_nanos,'99999999999999');assert.deepEqual(p.holdings,{});
 assert.equal(nanosToCents('-1'),-1);assert.equal(nanosToCents('1',{ceil:true}),1);
});
test('nano prospective benchmark preserves a subcent reference and exact residual while legacy rejects it',()=>{
 const now=new Date().toISOString();const payload={feed:'iex',execution_ready:true,clock:{is_open:true,timestamp:now,next_close:new Date(Date.now()+3600000).toISOString(),next_open:new Date(Date.now()+86400000).toISOString()},account:{cash:100000,equity:100000,cash_text:'100000.000000000',equity_text:'100000'},positions:[],open_orders:[],quotes:{SPY:{price:500.123456789,price_text:'500.123456789',market_data_at:now,feed:'iex'}}};
 const event={kind:'snapshot',created_at:now,payload};const opened=createOpeningPayload(event,now,'usd-nano-v1');
 assert.equal(opened.benchmark.reference_price_text,'500.123456789');assert.equal(opened.benchmark.started_at,now);
 assert.equal(BigInt(opened.benchmark.cash_nanos)+BigInt(opened.benchmark.holdings.SPY.cost_nanos),100000000000000n);
 assert.throws(()=>createOpeningPayload(event,now),/fractional-cent/);
});
test('shared nano distributions retain exact entitlement and modeled cash without funding broker cash',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);
 await append(db,{id:'nano-held-fill',kind:'ledger_fill',actor:'fixture',payload:{fill:fill('nano-held','buy',1,'500.123456789')}},at);
 await seedAction(db,{id:'nano-dividend',symbol:'SPY',cusip:'fixture-cusip',rate:'0.123456789',special:false,foreign:false,ex_date:'2026-10-05',record_date:'2026-10-05',payable_date:'2026-10-09'});
 const before=await readLedger(db);const cash=before.portfolio.cash_nanos;
 const saved=await settleCorporateActions(db,'fixture');assert.equal(saved.length,2);
 const result=await readLedger(db);assert.equal(result.status,'ready');assert.equal(result.portfolio.cash_nanos,cash);
 assert.equal(result.economic.active.income_nanos,'123456789');assert.equal(result.economic.active.receivable_nanos,'0');assert.equal(result.economic.active.distribution_cash_nanos,'123456789');
 assert.equal(result.economic.benchmark.income_nanos,'24691357800');assert.equal(saved[0].payload.amounts_nanos.active,'123456789');
 assert.deepEqual(await settleCorporateActions(db,'fixture'),[]);assert.deepEqual((await readLedger(db)).economic,result.economic);
});
test('nano valuation exposes authoritative units with subcent marks and never mistakes rounded cash for agreement',()=>{
 const p=applyFill(nano(),fill('mark-buy','buy',1,'500.123456789'));const marked=portfolioValue(p,{SPY:{nanos:usdNanos('500.123456789').toString()}});assert.equal(marked.value_nanos,'100000000000000');
 const now=new Date().toISOString();const ledger={status:'ready',portfolio:p,benchmark:benchmark(now),started_at:now,last_evidence_seq:1,action_coverage:{ok:true},economic:{active:{receivable_nanos:'0',distribution_cash_nanos:'0'},benchmark:{receivable_nanos:'0',distribution_cash_nanos:'0'}}};
 const snapshot={seq:2,created_at:now,payload:{account:{cash:Number('99499.876543211'),cash_text:'99499.876543211'},positions:[{symbol:'SPY',side:'long',quantity:1,cost_basis:500.123456789,cost_basis_text:'500.123456789'}],quotes:{SPY:{price:500.123456789,price_text:'500.123456789',feed:'iex',market_data_at:now}}}};
 const recon={seq:3,created_at:now,payload:{status:'reconciled',problems:[]}};const view=ledgerView(ledger,snapshot,now,recon);
 assert.equal(view.account_drift,false);assert.equal(view.portfolio.value_nanos,'100000000000000');assert.equal(view.portfolio.cash_nanos,p.cash_nanos);assert.equal(view.portfolio.total_return,0);
 snapshot.payload.account.cash_text='99499.88';snapshot.payload.account.cash=99499.88;assert.equal(ledgerView(ledger,snapshot,now,recon).account_drift,true);
});
test('actual reconciliation path accepts exact nano receipts and preserves unexplained subcent cash differences',async t=>{
 const {db}=temporaryDatabase(t);const start=new Date(Date.now()-10000).toISOString();await opening(db,start);await seedCoverage(db);
 const cid='blue-'+'c'.repeat(40);const order={id:'nano-broker-order',client_order_id:cid,symbol:'SPY',side:'buy',qty:'1',filled_qty:'1',type:'limit',time_in_force:'day',extended_hours:false,asset_class:'us_equity',limit_price:'501.00',status:'filled'};
 await append(db,{id:'nano-intent-fixture',kind:'order_intent',actor:'fixture',payload:{client_order_id:cid,order:{symbol:'SPY',side:'buy',qty:'1',limit_price:'501.00'}}});
 const activity={id:'nano-broker-fill',activity_type:'FILL',type:'fill',order_id:order.id,symbol:'SPY',side:'buy',qty:'1',price:'500.123456789',transaction_time:new Date(Date.now()-1000).toISOString()};let cash='99499.876543211';
 const fetcher=async url=>{const p=new URL(url).pathname;return Response.json(p==='/v2/account/activities/FILL'?[activity]:p==='/v2/orders:by_client_order_id'?order:p==='/v2/account'?{status:'ACTIVE',currency:'USD',cash}:p==='/v2/positions'?[{symbol:'SPY',side:'long',qty:'1',cost_basis:'500.123456789'}]:[]);};
 const first=await reconcile(db,testEnv,'nano-reconcile-1','fixture',fetcher);assert.equal(first.payload.new_fills,1);assert.equal(first.payload.status,'reconciled');assert.equal(first.payload.ledger_cash_nanos,'99499876543211');
 const again=await reconcile(db,testEnv,'nano-reconcile-2','fixture',fetcher);assert.equal(again.payload.new_fills,0);
 cash='99499.876543212';const mismatch=await reconcile(db,testEnv,'nano-reconcile-3','fixture',fetcher);const difference=mismatch.payload.problems.find(p=>p.code==='cash_mismatch');assert.equal(difference.unexplained_difference_nanos,'1');assert.equal(difference.ledger_cash_nanos,'99499876543211');assert.equal(difference.broker_cash_nanos,'99499876543212');
 const records=await listEvents(db,new Date().toISOString());assert.equal(records.filter(e=>e.kind==='ledger_fill').length,1);assert.equal(records.find(e=>e.kind==='broker_activity').payload.activity.price,'500.123456789');
});
