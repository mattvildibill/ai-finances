import test from 'node:test';
import assert from 'node:assert/strict';
import * as finance from '../lib/finance.js';
import {usdNanos,nanosToCents} from '../lib/precision.js';
import {validationOrderLimits} from '../lib/validation-policy.js';
const at='2026-10-27T15:00:00Z';
const quote=price=>({price_nanos:usdNanos(price).toString(),market_time:at});
function context({cash='100000',holdings={},marks={AAPL:'100',MSFT:'100',SPY:'500'},income='0'}={}){
 const p=finance.toNanoPortfolio(finance.initialPortfolio());p.cash_nanos=usdNanos(cash).toString();p.cash_cents=nanosToCents(p.cash_nanos);
 p.holdings=Object.fromEntries(Object.entries(holdings).map(([symbol,quantity])=>{const basis=BigInt(quantity)*usdNanos(marks[symbol]);return [symbol,{quantity,cost_nanos:basis.toString(),cost_cents:nanosToCents(basis)}];}));
 return {runtime_verified:true,experiment_status:'active',paper_endpoint:finance.PAPER_ORIGIN,now:at,clock:{timestamp:at,is_open:true,next_close:'2026-10-27T20:00:00Z',next_open:'2026-10-28T13:30:00Z'},portfolio:p,prices:Object.fromEntries(Object.entries(marks).map(([symbol,price])=>[symbol,quote(price)])),modeled_income_nanos:usdNanos(income).toString(),open_orders:[]};
}
const order=(patch={})=>({symbol:'AAPL',side:'buy',quantity:50,limit_price_cents:10000,type:'limit',time_in_force:'day',...patch});
const rejects=(o,c,pattern)=>{const result=finance.validateOrder(o,c);assert.equal(result.ok,false,JSON.stringify(result));assert.ok(result.errors.some(error=>pattern.test(error)),JSON.stringify(result.errors));return result;};

test('subcent held marks cannot inflate the NAV denominator across the five-percent boundary',()=>{
 const c=context({cash:'79999.99',holdings:{SPY:40},marks:{AAPL:'100',SPY:'500.000000001'}});
 const amounts=finance.orderRiskAmounts(order(),c);assert.equal(amounts.V,99999990000040n);assert.equal(amounts.R,5000000000000n);
 rejects(order(),c,/5%/);
});

test('low sale limit cannot disguise the market value of the quantity being sold',()=>{
 const c=context({cash:'90000',holdings:{AAPL:100}});
 const sale=order({side:'sell',quantity:100,limit_price_cents:100});
 const amounts=finance.orderRiskAmounts(sale,c);assert.equal(amounts.R,10000000000000n);rejects(sale,c,/5%/);
 assert.equal(finance.validateOrder({...sale,quantity:50},c).ok,true);
 rejects({...sale,quantity:51},c,/5%/);
});

test('exact order equality passes; one nano below NAV or above commitment fails',()=>{
 assert.equal(finance.validateOrder(order(),context()).ok,true);
 rejects(order(),context({cash:'99999.999999999'}),/5%/);
 rejects(order({quantity:1,limit_price_cents:500000}),context({marks:{AAPL:'5000.000000001'}}),/5%/);
 assert.equal(finance.validateOrder(order(),context({cash:'100000.000000001'})).ok,true);
});

test('stock and ETF concentration enforce exact equality and a one-nano excess',()=>{
 const stock=order({quantity:1,limit_price_cents:500000});
 assert.equal(finance.validateOrder(stock,context({cash:'95000',holdings:{AAPL:1},marks:{AAPL:'5000'}})).ok,true);
 rejects(stock,context({cash:'95000',holdings:{AAPL:1},marks:{AAPL:'5000.000000001'}}),/10%.*concentration/);
 const etf=order({symbol:'SPY',quantity:1,limit_price_cents:500000});
 assert.equal(finance.validateOrder(etf,context({cash:'80000',holdings:{SPY:4},marks:{SPY:'5000'}})).ok,true);
 rejects(etf,context({cash:'79999.999999999',holdings:{SPY:4},marks:{SPY:'5000'}}),/25%.*concentration/);
});

test('gross and spendable reserve use exact marked holdings and remain independently enforced',()=>{
 const o=order({symbol:'MSFT',quantity:10});
 const c=context({cash:'11000',holdings:{AAPL:890},marks:{AAPL:'100',MSFT:'100'}});
 assert.equal(finance.validateOrder(o,c).ok,true);
 const below=context({cash:'10999.999999999',holdings:{AAPL:890},marks:{AAPL:'100',MSFT:'100'}});
 rejects(o,below,/cash reserve/);rejects(o,below,/90%.*gross/);
 const {held,...amounts}=finance.orderRiskAmounts(o,c);assert.equal(held,0);assert.deepEqual(amounts,{V:100000000000000n,C:11000000000000n,H:89000000000000n,P:0n,I:0n,R:1000000000000n});
});

test('modeled income raises reserve NAV but never funds a purchase or inflates sizing NAV',()=>{
 const c=context({cash:'16000',holdings:{AAPL:840},income:'10000'}),o=order({symbol:'MSFT'});
 assert.equal(finance.validateOrder(o,c).ok,true);
 const amounts=finance.orderRiskAmounts(o,c);assert.equal(amounts.V,100000000000000n);assert.equal(amounts.I,10000000000000n);
 c.modeled_income_nanos='10000000000001';rejects(o,c,/cash reserve/);
 rejects(order(),context({cash:'1000',income:'1000000'}),/leverage/);
 rejects(order(),context({cash:'99999.99',income:'1000000'}),/5%/);
});

