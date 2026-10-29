import {alpaca} from './alpaca.js';
import {AppError} from './store.js';

// Disposable UI cache only. Never read by accounting, history, or order guards.
const KEY='paper-valuation';
function amount(value,min=-Infinity){
 if(!['string','number'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value))||Number(value)<min)throw new AppError('Broker display values unavailable.',503);
 return Number(value);
}
export function displayPayload(account,positions,clock,started,observed){
 if(account?.currency!=='USD'||!Array.isArray(positions)||positions.length>1000||typeof clock?.is_open!=='boolean'||!Number.isFinite(Date.parse(clock.timestamp))||Math.abs(Date.parse(observed)-Date.parse(clock.timestamp))>120000)throw new AppError('Broker display response unavailable.',503);
 const seen=new Set();
 const holdings=positions.map(p=>{
  if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(p.symbol)||seen.has(p.symbol)||p.side!=='long')throw new AppError('Broker display position unavailable.',503);
  seen.add(p.symbol);
  const quantity=amount(p.qty,0);if(!quantity)throw new AppError('Broker display quantity unavailable.',503);
  return {symbol:p.symbol,quantity,cost_basis:amount(p.cost_basis,0),market_value:amount(p.market_value,0),unrealized_pl:amount(p.unrealized_pl),current_price:p.current_price===undefined?null:amount(p.current_price,0)};
 });
 return {source:'Alpaca paper account',retrieval_started_at:started,retrieved_at:observed,price_time:null,feed:null,is_open:clock.is_open,clock_at:clock.timestamp,equity:amount(account.equity,0),cash:amount(account.cash),holdings,display_only:true};
}
export async function displayValuation(db,env,fetcher=fetch,now=()=>Date.now()){
 const read=()=>db.prepare('SELECT * FROM display_cache WHERE name=?').bind(KEY).first();
 let row=await read();
 if(!row){await db.prepare('INSERT INTO display_cache(name,next_fetch_at) VALUES(?,0) ON CONFLICT(name) DO NOTHING').bind(KEY).run();row=await read();}
 const response=r=>({observation:r.payload?JSON.parse(r.payload):null,status:r.error?'unavailable':r.payload?'available':'updating',next_poll_ms:Math.max(30000,Math.min(120000,r.next_fetch_at-now())),error:r.error||null});
 if(row.next_fetch_at>now())return response(row);
 const token=crypto.randomUUID();
 // Atomic shared throttle across tabs and Worker instances; crash recovery after 60s.
 const claimed=await db.prepare('UPDATE display_cache SET token=?,next_fetch_at=? WHERE name=? AND next_fetch_at<=? RETURNING name').bind(token,now()+60000,KEY,now()).first();
 if(!claimed)return response(await read());
 const started=new Date(now()).toISOString();
 try{
  const [account,positions,clock]=await Promise.all(['/v2/account','/v2/positions','/v2/clock'].map(path=>alpaca(env,path,{fetcher})));
  const payload=displayPayload(account,positions,clock,started,new Date(now()).toISOString());
  await db.prepare('UPDATE display_cache SET payload=?,error=NULL,next_fetch_at=? WHERE name=? AND token=?').bind(JSON.stringify(payload),now()+(payload.is_open?30000:120000),KEY,token).run();
 }catch{
  // Keep the original retrieval time on stale data; no upstream error/credential leak.
  await db.prepare('UPDATE display_cache SET error=?,next_fetch_at=? WHERE name=? AND token=?').bind('Price update unavailable; showing the last broker observation.',now()+120000,KEY,token).run();
 }
 return response(await read());
}
