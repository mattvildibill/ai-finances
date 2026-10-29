import test from 'node:test';
import assert from 'node:assert/strict';
import {displayValuation,displayPayload} from '../lib/display-valuation.js';
import {temporaryDatabase,testEnv,brokerFixture} from './helpers.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('display cache shares fixed GETs and never writes accounting or exposes buying power',async t=>{
 const {db}=temporaryDatabase(t);const f=brokerFixture({account:{buying_power:'999999',equity:'99990',cash:'99990'}});
 const first=await displayValuation(db,testEnv,f.fetcher);assert.equal(first.observation.equity,99990);assert.equal(first.observation.cash,99990);assert.equal(first.observation.price_time,null);assert.equal(first.observation.feed,null);assert.equal(first.next_poll_ms<=30000,true);
 for(let n=0;n<10;n++)assert.deepEqual((await displayValuation(db,testEnv,f.fetcher)).observation,first.observation);
 assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.method==='GET'&&c.url.startsWith('https://paper-api.alpaca.markets/v2/')));assert.deepEqual(f.calls.map(c=>new URL(c.url).pathname).sort(),['/v2/account','/v2/clock','/v2/positions']);
 assert.equal(JSON.stringify(first).includes('buying_power'),false);assert.equal((await db.prepare('SELECT COUNT(*) n FROM events').first()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM locks').first()).n,0);
});
test('concurrent display requests coalesce across callers; closed session interval is 120 seconds',async t=>{
 const {db}=temporaryDatabase(t);const f=brokerFixture({clock:{is_open:false}});let done;const gate=new Promise(r=>done=r);let calls=0;
 const fetcher=async(...args)=>{calls++;await gate;return f.fetcher(...args);};
 const first=displayValuation(db,testEnv,fetcher);await new Promise(r=>setImmediate(r));
 const other=await displayValuation(db,testEnv,fetcher);assert.equal(other.status,'updating');assert.equal(calls,3);done();const result=await first;
 assert.ok(result.next_poll_ms>119000);assert.equal((await displayValuation(db,testEnv,fetcher)).observation.retrieved_at,result.observation.retrieved_at);assert.equal(calls,3);
});
test('failures retain original observation timestamp and impose shared retry backoff',async t=>{
 const {db}=temporaryDatabase(t);const f=brokerFixture();const first=await displayValuation(db,testEnv,f.fetcher);
 await db.prepare('UPDATE display_cache SET next_fetch_at=0').run();let calls=0;
 const fail=async()=>{calls++;throw Error('fixture-secret-not-a-credential');};
 const bad=await displayValuation(db,testEnv,fail);assert.equal(bad.status,'unavailable');assert.deepEqual(bad.observation,first.observation);assert.ok(bad.next_poll_ms>119000);assert.equal(JSON.stringify(bad).includes('fixture-secret'),false);
 await displayValuation(db,testEnv,fail);assert.equal(calls,3);assert.equal((await db.prepare('SELECT COUNT(*) n FROM events').first()).n,0);
});
test('display input rejects malformed/duplicate/non-long positions and unknown times; no invented price timestamp',()=>{
 const now=new Date().toISOString(),a={currency:'USD',cash:'100',equity:'200'},c={is_open:false,timestamp:now},p={symbol:'SPY',qty:'1',side:'long',cost_basis:'90',market_value:'100',unrealized_pl:'10'};
 assert.equal(displayPayload(a,[p],c,now,now).holdings[0].current_price,null);
 for(const change of [{qty:0},{qty:null},{side:'short'},{symbol:'<script>'},{market_value:'NaN'},{unrealized_pl:null}])assert.throws(()=>displayPayload(a,[{...p,...change}],c,now,now));
 assert.throws(()=>displayPayload(a,[p,p],c,now,now));assert.throws(()=>displayPayload(a,[p],{is_open:false,timestamp:'bad'},now,now));assert.throws(()=>displayPayload({...a,currency:'EUR'},[p],c,now,now));
});
test('browser polling stops while hidden/off portfolio, avoids overlap, and backs off without state acquisition',async()=>{
 const elements=new Map(),get=s=>{if(!elements.has(s))elements.set(s,{style:{},classList:{toggle(){}},firstChild:{},textContent:''});return elements.get(s);};
 let handler,calls=[],timerDelay;const document={hidden:false,querySelector:get,querySelectorAll:()=>[]};
 const context=vm.createContext({document,URL,Intl,AbortSignal,clearTimeout(){},setTimeout(fn,ms){handler=fn;timerDelay=ms;return 1;},fetch:async(path)=>{calls.push(path);throw Error('offline');}});
 const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8').split("$$('[data-view]')")[0];vm.runInContext(source,context);
 await vm.runInContext('refreshDisplay()',context);assert.deepEqual(calls,['/api/display']);assert.equal(timerDelay,120000);
 await vm.runInContext('refreshDisplay()',context);assert.equal(timerDelay,240000);
 document.hidden=true;await handler();assert.equal(calls.length,2);
 document.hidden=false;vm.runInContext("currentView='journal'",context);await vm.runInContext('refreshDisplay()',context);assert.equal(calls.length,2);
});

test('display endpoint retains private authorization and rejects caller parameters and POST',async t=>{
 const {default:worker}=await import('../worker/index.js');const {db}=temporaryDatabase(t);const f=brokerFixture();t.mock.method(globalThis,'fetch',f.fetcher);
 const env={...testEnv,DB:db};
 assert.equal((await worker.fetch(new Request('https://private.test/api/display'),env)).status,401);
 const headers={'oai-authenticated-user-id':'isolated-owner'};
 assert.equal((await worker.fetch(new Request('https://private.test/api/display?url=https://evil.test',{headers}),env)).status,400);
 assert.equal((await worker.fetch(new Request('https://private.test/api/display',{method:'POST',headers:{...headers,Origin:'https://private.test','Content-Type':'application/json'},body:'{}'}),env)).status,404);
 assert.equal(f.calls.length,0);
 const response=await worker.fetch(new Request('https://private.test/api/display',{headers}),env);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal((await response.json()).observation.display_only,true);assert.equal(f.calls.length,3);
});

test('expired cache fetch cannot overwrite a newer owner result',async t=>{
 const {db}=temporaryDatabase(t);let now=Date.now(),resolve;const blocked=new Promise(r=>resolve=r);const old=brokerFixture({account:{equity:'99999'}}),fresh=brokerFixture({account:{equity:'100001'}});
 const pending=displayValuation(db,testEnv,async(...args)=>{await blocked;return old.fetcher(...args);},()=>now);await new Promise(r=>setImmediate(r));now+=61000;
 await displayValuation(db,testEnv,fresh.fetcher,()=>now);resolve();await pending;
 const cached=await displayValuation(db,testEnv,fresh.fetcher,()=>now);assert.equal(cached.observation.equity,100001);assert.equal(old.calls.length,3);assert.equal(fresh.calls.length,3);
});
