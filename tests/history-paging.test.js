import test from 'node:test';import assert from 'node:assert/strict';
import {temporaryDatabase} from './helpers.js';
import {readCompleteHistory,HISTORY_LIMITS} from '../lib/history.js';
import {reviewed} from './universe-fixtures.js';
import {rolloutBudget} from '../lib/rollout-budget.js';
import {append} from '../lib/store.js';
const at='2026-10-27T20:00:00.000Z';
function bulk(db,count,{start=1,created_at=at}={}){
 const q=db.sqlite.prepare('INSERT INTO events(id,kind,created_at,actor,payload,digest) VALUES(?,?,?,?,?,?)');
 db.sqlite.exec('BEGIN');try{for(let i=start;i<start+count;i++)q.run('history-fixture-'+i,'verification',created_at,'fixture',JSON.stringify({index:i}),'fixture-only');db.sqlite.exec('COMMIT');}catch(e){db.sqlite.exec('ROLLBACK');throw e;}
}
test('complete paged replay retains original purchase commitments beyond ten thousand subsequent events',async t=>{
 const {db}=temporaryDatabase(t),r=await reviewed(db),cutoff=new Date().toISOString();bulk(db,11000,{created_at:cutoff});
 const events=await readCompleteHistory(db,cutoff);assert.ok(events.length>11000);assert.equal(events[0].seq,1);
 assert.equal(rolloutBudget(events).spent,500000000000n);assert.equal(events.filter(e=>e.kind==='experiment_opened').length,1);assert.equal(events.find(e=>e.id===r.opening.id).digest,r.opening.digest);
 assert.equal(events.filter(e=>e.kind==='verification'&&e.id.startsWith('history-fixture-')).length,11000);
});
test('keyset replay preserves sequence gaps and excludes new/backdated writes beyond initial head',async t=>{
 const {db}=temporaryDatabase(t);bulk(db,1500);
 // Idempotent conflicting inserts consume SQLite sequence values, as in ordinary journal retries.
 db.sqlite.prepare('INSERT INTO events(id,kind,created_at,actor,payload,digest) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run('history-fixture-1','verification',at,'fixture','{}','fixture');bulk(db,501,{start:1501});
 const original=db.prepare.bind(db);let injected=false;
 db.prepare=sql=>{const p=original(sql);if(sql.startsWith('SELECT * FROM events WHERE created_at')){const all=p.all;p.all=async()=>{if(!injected){injected=true;await append(db,{id:'late-backdated-row',kind:'verification',payload:{late:true},actor:'fixture'},at);}return all();};}return p;};
 const events=await readCompleteHistory(db,at);assert.equal(events.length,2001);assert.ok(events.some((e,i)=>i&&e.seq>events[i-1].seq+1));assert.equal(events.some(e=>e.id==='late-backdated-row'),false);
 assert.equal((await readCompleteHistory(db,at)).length,2002);
});
test('receipt cutoff and parameterized kinds are exact; invalid selections and record overflow fail closed',async t=>{
 const {db}=temporaryDatabase(t);bulk(db,2);await append(db,{id:'future-fixture',kind:'research',actor:'fixture',payload:{}},'2026-10-28T00:00:00.000Z');
 assert.equal((await readCompleteHistory(db,at,{kinds:['verification']})).length,2);assert.equal((await readCompleteHistory(db,at,{kinds:['research']})).length,0);
 await assert.rejects(readCompleteHistory(db,'2026-10-27'),/cutoff/);await assert.rejects(readCompleteHistory(db,at,{kinds:[]}),/selection/);
 bulk(db,HISTORY_LIMITS.max_records,{start:3});await assert.rejects(readCompleteHistory(db,at),/record bound/);
});
test('byte overflow and incomplete fixed-boundary pages return no partial history',async()=>{
 const oversized={seq:1,created_at:at,payload:'x'.repeat(HISTORY_LIMITS.max_bytes),id:'oversize',kind:'verification',actor:'fixture',digest:'fixture'};
 const db={prepare(sql){return {bind(){return this;},async first(){return {head:1,count:1};},async all(){return {results:sql.includes('SELECT *')?[oversized]:[]};}};}};
 await assert.rejects(readCompleteHistory(db,at),/byte bound/);
 const empty={prepare(){return {bind(){return this;},async first(){return {head:1,count:1};},async all(){return {results:[]};}};}};
 await assert.rejects(readCompleteHistory(empty,at),/incomplete/);
});
