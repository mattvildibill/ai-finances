import test from 'node:test';
import assert from 'node:assert/strict';
import {INVESTMENT_POLICY,PERMITTED_SYMBOLS,PERMITTED_SYMBOL_QUERY,permittedInstrument} from '../lib/investment-policy.js';
import {MANDATE,initialPortfolio,validateOrder} from '../lib/finance.js';
import {SYMBOLS,observe} from '../lib/alpaca.js';
import {approvedPrimaryActionSource} from '../lib/issuer-source-policy.js';
import {brokerFixture,testEnv} from './helpers.js';

test('versioned universe is deeply immutable and preserves current instruments and risk caps',()=>{
 assert.equal(INVESTMENT_POLICY.configuration_version,1);assert.equal(INVESTMENT_POLICY.mandate_version,1);
 assert.deepEqual(PERMITTED_SYMBOLS,['AAPL','MSFT','SPY']);assert.equal(PERMITTED_SYMBOL_QUERY,'AAPL,MSFT,SPY');
 assert.equal(MANDATE.universe,PERMITTED_SYMBOLS);assert.equal(SYMBOLS,PERMITTED_SYMBOLS);
 assert.deepEqual(INVESTMENT_POLICY.instruments.map(i=>[i.symbol,i.instrument_type,i.max_weight]),[['AAPL','stock',.10],['MSFT','stock',.10],['SPY','diversified_equity_etf',.25]]);
 assert.deepEqual(INVESTMENT_POLICY.limits,{initial_cash_cents:10000000,stock_weight:.10,etf_weight:.25,gross_weight:.90,cash_weight:.10,order_weight:.05});
 assert.throws(()=>PERMITTED_SYMBOLS.push('BND'),TypeError);
 assert.throws(()=>INVESTMENT_POLICY.instruments[2].instrument_type='leveraged_etf',TypeError);
 assert.throws(()=>INVESTMENT_POLICY.limits.order_weight=1,TypeError);
 assert.equal(permittedInstrument('BND'),null);assert.equal(permittedInstrument('PENNY'),null);
 assert.equal(approvedPrimaryActionSource('BND','https://www.ssga.com/anything'),false);
});

test('source requests cannot expand via environment symbols and unknown instruments fail order guards',async()=>{
 const fixture=brokerFixture();const observed=await observe({...testEnv,SYMBOLS:'BND,PENNY',PERMITTED_UNIVERSE:'BND'},fixture.fetcher);
 assert.deepEqual(Object.keys(observed.quotes),['AAPL','MSFT','SPY']);
 const tradeCall=fixture.calls.find(c=>new URL(c.url).pathname==='/v2/stocks/trades/latest');assert.equal(new URL(tradeCall.url).searchParams.get('symbols'),'AAPL,MSFT,SPY');
 const now=new Date().toISOString();
 const context={runtime_verified:true,experiment_status:'active',paper_endpoint:'https://paper-api.alpaca.markets',now,clock:{timestamp:now,is_open:true,next_close:new Date(Date.now()+3600000).toISOString(),next_open:new Date(Date.now()+86400000).toISOString()},open_orders:[],portfolio:initialPortfolio(),prices:{BND:{price_cents:10000,market_time:now}}};
 const result=validateOrder({symbol:'BND',side:'buy',quantity:1,limit_price_cents:10000},context);
 assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.includes('outside the approved')));
});
