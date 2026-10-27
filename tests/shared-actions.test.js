import test from 'node:test';
import assert from 'node:assert/strict';
import { append,getEvent,listEvents } from '../lib/store.js';
import { createBenchmark } from '../lib/finance.js';
import { readLedger } from '../lib/reconciliation.js';
import { confirmCorporateAction,settleCorporateActions,coverageState } from '../lib/action-settlement.js';
import { temporaryDatabase } from './helpers.js';
import { seedAction,seedCoverage } from './action-fixtures.js';
const actor='synthetic:actions';
const start='2026-10-01T14:00:00.000Z';
async function opening(db,at=start){return append(db,{id:'opening-actions-001',kind:'experiment_opened',actor,payload:{initial_cash_cents:10000000,started_at:at,benchmark:createBenchmark({started_at:at,observed_at:at,market_time:at,price_cents:50000})}},at);}
async function fill(db,id,side,quantity,at,recorded=at){return append(db,{id,kind:'ledger_fill',actor,payload:{fill:{id,symbol:'SPY',side,quantity,price_cents:50000,occurred_at:at,observed_at:recorded}}},recorded);}
const dividend=(id,patch={})=>({id,symbol:'SPY',cusip:'fixture-cusip',rate:'1.25',special:false,foreign:false,ex_date:'2026-10-05',record_date:'2026-10-05',payable_date:'2026-10-09',...patch});
test('shared entitlement uses ex-date history, preserves seller entitlement, and leaves broker cash untouched',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);await fill(db,'buy-before-ex','buy',10,'2026-10-02T14:00:00Z');await fill(db,'sell-after-ex','sell',10,'2026-10-06T14:00:00Z');await fill(db,'buy-after-ex','buy',3,'2026-10-07T14:00:00Z');
 const {input}=await seedAction(db,dividend('ordinary-dividend'));const first=await confirmCorporateAction(db,input,'action-manager');assert.equal(first.kind,'action_confirmed');
 const saved=await settleCorporateActions(db,actor);assert.deepEqual(saved.map(e=>e.kind),['action_entitlement','action_payment']);
 const result=await readLedger(db);assert.equal(result.status,'ready');assert.equal(result.portfolio.cash_cents,9850000);assert.equal(result.portfolio.holdings.SPY.quantity,3);
 assert.deepEqual(result.economic.active,{receivable_cents:0,distribution_cash_cents:1250,income_cents:1250});assert.equal(result.economic.benchmark.income_cents,25000);assert.equal(result.benchmark.cash_cents,0);
 assert.deepEqual(saved[0].payload.quantities,{active:10,benchmark:200});assert.equal(saved[0].payload.contributing_ids.includes('buy-after-ex'),false);
 assert.deepEqual(await settleCorporateActions(db,actor),[]);assert.deepEqual((await readLedger(db)).economic,result.economic);
});
test('inception on or after ex-date earns zero entitlement even if SPY held on payment date',async t=>{
 for(const at of ['2026-10-05T14:00:00.000Z','2026-10-06T14:00:00.000Z']){const {db}=temporaryDatabase(t);await opening(db,at);await seedAction(db,dividend('pre-inception-dividend'));await settleCorporateActions(db,actor);const result=await readLedger(db);assert.equal(result.economic.benchmark.income_cents,0);assert.equal(result.economic.active.income_cents,0);}
});
test('exact whole split preserves both bases and precedes later distribution entitlement',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);await fill(db,'split-before-buy','buy',10,'2026-10-02T14:00:00Z');
 await seedAction(db,{id:'ordinary-split',symbol:'SPY',cusip:'fixture-cusip',new_rate:'2',old_rate:'1',ex_date:'2026-10-05'},{type:'forward_splits'});
 await seedAction(db,dividend('post-split-dividend',{ex_date:'2026-10-06',record_date:'2026-10-06',rate:'1'}));
 const saved=await settleCorporateActions(db,actor);assert.deepEqual(saved.map(e=>e.kind),['action_split','action_entitlement','action_payment']);
 const result=await readLedger(db);assert.equal(result.portfolio.holdings.SPY.quantity,20);assert.equal(result.portfolio.holdings.SPY.cost_cents,500000);assert.equal(result.benchmark.holdings.SPY.quantity,400);assert.equal(result.benchmark.holdings.SPY.cost_cents,10000000);assert.equal(result.economic.active.income_cents,2000);assert.equal(result.economic.benchmark.income_cents,40000);
});
test('noncent entitlement and fractional split results block rather than round or create cash in lieu',async t=>{
 for(const type of ['dividend','split']){const {db}=temporaryDatabase(t);await opening(db);await fill(db,'fractional-basis-buy','buy',1,'2026-10-02T14:00:00Z');
 if(type==='dividend')await seedAction(db,dividend('noncent-rate',{rate:'0.205'}));else await seedAction(db,{id:'fractional-split',symbol:'SPY',cusip:'fixture-cusip',new_rate:'1',old_rate:'2',ex_date:'2026-10-05'},{type:'reverse_splits'});
 await assert.rejects(settleCorporateActions(db,actor),/fractional-cent|Fractional split/);assert.equal((await readLedger(db)).status,'blocked');assert.equal((await listEvents(db,new Date().toISOString())).filter(e=>['action_entitlement','action_payment','action_split'].includes(e.kind)).length,0);}
});
test('late economically earlier fill flags recorded entitlement mismatch without rewriting it',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);await seedAction(db,dividend('late-fill-dividend'));await settleCorporateActions(db,actor);
 const original=(await listEvents(db,new Date().toISOString())).find(e=>e.kind==='action_entitlement');
 await fill(db,'late-known-buy','buy',1,'2026-10-02T14:00:00Z',new Date().toISOString());
 const result=await readLedger(db);assert.equal(result.status,'blocked');assert.ok(result.problems.some(p=>/compensation/.test(p.message)));await assert.rejects(settleCorporateActions(db,actor),/compensation/);assert.deepEqual(await getEvent(db,original.id),original);
});
test('receipt-time replay excludes late action knowledge and modeled payments',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);const before=new Date(Date.now()-1000).toISOString();await seedAction(db,dividend('observed-later'));await settleCorporateActions(db,actor);
 const past=await readLedger(db,before);assert.equal(past.economic.benchmark.income_cents,0);assert.equal((await readLedger(db)).economic.benchmark.income_cents,25000);
});
test('changed raw version and unsupported notice block even before an approval is attempted',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);const raw=dividend('conflicting-notice');await seedAction(db,raw);await settleCorporateActions(db,actor);
 await append(db,{id:'revised-raw-page',kind:'corporate_action_page',actor,payload:{response:{corporate_actions:{cash_dividends:[{...raw,rate:'1.50'}],spin_offs:[{id:'unsupported',symbol:'SPY',cusip:'fixture-cusip',ex_date:'2026-10-06'}]}}}});
 const result=await readLedger(db);assert.equal(result.status,'blocked');assert.ok(result.problems.some(p=>/Conflicting/.test(p.message)));assert.ok(result.problems.some(p=>/Unsupported/.test(p.message)));
});
test('confirmation rejects missing independent review and issuer mismatches',async t=>{
 const {db}=temporaryDatabase(t);const {input}=await seedAction(db,dividend('review-binding'),{confirm:false});
 await assert.rejects(confirmCorporateAction(db,{...input,review_ids:[input.review_ids[0],input.review_ids[0]]},'action-manager'),/independent/);
 await assert.rejects(confirmCorporateAction(db,input,'action-reviewer-1'),/Independent/);
 await assert.rejects(confirmCorporateAction(db,{...input,source_id:'missing-source'},'action-manager'),/issuer/);
});
test('same-day split/dividend combination remains blocked without an explicit rate-ordering policy',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);await seedAction(db,{id:'same-day-split',symbol:'SPY',cusip:'fixture-cusip',new_rate:'2',old_rate:'1',ex_date:'2026-10-05'},{type:'forward_splits'});await seedAction(db,dividend('same-day-dividend'));
 await assert.rejects(settleCorporateActions(db,actor),/Same-day/);
});
test('reviewed coverage becomes invalid when new raw evidence arrives',async t=>{
 const {db}=temporaryDatabase(t);await seedCoverage(db);assert.equal((await coverageState(db)).ok,true);
 await append(db,{id:'new-incomplete-action',kind:'corporate_action_page',actor,payload:{response:{corporate_actions:{cash_dividends:[{id:'incomplete'}]}}}});
 assert.equal((await coverageState(db)).ok,false);
});

