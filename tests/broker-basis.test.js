import test from 'node:test';import assert from 'node:assert/strict';
import {projectBrokerBasis,exactBrokerBasisMatches,brokerBasisDisplayMatch} from '../lib/broker-basis.js';
const rows=[];
function fill(day,side,q,price,hour=15,received){const at=`2026-10-${day}T${hour}:00:00Z`;return {id:'f'+rows.length,seq:rows.length+1,kind:'ledger_fill',created_at:received||at,payload:{fill:{symbol:'ABC',side,quantity:q,price_text:price,fee_cents:0,occurred_at:at}}};}
function add(...args){const e=fill(...args);rows.push(e);return e;}
const basis=(asOf)=>projectBrokerBasis(rows,asOf).candidates.at(-1).holdings.ABC;
const eq=(r,dollars)=>assert.equal(exactBrokerBasisMatches(r,String(dollars)),true);
test('documented daily compression, intraday average and multiday FIFO diverge explicitly',()=>{
 rows.length=0;add('20','buy',100,'10');add('20','buy',50,'9',16);add('20','sell',50,'12',17);add('20','buy',50,'11',18);
 const intraday=basis('2026-10-20T20:00:00Z');assert.deepEqual(intraday.cost_nanos,{numerator:'4550000000000',denominator:'3'});eq(basis('2026-10-21T13:00:00Z').cost_nanos,1500);
 rows.length=0;add('20','buy',2,'100');add('21','buy',2,'200');add('22','sell',1,'150');eq(basis('2026-10-22T20:00:00Z').cost_nanos,450);eq(basis('2026-10-23T13:00:00Z').cost_nanos,500);eq(basis('2026-10-23T13:00:00Z').realized_pnl_nanos,50);
});
test('BOD candidates limited to documented local processing window including DST',()=>{
 rows.length=0;add('20','buy',100,'10');add('20','buy',50,'9',16);add('20','sell',50,'12',17);add('20','buy',50,'11',18);
 let p=projectBrokerBasis(rows,'2026-10-21T06:14:59Z');assert.equal(p.candidates.length,1);assert.equal(p.candidates[0].phase,'before_bod');
 p=projectBrokerBasis(rows,'2026-10-21T06:15:00Z');assert.equal(p.candidates.length,2);eq(p.candidates[1].holdings.ABC.cost_nanos,1500);
 assert.equal(projectBrokerBasis(rows,'2026-10-21T06:30:00Z').candidates.length,1);
 assert.equal(projectBrokerBasis(rows,'2026-11-03T07:20:00Z').candidates.length,2);assert.equal(projectBrokerBasis(rows,'2026-11-03T06:20:00Z').candidates.length,1);
});
test('complete liquidation and whole split preserve costs and realized results',()=>{
 rows.length=0;add('20','buy',2,'100');rows.push({id:'split',seq:2,kind:'action_split',created_at:'2026-10-21T13:00:00Z',payload:{symbol:'ABC',effective_date:'2026-10-21',before:{active:2},after:{active:4}}});add('21','sell',4,'75');
 const p=basis('2026-10-22T13:00:00Z');assert.equal(p.quantity,0);eq(p.cost_nanos,0);eq(p.realized_pnl_nanos,100);
});
test('receipt cutoff prevents future knowledge, chronological oversell and duplicate receipts fail',()=>{
 rows.length=0;add('20','buy',2,'100');add('21','sell',1,'150',15,'2026-10-22T16:00:00Z');assert.equal(basis('2026-10-21T20:00:00Z').quantity,2);assert.equal(basis('2026-10-22T20:00:00Z').quantity,1);
 assert.throws(()=>projectBrokerBasis([...rows,rows[0]],'2026-10-23T13:00:00Z'),/duplicate/);
 rows.length=0;add('20','sell',1,'100');add('20','buy',1,'100',16);assert.throws(()=>basis('2026-10-21T20:00:00Z'),/chronological/);
});
test('explicit display half-up for nonrepresentable rational, strict nano and minimum cent precision',()=>{
 const rational={numerator:'2050000000000',denominator:'3'};assert.equal(brokerBasisDisplayMatch(rational,'683.33').matched,true);assert.equal(brokerBasisDisplayMatch(rational,'683.34').matched,false);assert.equal(brokerBasisDisplayMatch(rational,'683').matched,false);assert.equal(brokerBasisDisplayMatch(rational,'683.333333333').matched,true);
 assert.equal(brokerBasisDisplayMatch({numerator:'500000000001',denominator:'1'},'500.00').matched,false);assert.equal(brokerBasisDisplayMatch({numerator:'500000000000',denominator:'1'},'500').matched,true);
 assert.equal(brokerBasisDisplayMatch({numerator:'30000001',denominator:'2'},'0.02').matched,true);assert.equal(brokerBasisDisplayMatch(rational,'683.3333333333').matched,false);
});
test('historical days cannot retain arbitrary weighted-average alternatives and reverse split lot fractions conserve basis',()=>{
 rows.length=0;add('20','buy',1,'100');add('21','buy',1,'200');rows.push({id:'reverse',seq:3,kind:'action_split',created_at:'2026-10-22T13:00:00Z',payload:{symbol:'ABC',effective_date:'2026-10-22',before:{active:2},after:{active:1}}});
 let p=basis('2026-10-22T20:00:00Z');assert.equal(p.quantity,1);eq(p.cost_nanos,300);assert.deepEqual(p.lots[0].quantity,{numerator:'1',denominator:'2'});
 add('22','sell',1,'350');p=basis('2026-10-23T20:00:00Z');assert.equal(p.quantity,0);eq(p.realized_pnl_nanos,50);
 rows.length=0;add('20','buy',2,'100');add('21','buy',2,'200');add('22','sell',1,'150');const r=projectBrokerBasis(rows,'2026-10-27T06:20:00Z');assert.equal(r.candidates.length,2);for(const c of r.candidates)eq(c.holdings.ABC.cost_nanos,500);
});

test('basis observation and receipt knowledge cutoffs are separate without future economic leakage',()=>{
 const e={id:'late-received',kind:'ledger_fill',seq:1,created_at:'2026-10-20T14:00:02Z',payload:{fill:{symbol:'SPY',side:'buy',quantity:1,price_text:'500',occurred_at:'2026-10-20T14:00:00Z'}}};
 const snapshot='2026-10-20T14:00:01Z',receipt='2026-10-20T14:00:03Z';
 assert.equal(projectBrokerBasis([e],snapshot).candidates[0].holdings.SPY,undefined);
 const p=projectBrokerBasis([e],snapshot,{knowledgeAsOf:receipt});assert.equal(p.candidates[0].holdings.SPY.quantity,1);eq(p.candidates[0].holdings.SPY.cost_nanos,500);
 const future={...e,payload:{fill:{...e.payload.fill,occurred_at:'2026-10-20T14:00:02Z'}}};assert.equal(projectBrokerBasis([future],snapshot,{knowledgeAsOf:receipt}).candidates[0].holdings.SPY,undefined);
});