test('reductions need not cure preexisting cash, gross or concentration breaches but must own inventory',()=>{
 const c=context({cash:'0',holdings:{AAPL:1000}});
 assert.equal(finance.validateOrder(order({side:'sell',quantity:50}),c).ok,true);
 rejects(order({side:'sell',quantity:1001}),c,/unowned/);
 const h=context({cash:'99000',holdings:{AAPL:10}});rejects(order({side:'sell',quantity:11}),h,/unowned/);
});

test('every held mark stays subject to freshness and raw nano inputs fail closed when malformed',()=>{
 const c=context({cash:'99500',holdings:{SPY:1}});c.prices.SPY.market_time='2026-10-27T14:57:59Z';rejects(order({quantity:1}),c,/SPY price is stale/);
 delete c.prices.SPY;assert.equal(finance.validateOrder(order({quantity:1}),c).ok,false);
 for(const bad of ['1.0','-1','NaN','01',null]){const malformed=context();malformed.prices.AAPL.price_nanos=bad;assert.equal(finance.validateOrder(order(),malformed).ok,false,String(bad));const income=context();income.modeled_income_nanos=bad;assert.equal(finance.validateOrder(order(),income).ok,false,'income '+bad);}
});

test('legacy integer-cent contexts and exact nano contexts agree without changing original portfolios',()=>{
 for(const side of ['buy','sell'])for(const quantity of [1,50,51]){
  const nano=context({cash:'95000',holdings:{AAPL:50}}),legacy=structuredClone(nano);
  legacy.portfolio={cash_cents:9500000,holdings:{AAPL:{quantity:50,cost_cents:500000}},realized_pnl_cents:0,income_cents:0,fees_cents:0,events:[]};
  legacy.prices={AAPL:{price_cents:10000,market_time:at},MSFT:{price_cents:10000,market_time:at},SPY:{price_cents:50000,market_time:at}};delete legacy.modeled_income_nanos;legacy.modeled_income_cents=0;
  const before=structuredClone(legacy.portfolio),o=order({side,quantity});
  assert.deepEqual(finance.orderRiskAmounts(o,nano),finance.orderRiskAmounts(o,legacy));
  assert.equal(finance.validateOrder(o,nano).ok,finance.validateOrder(o,legacy).ok);assert.deepEqual(legacy.portfolio,before);
 }
});

test('pilot retains one-SPY scope and exact one-percent/dollar caps using the shared NAV',()=>{
 const decision={id:'synthetic-pilot',payload:{size:1000}},protocol={payload:{decision_id:'synthetic-pilot',valid_until:'2026-10-27T16:00:00Z'}};
 const o=order({symbol:'SPY',quantity:1,limit_price_cents:100000}),c=context({marks:{SPY:'1000'}});
 assert.doesNotThrow(()=>validationOrderLimits(o,c,decision,protocol,at));
 assert.throws(()=>validationOrderLimits(o,context({cash:'99999.999999999',marks:{SPY:'1000'}}),decision,protocol,at),/1%/);
 assert.throws(()=>validationOrderLimits(o,context({cash:'200000',marks:{SPY:'1000.000000001'}}),decision,protocol,at),/1,000/);
 for(const patch of [{quantity:2},{symbol:'AAPL'},{side:'sell'}])assert.throws(()=>validationOrderLimits({...o,...patch},c,decision,protocol,at));
});

test('both buy and sell reservations use the larger of exact mark and explicit limit',()=>{
 for(const side of ['buy','sell']){
  const c=context({cash:'99000',holdings:{AAPL:10},marks:{AAPL:'100.000000001'}});
  const lower=order({side,quantity:10,limit_price_cents:9000});
  const higher=order({side,quantity:10,limit_price_cents:11000});
  assert.equal(finance.orderRiskAmounts(lower,c).R,1000000000010n);
  assert.equal(finance.orderRiskAmounts(higher,c).R,1100000000000n);
  assert.equal(finance.validateOrder(lower,c).ok,true);assert.equal(finance.validateOrder(higher,c).ok,true);
 }
});

test('accepted buy reservations bound actual post-fill exposure and cash at fixed marks',()=>{
 const cases=[
  {c:context({cash:'95000',holdings:{AAPL:50}}),o:order({quantity:40,limit_price_cents:12500})},
  {c:context({cash:'11250',holdings:{AAPL:8875},marks:{AAPL:'10',MSFT:'100'}}),o:order({symbol:'MSFT',quantity:10,limit_price_cents:12500})},
 ];
 for(const {c,o} of cases){
  assert.equal(finance.validateOrder(o,c).ok,true);
  const original=structuredClone(c.portfolio);
  for(const price of ['89.999000001','100','110.000000001','125']){
   const filled=finance.applyFill(c.portfolio,{id:'synthetic-risk-fill-'+price,symbol:o.symbol,side:'buy',quantity:o.quantity,price_text:price,fee_cents:0,occurred_at:at,observed_at:at});
   const C=BigInt(filled.cash_nanos);
   const H=Object.entries(filled.holdings).reduce((total,[symbol,h])=>total+BigInt(h.quantity)*BigInt(c.prices[symbol].price_nanos),0n);
   const V=C+H,P=BigInt(filled.holdings[o.symbol].quantity)*BigInt(c.prices[o.symbol].price_nanos);
   assert.ok(C>=0n);assert.ok(C*10000n>=V*1000n,price+' cash');
   assert.ok(H*10000n<=V*9000n,price+' gross');assert.ok(P*10000n<=V*1000n,price+' stock');
  }
  assert.deepEqual(c.portfolio,original);
 }
});