test('fill economic ordering uses epoch time across supported timezone offsets',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);await fill(db,'offset-buy','buy',1,'2026-10-02T15:00:00Z');await fill(db,'offset-sale','sell',1,'2026-10-02T12:00:00-04:00');
 const result=await readLedger(db);assert.equal(result.status,'ready');assert.deepEqual(result.portfolio.holdings,{});assert.equal(result.portfolio.cash_cents,10000000);
});
test('revoked confirmed action blocks both coverage and replay',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);const {input,page}=await seedAction(db,dividend('revoked-action'));const review=await getEvent(db,input.review_ids[0]);
 await append(db,{id:'revocation-evidence',kind:'action_review',actor:'independent-reviewer',payload:{author:'independent-reviewer',status:'rejected',binding:review.payload.binding}});
 await seedCoverage(db,{actionIds:['revoked-action'],pages:[page.id]});
 assert.equal((await coverageState(db)).ok,false);assert.equal((await readLedger(db)).status,'blocked');
});
test('coverage rejects ingestion of an old issuer observation and an uncovered process-date gap',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);const coverage=await seedCoverage(db);const events=await listEvents(db,new Date().toISOString());
 const {actionCoverage}=await import('../lib/action-ledger.js');const clone=structuredClone(events);
 clone.find(e=>e.id===coverage.payload.source_ids[0]).payload.observed_at='2020-01-01T00:00:00Z';assert.equal(actionCoverage(clone,new Date().toISOString()).ok,false);
 const gap=structuredClone(events);gap.find(e=>e.id===coverage.payload.fetch_id).payload.query.start=new Date().toISOString().slice(0,10);assert.ok(actionCoverage(gap,new Date().toISOString()).problems.some(p=>/gap/.test(p)));
});
test('receivable-to-payment transfer recognizes income once and never changes spendable cash',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
 await seedAction(db,dividend('future-payment',{payable_date:tomorrow}));const saved=await settleCorporateActions(db,actor);assert.deepEqual(saved.map(e=>e.kind),['action_entitlement']);
 const current=await readLedger(db);assert.equal(current.economic.benchmark.receivable_cents,25000);assert.equal(current.economic.benchmark.distribution_cash_cents,0);
 const laterAt=tomorrow+'T20:00:00.000Z';const projection=await readLedger(db,laterAt);const payment=projection.pending.find(e=>e.kind==='action_payment');assert.ok(payment);
 // Synthetic future receipt in this isolated fixture only, never an official backfill.
 await append(db,{...payment,actor},laterAt);const paid=await readLedger(db,laterAt);assert.equal(paid.economic.benchmark.receivable_cents,0);assert.equal(paid.economic.benchmark.distribution_cash_cents,25000);assert.equal(paid.economic.benchmark.income_cents,25000);assert.equal(paid.benchmark.cash_cents,0);
 assert.equal((await readLedger(db)).economic.benchmark.distribution_cash_cents,0);
});
test('pre-inception distribution notices require no manufactured zero settlement at activation',async t=>{
 const {db}=temporaryDatabase(t);await opening(db,'2026-10-06T14:00:00.000Z');await seedAction(db,dividend('prior-ex-date'));
 const result=await readLedger(db);assert.equal(result.status,'ready');assert.deepEqual(result.pending,[]);assert.equal(result.economic.benchmark.income_cents,0);assert.deepEqual(await settleCorporateActions(db,actor),[]);
});

test('reverse split uses source old/new identity and rejects identity changes or wrong ratio direction',async t=>{
 const {db}=temporaryDatabase(t);await opening(db);await fill(db,'reverse-whole-buy','buy',6,'2026-10-02T14:00:00Z');
 const raw={id:'reverse-whole-action',symbol:'SPY',old_cusip:'same-cusip',new_cusip:'same-cusip',new_rate:'1',old_rate:'2',ex_date:'2026-10-05'};
 await seedAction(db,raw,{type:'reverse_splits'});await settleCorporateActions(db,actor);const result=await readLedger(db);assert.equal(result.portfolio.holdings.SPY.quantity,3);assert.equal(result.portfolio.holdings.SPY.cost_cents,300000);assert.equal(result.benchmark.holdings.SPY.quantity,100);
 const {normalizeAction}=await import('../lib/action-ledger.js');assert.throws(()=>normalizeAction('reverse_splits',{...raw,new_cusip:'changed'}),/identity|symbol/);assert.throws(()=>normalizeAction('forward_splits',{...raw,cusip:'same-cusip'}),/direction/);
});
