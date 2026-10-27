import test from 'node:test';import assert from 'node:assert/strict';
import {temporaryDatabase,testEnv} from './helpers.js';import {append,getEvent} from '../lib/store.js';
import {createNanoBenchmark,brokerBasisComparison} from '../lib/finance.js';
import {readLedger,reconcile} from '../lib/reconciliation.js';import {managedOrderCheck} from '../lib/managed-policy.js';
import {ledgerView} from '../lib/valuation.js';import {projectBrokerBasis} from '../lib/broker-basis.js';import {seedCoverage} from './action-fixtures.js';
const start='2026-10-20T14:00:00.000Z';
test('real reconciliation and managed preflight accept independently projected prior-day FIFO basis without rewriting analytical basis',async t=>{
 const {db}=temporaryDatabase(t),actor='synthetic-basis';const original=[];
 original.push(await append(db,{id:'basis-opening',kind:'experiment_opened',actor,payload:{initial_cash_cents:10000000,started_at:start,accounting_policy:'usd-nano-v1',benchmark:createNanoBenchmark({started_at:start,observed_at:start,market_time:start,price_text:'500'})}},start));
 for(const [day,side,q,price] of [['20','buy',2,'100'],['21','buy',2,'200'],['22','sell',1,'150']]){
 const at=`2026-10-${day}T15:00:00.000Z`,id='basis-fill-'+day;
 original.push(await append(db,{id,kind:'ledger_fill',actor,payload:{fill:{id,symbol:'SPY',side,quantity:q,price_text:price,fee_cents:0,occurred_at:at,observed_at:at}}},at));
 }
 await seedCoverage(db);let rawBasis='500';
 const fetcher=async(url,options)=>{assert.equal(options.method,'GET');const u=new URL(url);assert.equal(u.origin,'https://paper-api.alpaca.markets');if(u.pathname==='/v2/account')return Response.json({status:'ACTIVE',currency:'USD',cash:'99550',equity:'100000'});if(u.pathname==='/v2/positions')return Response.json([{symbol:'SPY',side:'long',qty:'3',cost_basis:rawBasis}]);if(['/v2/orders','/v2/account/activities/FILL'].includes(u.pathname))return Response.json([]);throw Error(u.pathname);};
 const r=await reconcile(db,testEnv,'basis-reconcile-cfifo',actor,fetcher);assert.equal(r.payload.status,'reconciled');assert.equal(r.payload.broker_basis_comparison.matched,true);
 const ledger=await readLedger(db);assert.equal(ledger.portfolio.holdings.SPY.cost_nanos,'450000000000');assert.equal(ledger.portfolio.realized_pnl_nanos,'0');assert.equal(ledger.portfolio.cash_nanos,'99550000000000');
 const now=new Date().toISOString(),snapshot={retrieved_at:now,account:{cash:99550,cash_text:'99550'},positions:[{symbol:'SPY',side:'long',quantity:3,cost_basis:500,cost_basis_text:'500'}],open_orders:[],clock:{is_open:true,timestamp:now,next_close:new Date(Date.now()+3600000).toISOString(),next_open:new Date(Date.now()+86400000).toISOString()},quotes:{SPY:{price:150,price_text:'150',market_data_at:now,feed:'iex'}}};
 assert.equal(managedOrderCheck({symbol:'SPY',side:'sell',quantity:1,limit_price_cents:15000},{portfolio:ledger.portfolio,broker_basis:ledger.broker_basis,snapshot,now,valid_until:new Date(Date.now()+60000).toISOString(),ends_at:new Date(Date.now()+86400000).toISOString()}).ok,true);
 const view=ledgerView(ledger,{created_at:now,payload:snapshot},now,r);assert.equal(view.account_drift,false);assert.equal(view.portfolio.value,100000);assert.equal(view.portfolio.holdings[0].cost_basis,450);assert.match(view.portfolio.basis_method,/Analytical/);
 rawBasis='499.99';const bad=await reconcile(db,testEnv,'basis-reconcile-unexplained',actor,fetcher);assert.equal(bad.payload.status,'blocked');assert.ok(bad.payload.problems.some(p=>p.code==='basis_mismatch'));
 for(const e of original)assert.deepEqual(await getEvent(db,e.id),e);
});
test('one entire BOD candidate must match; impossible symbol-by-symbol phase mixing fails',()=>{
 const events=[];for(const symbol of ['AAPL','SPY'])for(const [hour,side,q,price] of [[14,'buy',100,'10'],[15,'buy',50,'9'],[16,'sell',50,'12'],[17,'buy',50,'11']]){const at=`2026-10-20T${hour}:00:00Z`;events.push({id:symbol+hour,seq:events.length+1,kind:'ledger_fill',created_at:at,payload:{fill:{symbol,side,quantity:q,price_text:price,occurred_at:at}}});}
 const p=projectBrokerBasis(events,'2026-10-21T06:20:00Z');assert.equal(p.candidates.length,2);
 assert.equal(brokerBasisComparison(p,[{symbol:'AAPL',qty:'150',cost_basis:'1500'},{symbol:'SPY',qty:'150',cost_basis:'1500'}]).matched,true);
 assert.equal(brokerBasisComparison(p,[{symbol:'AAPL',qty:'150',cost_basis:'1516.67'},{symbol:'SPY',qty:'150',cost_basis:'1500'}]).matched,false);
});

test('snapshot followed by newly received earlier fill retains its valid historical observed point',async t=>{
 const {observedValuationHistory}=await import('../lib/observed-valuation.js');const {state}=await import('../lib/service.js');
 const {db}=temporaryDatabase(t),actor='synthetic-cutoff',open='2026-10-20T13:30:00.000Z',trade='2026-10-20T14:00:00.000Z',snap='2026-10-20T14:00:01.000Z',received='2026-10-20T14:00:02.000Z',cutoff='2026-10-20T14:00:03.000Z';
 await append(db,{id:'cutoff-opening',kind:'experiment_opened',actor,payload:{initial_cash_cents:10000000,started_at:open,accounting_policy:'usd-nano-v1',benchmark:createNanoBenchmark({started_at:open,observed_at:open,market_time:open,price_text:'500'})}},open);
 await seedCoverage(db,{at:trade});
 await append(db,{id:'cutoff-snapshot',kind:'snapshot',actor,payload:{retrieved_at:snap,account:{cash:99500,cash_text:'99500'},positions:[{symbol:'SPY',side:'long',quantity:1,cost_basis:500,cost_basis_text:'500'}],quotes:{SPY:{price:500,price_text:'500',market_data_at:trade,retrieved_at:snap,feed:'iex'}},clock:{is_open:true,timestamp:snap}}},snap);
 await append(db,{id:'cutoff-fill',kind:'ledger_fill',actor,payload:{fill:{id:'cutoff-fill',symbol:'SPY',side:'buy',quantity:1,price_text:'500',occurred_at:trade,observed_at:received}}},received);
 await append(db,{id:'cutoff-recon',kind:'reconciliation',actor,payload:{status:'reconciled',ledger_status:'ready',problems:[]}},cutoff);
 const history=await observedValuationHistory(db,cutoff);assert.equal(history.points.length,1);assert.equal(history.points[0].value,100000);assert.equal(history.points[0].benchmark_value,100000);
 const view=await state(db,cutoff);assert.equal(view.account_drift,false);assert.equal(view.portfolio.value,100000);
});
