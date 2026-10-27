import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWriteRequest} from '../lib/request-security.js';
import {observe} from '../lib/alpaca.js';

const request=(path,headers)=>new Request('https://blue.example'+path,{method:'POST',headers,body:'{}'});
for(const path of ['/mcp','/api/records']){
 test(path+' rejects cross-origin JSON and simple text requests',()=>{
  assert.throws(()=>validateWriteRequest(request(path,{'origin':'https://attacker.example','content-type':'application/json'})),e=>e.status===403);
  assert.throws(()=>validateWriteRequest(request(path,{'content-type':'text/plain'})),e=>e.status===415);
  assert.throws(()=>validateWriteRequest(request(path,{'content-type':'text/plain; x=application/json'})),e=>e.status===415);
 });
 test(path+' permits same-origin browser and originless OAuth JSON clients',()=>{
  assert.doesNotThrow(()=>validateWriteRequest(request(path,{'origin':'https://blue.example','content-type':'application/json; charset=utf-8'})));
  assert.doesNotThrow(()=>validateWriteRequest(request(path,{'content-type':'application/json'})));
 });
}
const env={ALPACA_API_KEY:'fixture',ALPACA_SECRET_KEY:'fixture'};
const fixtures=()=>({account:{id:'paper-fixture',status:'ACTIVE',currency:'USD',cash:'100000',equity:'100000',portfolio_value:'100000',account_blocked:false,trading_blocked:false},clock:{is_open:true,timestamp:new Date().toISOString()},positions:[],orders:[],trades:{trades:Object.fromEntries(['AAPL','MSFT','SPY'].map(s=>[s,{p:100,t:new Date().toISOString(),x:'V'}]))}});
function fetcher(f){return async url=>{const u=new URL(url);const value=u.pathname==='/v2/account'?f.account:u.pathname==='/v2/clock'?f.clock:u.pathname==='/v2/positions'?f.positions:u.pathname==='/v2/orders'?f.orders:u.pathname==='/v2/assets/SPY'?{symbol:'SPY',status:'active',tradable:true,class:'us_equity',exchange:'ARCA'}:f.trades;return Response.json(value);};}
test('valid paper snapshot preserves distinct retrieval and market times',async()=>{const f=fixtures();const p=await observe(env,fetcher(f));assert.equal(p.account.cash,100000);assert.equal(p.execution_ready,true);assert.equal(p.quotes.AAPL.market_data_at,f.trades.trades.AAPL.t);assert.ok(p.retrieved_at);});
for(const value of [null,undefined,'NaN','',-1,true])test('invalid cash fails closed: '+String(value),async()=>{const f=fixtures();f.account.cash=value;await assert.rejects(observe(env,fetcher(f)),/Invalid numeric cash/);});
test('invalid position P/L cannot become a null persisted number',async()=>{const f=fixtures();f.positions=[{symbol:'AAPL',side:'long',qty:'1',cost_basis:'100',market_value:'100',unrealized_pl:'NaN'}];await assert.rejects(observe(env,fetcher(f)),/position unrealized/);});
test('external short and inconsistent fill quantities fail closed',async()=>{const f=fixtures();f.positions=[{symbol:'AAPL',side:'short',qty:'1'}];await assert.rejects(observe(env,fetcher(f)),/non-long position/);f.positions=[];f.orders=[{id:'paper-order',symbol:'AAPL',side:'buy',qty:'1',filled_qty:'2'}];await assert.rejects(observe(env,fetcher(f)),/quantities/);});
test('nonboolean market status cannot authorize execution',async()=>{const f=fixtures();f.clock.is_open='true';await assert.rejects(observe(env,fetcher(f)),/market clock/);});
