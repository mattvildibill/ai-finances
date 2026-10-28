import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hash} from '../lib/store.js';
import {projectBrokerBasis,brokerPositionBasisMatch,BROKER_AVERAGE_DISPLAY_POLICY} from '../lib/broker-basis.js';
import {brokerBasisComparison,brokerCashMatches} from '../lib/finance.js';
const file=name=>JSON.parse(readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8')).records;
const receipt=file('actual-spy-position-2026-10-28.json')[0],positions=receipt.payload.broker_positions.positions;
const spy=positions.find(p=>p.symbol==='SPY');
const events=[...file('actual-opening-fills-2026-10-27.json'),...file('actual-spy-basis-mismatch-2026-10-28.json')];
const projection=()=>projectBrokerBasis(events,'2026-10-28T19:42:43.689Z');
const exact={numerator:'24654430000000',denominator:'1'};

test('actual position receipt supports exact six-decimal representation while analytical basis is unchanged',async()=>{
 assert.equal(receipt.digest,await hash({kind:receipt.kind,payload:receipt.payload}));const before=structuredClone(events),p=projection();
 const result=brokerPositionBasisMatch(exact,spy.cost_basis,32,spy.avg_entry_price);
 assert.equal(result.matched,true);assert.equal(result.policy,BROKER_AVERAGE_DISPLAY_POLICY);assert.equal(result.expected_six_decimal_average,'770.450938');assert.equal(result.derived_basis_nanos,'24654430016000');assert.equal(result.basis_delta_nanos.numerator,'16000');assert.equal(result.maximum_representation_delta_nanos,'16000');assert.equal(result.average_times_quantity_matches,true);
 assert.equal(brokerBasisComparison(p,[spy]).matched,true);assert.deepEqual(events,before);assert.equal(p.candidates[0].holdings.SPY.cost_nanos.numerator,'24654430000000');
 assert.equal(brokerPositionBasisMatch(exact,spy.cost_basis,32).matched,false); // old receipt remains strict
 assert.equal(receipt.payload.status,'blocked');assert.equal(receipt.payload.broker_basis_comparison.matched,false); // immutable prior result
 assert.equal(brokerCashMatches({accounting_policy:'usd-nano-v1',cash_nanos:'43546180000000'},'43546.180016'),false);
});

test('exact average-times-quantity identity and derived average are both mandatory',()=>{
 for(const [basis,avg] of [['24654.430015','770.450938'],['24654.430017','770.450938'],['24654.429984','770.450937'],['24654.43','770.450939'],['24654.430016','770.4509380'],['24654.4','770.45'],['24654.430016','770.905556']])assert.equal(brokerPositionBasisMatch(exact,basis,32,avg).matched,false,basis+' '+avg);
 for(const avg of [null,0,NaN,{},'', '0','-770.450938','7.70450938e2','770.4509380001','1'.repeat(81)])assert.equal(brokerPositionBasisMatch(exact,spy.cost_basis,32,avg).matched,false);
 for(const q of [0,-32,31,33,32.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.equal(brokerPositionBasisMatch(exact,spy.cost_basis,q,spy.avg_entry_price).matched,false);
 for(const basis of ['NaN','-24654.430016','24654.4300160001'])assert.equal(brokerPositionBasisMatch(exact,basis,32,spy.avg_entry_price).matched,false);
});

test('direct exact basis allows absent, exact or specifically supported six-decimal average but rejects contradictions',()=>{
 assert.equal(brokerPositionBasisMatch(exact,'24654.43',32).matched,true);
 assert.equal(brokerPositionBasisMatch(exact,'24654.43',32,'770.4509375').matched,true);
 assert.equal(brokerPositionBasisMatch(exact,'24654.43',32,'770.450938').matched,true);
 assert.equal(brokerPositionBasisMatch(exact,'24654.43',32,'771').matched,false);
 for(const p of positions.filter(p=>p.symbol!=='SPY')){const [whole,fraction='']=p.cost_basis.split('.'),nanos=BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'));
  assert.equal(brokerPositionBasisMatch({numerator:nanos.toString(),denominator:'1'},p.cost_basis,Number(p.qty),p.avg_entry_price).matched,true);
 }
});

test('independent table-driven integer probes enforce half-micro per-share bound and reject adjacent values',()=>{
 for(const q of [1,2,3,32,701,1000000])for(const remainder of [0,1,499,500,501,999]){
  // Independent expected average in nanodollars, including exact-half-up boundaries.
  const perShare=123456000n+BigInt(remainder),n=perShare*BigInt(q),rounded=123456000n+(remainder>=500?1000n:0n);
  const fmt=v=>(v/1000000000n).toString()+'.'+(v%1000000000n).toString().padStart(9,'0');
  const avg=(rounded/1000000000n).toString()+'.'+((rounded%1000000000n)/1000n).toString().padStart(6,'0');
  const projected={numerator:n.toString(),denominator:'1'},basis=rounded*BigInt(q);
  assert.equal(brokerPositionBasisMatch(projected,fmt(basis),q,avg).matched,true);
  assert.ok((basis>n?basis-n:n-basis)<=BigInt(q)*500n);
  if(basis+1n!==n)assert.equal(brokerPositionBasisMatch(projected,fmt(basis+1n),q,avg).matched,false);
 }
});

test('whole-portfolio phase, quantity and duplicate-symbol checks remain strict',()=>{
 const p=projection();assert.equal(brokerBasisComparison(p,[spy,spy]).matched,false);assert.equal(brokerBasisComparison(p,[{...spy,qty:'31'}]).matched,false);assert.equal(brokerBasisComparison(p,[]).matched,false);
 const normalized={symbol:'SPY',quantity:32,cost_basis_text:spy.cost_basis,avg_entry_price_text:spy.avg_entry_price};assert.equal(brokerBasisComparison(p,[normalized]).matched,true);
 const bad=structuredClone(p);bad.candidates[0].holdings.SPY.cost_nanos.numerator='24655430000000';assert.equal(brokerBasisComparison(bad,[spy]).matched,false);
});

test('contradictory or null snapshot aliases cannot hide behind preferred fields',()=>{
 for(const fields of [{avg_entry_price_text:null},{avg_entry_price_text:'770.450939'},{quantity:31}])assert.equal(brokerBasisComparison(projection(),[{...spy,...fields}]).matched,false);
});

test('reconciliation, normalized valuation and managed cash guard share the same evidence-based comparison',async t=>{
 const {temporaryDatabase,testEnv}=await import('./helpers.js'),{append}=await import('../lib/store.js'),{reconcile,readLedger}=await import('../lib/reconciliation.js'),{ledgerView}=await import('../lib/valuation.js'),{managedOrderCheck}=await import('../lib/managed-policy.js');
 const {db}=temporaryDatabase(t);for(const e of events.filter(e=>['experiment_opened','broker_activity','ledger_fill'].includes(e.kind)))await append(db,{id:e.id,kind:e.kind,payload:e.payload,actor:'isolated-replay'},e.created_at);
 // These synthetic account responses isolate SPY; they are not a claimed actual broker account.
 const fetcher=async(url,o)=>{assert.equal(o.method,'GET');const u=new URL(url);assert.equal(u.origin,'https://paper-api.alpaca.markets');return Response.json(u.pathname==='/v2/account'?{status:'ACTIVE',currency:'USD',cash:'75345.57'}:u.pathname==='/v2/positions'?[spy]:u.pathname==='/v2/account/activities/FILL'?events.filter(e=>e.kind==='broker_activity').map(e=>e.payload.activity):[]);};
 const before=await readLedger(db),result=await reconcile(db,testEnv,'synthetic-average-reconciliation','isolated-replay',fetcher),after=await readLedger(db);
 assert.equal(result.payload.broker_basis_comparison.matched,true);assert.equal(result.payload.problems.some(p=>p.code==='basis_mismatch'||p.code==='cash_mismatch'),false);assert.deepEqual(after.portfolio,before.portfolio);assert.equal(after.portfolio.cash_nanos,'75345570000000');
 const at='2026-10-28T19:45:00.000Z',snapshot={seq:1000,created_at:at,payload:{retrieved_at:at,account:{cash:75345.57,cash_text:'75345.57'},positions:[{symbol:'SPY',side:'long',quantity:32,cost_basis_text:spy.cost_basis,avg_entry_price_text:spy.avg_entry_price}],open_orders:[],clock:{is_open:true,timestamp:at,next_close:'2026-10-28T20:00:00Z',next_open:'2026-10-29T13:30:00Z'},quotes:{SPY:{price:771.31,price_text:'771.31',market_data_at:at,feed:'iex'}}}};
 after.action_coverage={ok:true};const view=ledgerView(after,snapshot,at,{seq:1001,created_at:at,payload:{status:'reconciled',problems:[]}});assert.equal(view.account_drift,false);assert.equal(view.portfolio.holdings[0].cost_basis,24654.43);
 const context={portfolio:after.portfolio,broker_basis:after.broker_basis,snapshot:snapshot.payload,now:at,valid_until:'2026-10-28T19:50:00Z',ends_at:'2027-04-25T13:31:45.975Z'};
 const check=managedOrderCheck({symbol:'SPY',side:'buy',quantity:1,limit_price_cents:77200},context);assert.equal(check.ok,true,check.errors.join('; '));
 const changed=structuredClone(context);changed.snapshot.account.cash_text='75345.570016';changed.snapshot.account.cash=75345.570016;assert.equal(managedOrderCheck({symbol:'SPY',side:'buy',quantity:1,limit_price_cents:77200},changed).ok,false);
});
