import {AppError,isoNow} from './store.js';
export const PAPER='https://paper-api.alpaca.markets';
export const DATA='https://data.alpaca.markets';
export const SYMBOLS=['AAPL','MSFT','SPY'];
function numeric(value,label,min=-Infinity){
 if((typeof value!=='number'&&typeof value!=='string')||String(value).trim()===''||!Number.isFinite(Number(value))||Number(value)<min)throw new AppError('Invalid numeric '+label+' from paper account.',503);
 return Number(value);
}
function validateAccountData(account,positions,orders,clock){
 if(!account||typeof account!=='object')throw new AppError('Invalid paper account response.',503);
 for(const field of ['cash','equity','portfolio_value'])numeric(account[field],field,0);
 if(!Array.isArray(positions)||!Array.isArray(orders))throw new AppError('Invalid paper positions or orders response.',503);
 for(const p of positions){
  if(!p||typeof p.symbol!=='string'||p.side!=='long')throw new AppError('Paper account contains an invalid or non-long position; reconcile external activity.',503);
  if(numeric(p.qty,'position quantity',0)===0)throw new AppError('Paper position quantity must be positive.',503);
  numeric(p.cost_basis,'position cost basis',0);numeric(p.market_value,'position market value',0);numeric(p.unrealized_pl,'position unrealized P/L');
 }
 for(const order of orders){
  if(!order||typeof order.id!=='string'||typeof order.symbol!=='string'||!['buy','sell'].includes(order.side))throw new AppError('Invalid paper order response.',503);
  const qty=numeric(order.qty,'order quantity',0);const filled=numeric(order.filled_qty,'filled quantity',0);
  if(qty===0||filled>qty)throw new AppError('Invalid paper order quantities.',503);
 }
 if(!clock||typeof clock.is_open!=='boolean')throw new AppError('Invalid paper market clock.',503);
}
export async function alpaca(env,path,{data=false,method='GET',body,fetcher=fetch}={}){
 if(!env.ALPACA_API_KEY||!env.ALPACA_SECRET_KEY)throw new AppError('Alpaca server credentials are not configured.',503);
 if(!path.startsWith('/v2/')||path.includes('://')||path.includes('..'))throw new AppError('Invalid Alpaca path.');
 if(!['GET','POST'].includes(method)||data&&method!=='GET')throw new AppError('Unsupported brokerage operation.');
 // The live trading host is deliberately absent. No configurable base URL.
 let response;try {response=await fetcher((data?DATA:PAPER)+path,{method,redirect:'manual',headers:{'APCA-API-KEY-ID':env.ALPACA_API_KEY,'APCA-API-SECRET-KEY':env.ALPACA_SECRET_KEY,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});}
 catch(e){let detail=String(e?.message||'fetch failed');for(const secret of [env.ALPACA_API_KEY,env.ALPACA_SECRET_KEY]){if(secret)detail=detail.split(secret).join('[redacted]');}throw new AppError('Alpaca transport '+String(e?.name||'Error')+': '+detail.slice(0,200),503);}
 if(!response.ok)throw new AppError('Alpaca '+(data?'IEX data':'paper API')+' returned HTTP '+response.status+'.',response.status===404?404:502);
 return response.json();
}
export async function observe(env,fetcher=fetch){
 const retrieval_started_at=isoNow();
 const [a,clock,positions,orders,t]=await Promise.all([
  alpaca(env,'/v2/account',{fetcher}),alpaca(env,'/v2/clock',{fetcher}),alpaca(env,'/v2/positions',{fetcher}),alpaca(env,'/v2/orders?status=open&limit=500',{fetcher}),alpaca(env,'/v2/stocks/trades/latest?symbols=AAPL,MSFT,SPY&feed=iex',{data:true,fetcher})]);
 validateAccountData(a,positions,orders,clock);
 if(a.status!=='ACTIVE'||a.currency!=='USD'||a.account_blocked||a.trading_blocked)throw new AppError('Paper account is not active and unrestricted in USD.',503);
 const retrieved_at=isoNow();
 const quotes=Object.fromEntries(SYMBOLS.map(symbol=>{const tr=t.trades?.[symbol];if(!tr||!Number.isFinite(tr.p)||tr.p<=0||!Number.isFinite(Date.parse(tr.t)))throw new AppError('Missing or invalid IEX trade for '+symbol,503);if(Date.parse(tr.t)>Date.now()+5000)throw new AppError('Future-dated market data for '+symbol,503);return [symbol,{symbol,price:tr.p,market_data_at:tr.t,feed:'iex',source:'Alpaca',retrieved_at,exchange:tr.x,age_seconds:Math.max(0,(Date.parse(retrieved_at)-Date.parse(tr.t))/1000)}];}));
 if(!Number.isFinite(Date.parse(clock.timestamp))||Math.abs(Date.now()-Date.parse(clock.timestamp))>120000)throw new AppError('Broker clock is stale.',503);
 return {source:'Alpaca',feed:'iex',retrieval_started_at,retrieved_at,account:{status:a.status,currency:a.currency,cash:Number(a.cash),equity:Number(a.equity),portfolio_value:Number(a.portfolio_value),account_id_suffix:a.id?.slice(-4)},clock,session:{is_open:clock.is_open,next_open:clock.next_open,next_close:clock.next_close,timezone:'America/New_York'},quotes,positions:positions.map(p=>({symbol:p.symbol,quantity:Number(p.qty),side:p.side,cost_basis:Number(p.cost_basis),market_value:Number(p.market_value),unrealized_pl:Number(p.unrealized_pl)})),open_orders:orders.map(o=>({id:o.id,client_order_id:o.client_order_id,symbol:o.symbol,side:o.side,qty:o.qty,filled_qty:o.filled_qty,status:o.status})),execution_ready:clock.is_open&&Object.values(quotes).every(q=>q.age_seconds<=120)};
}
