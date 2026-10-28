import {alpaca,PAPER} from './alpaca.js';
import {readCompleteHistory} from './history.js';
import {AppError,canonical,hash,isoNow,acquire,renew,release,getEvent,appendLeased} from './store.js';

const fail=message=>{throw new AppError(message,423);};
const SYMBOL=/^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)?$/;
const EXCHANGES=['NYSE','NASDAQ','ARCA','AMEX','BATS','NYSEAMERICAN'];
const CLASSIFICATIONS=['ordinary_us_stock','unleveraged_noninverse_fund'];
export function managedSymbol(symbol){if(typeof symbol!=='string'||symbol.length>10||!SYMBOL.test(symbol))fail('Unsupported ordinary US ticker syntax');return symbol;}
const text=(value,label,max=12000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail('Actual '+label+' required');return value;};
const date=(value,label)=>{if(typeof value!=='string'||!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))fail('Actual '+label+' timestamp required');return Date.parse(value);};
export function assertPublicEvidenceURL(value){
 let u;try{u=new URL(value);}catch{fail('Invalid primary evidence URL');}
 if(typeof value!=='string'||value.length>2000||/[\\\s\x00-\x1f]/.test(value)||u.protocol!=='https:'||u.username||u.password||u.port||u.hash||u.hostname!==u.hostname.toLowerCase()||u.hostname.includes('xn--')||! /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(u.hostname)||/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(u.hostname))fail('Public HTTPS primary evidence URL without credentials or alternate port required');
 return u.href;
}
function assetIdentity(asset,symbol){
 managedSymbol(symbol);
 if(asset?.symbol!==symbol||asset.status!=='active'||asset.tradable!==true||asset.class!=='us_equity'||!EXCHANGES.includes(asset.exchange))fail('Actual active tradable US equity on supported exchange required');
 text(asset.id,'broker asset identity',200);text(asset.name,'broker asset name',500);
 return {id:asset.id,symbol:asset.symbol,class:asset.class,exchange:asset.exchange,name:asset.name,status:asset.status,tradable:asset.tradable};
}
export function assertManagedAsset(asset,approved){
 const p=approved?.payload??approved,symbol=p?.symbol;
 const actual=assetIdentity(asset,symbol),expected=p?.asset??p?.binding_object?.asset;
 if(!expected||canonical(actual)!==canonical(expected))fail('Broker asset identity or eligibility changed since instrument review');
 return actual;
}
const ordered=(events,asOf)=>events.filter(e=>e.created_at<=asOf).sort((a,b)=>a.seq-b.seq);
function sourceEvidence(source,now){
 if(!source||typeof source!=='object'||Array.isArray(source))fail('Actual primary instrument evidence required');
 assertPublicEvidenceURL(source.url);
 if(!/^[a-f0-9]{64}$/.test(source.content_sha256||'')||!['issuer','regulatory_filing','exchange'].includes(source.source_type))fail('Exact downloaded source-byte hash and honest primary source class required');
 text(source.publisher_name,'primary publisher',500);text(source.excerpt,'primary document finding');
 if(date(source.observed_at,'source observation')>date(now,'review')+5000)fail('Future primary evidence cannot support admission');
 return source;
}
/** Acquire one broker identity only. This does not admit a security or fetch caller URLs. */
export async function inspectManagedInstrument(db,env,{idempotency_key,symbol},actor,fetcher=fetch){
 managedSymbol(symbol);const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  const prior=await getEvent(db,idempotency_key);if(prior){if(prior.kind!=='managed_asset_observation'||prior.payload.symbol!==symbol)fail('Instrument observation idempotency mismatch');return prior;}
  const request=async(...args)=>{if(args[1]?.method!=='GET')fail('Instrument inspection is GET-only');await renew(db,'execution',token);const r=await fetcher(...args);await renew(db,'execution',token);return r;};
  try{
   const raw=await alpaca(env,'/v2/assets/'+encodeURIComponent(symbol),{fetcher:request});
   const asset=assetIdentity(raw,symbol),retrieved_at=isoNow();
   return await appendLeased(db,{id:idempotency_key,kind:'managed_asset_observation',payload:{symbol,asset,retrieved_at,source:'Alpaca paper API',source_url:PAPER+'/v2/assets/'+symbol},actor},'execution',token);
  }catch(error){
   await appendLeased(db,{id:'managed-asset-failure:'+(await hash({idempotency_key,symbol,message:error.message})).slice(0,48),kind:'managed_asset_failure',payload:{symbol,summary:error instanceof AppError?error.message:'Broker asset inspection failed'},actor},'execution',token);throw error;
  }
 }finally{await release(db,'execution',token);}
}
/** Durable instrument governance: trade-time quotes remain a separate runtime prerequisite. */
export function managedInstrumentBinding(events,input,now=isoNow()){
 const e=ordered(events,now),symbol=managedSymbol(input?.symbol),find=(id,kind)=>e.find(x=>x.id===id&&x.kind===kind);
 const observation=find(input.observation_id,'managed_asset_observation'),r=find(input.research_id,'research'),c=find(input.challenge_id,'challenge');
 if(!observation||observation.payload.symbol!==symbol||observation.payload.source_url!==PAPER+'/v2/assets/'+symbol)fail('Actual broker asset observation required');
 const asset=assetIdentity(observation.payload.asset,symbol);
 if(Math.abs(date(observation.payload.retrieved_at,'broker asset')-date(observation.created_at,'asset receipt'))>120000)fail('Broker identity was not contemporaneous when captured');
 if(e.some(x=>x.seq>observation.seq&&(x.kind==='managed_asset_failure'&&x.payload.symbol===symbol||x.kind==='managed_asset_observation'&&x.payload.symbol===symbol&&canonical(x.payload.asset)!==canonical(asset))))fail('New conflicting or failed asset evidence requires a fresh instrument observation');
 if(!CLASSIFICATIONS.includes(input.classification))fail('Only ordinary US stocks and unleveraged noninverse funds supported');
 const source=sourceEvidence(input.primary_source,now);text(input.issuer_name,'issuer or fund identity',500);text(input.instrument_assessment,'instrument classification and incidental instrument assessment');
 if(!r||!c||r.payload.role!=='researcher'||c.payload.role!=='challenger'||c.payload.research_id!==r.id||r.seq<=observation.seq||c.seq<=r.seq||r.payload.author===c.payload.author)fail('Actual independent research and challenge after observation required');
 text(r.payload.author,'research author',200);text(c.payload.author,'challenger author',200);
 const review=c.payload.instrument_review;
 if(!review||review.symbol!==symbol||review.observation_id!==observation.id||review.classification!==input.classification||review.source_url!==source.url||review.source_sha256!==source.content_sha256||review.outcome!=='supported'||review.source_provenance_verified!==true||review.no_leveraged_or_inverse_objective!==true||review.ordinary_stock_or_fund!==true)fail('Independent challenge must explicitly support exact source identity and permitted instrument classification');
 for(const rec of [r,c]){if(!Array.isArray(rec.payload.evidence)||!rec.payload.evidence.some(x=>x.url===source.url))fail('Both authors must cite the actual primary source');if(e.some(x=>x.kind==='revision'&&x.payload.supersedes===rec.id))fail('Instrument research or challenge was revised');}
 return {symbol,asset,classification:input.classification,issuer_name:input.issuer_name,instrument_assessment:input.instrument_assessment,primary_source:source,observation_id:observation.id,research_id:r.id,challenge_id:c.id,records:[observation,r,c].map(x=>({id:x.id,kind:x.kind,digest:x.digest}))};
}
export async function managedInstrumentCandidate(db,input){const events=await readCompleteHistory(db);const binding=managedInstrumentBinding(events,input);return {binding:canonical(binding),binding_sha256:await hash(binding),scope:'Instrument identity and classification only; not source coverage, trade or mandate authorization'};}
export function managedInstrumentFor(events,symbol,asOf=isoNow()){
 managedSymbol(symbol);const e=ordered(events,asOf),records=e.filter(x=>x.kind==='managed_instrument'&&x.payload.symbol===symbol),last=records.at(-1);
 if(!last)return null;if(last.payload.status!=='approved')fail('Instrument approval revoked or unresolved: '+symbol);
 const p=last.payload,binding=managedInstrumentBinding(e.filter(x=>x.seq<last.seq),p,last.created_at);
 if(p.binding!==canonical(binding)||canonical(p.asset)!==canonical(binding.asset)||!p.author||[...binding.records.slice(1)].some(ref=>e.find(x=>x.id===ref.id)?.payload.author===p.author))fail('Instrument approval differs from exact independent evidence');
 const mandate=e.find(x=>x.id===p.mandate_id&&x.kind==='managed_mandate');if(!mandate||mandate.payload.status!=='approved'||mandate.seq>=last.seq)fail('Instrument approval lacks prior managed mandate');
 if(e.some(x=>x.seq>last.seq&&(x.kind==='managed_asset_failure'&&x.payload.symbol===symbol||x.kind==='managed_asset_observation'&&x.payload.symbol===symbol&&canonical(x.payload.asset)!==canonical(p.asset)||x.kind==='revision'&&[p.research_id,p.challenge_id].includes(x.payload.supersedes)||x.kind==='verification'&&x.payload.check==='managed_instrument_review'&&x.payload.instrument_id===last.id&&x.payload.outcome!=='passed')))fail('Later adverse instrument evidence requires reviewed reapproval: '+symbol);
 return last;
}
export async function approveManagedInstrument(db,env,{idempotency_key,payload},actor){
 if(!payload||JSON.stringify(payload).length>40000)fail('Bounded instrument approval required');const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  const existing=await getEvent(db,idempotency_key);if(existing){if(existing.kind!=='managed_instrument'||existing.payload.request_hash!==await hash(payload))fail('Instrument approval idempotency mismatch');return existing;}
  const now=isoNow(),events=await readCompleteHistory(db,now);managedSymbol(payload.symbol);text(payload.author,'manager author',200);
  const previous=events.filter(x=>x.kind==='managed_instrument'&&x.payload.symbol===payload.symbol).at(-1);
  if(payload.status==='revoked'){
   if(!previous||payload.previous_approval_id!==previous.id)fail('Revocation must reference latest instrument approval');text(payload.reason,'revocation reason');
   return await appendLeased(db,{id:idempotency_key,kind:'managed_instrument',payload:{...payload,request_hash:await hash(payload)},actor},'execution',token,now,events.at(-1)?.seq??0);
  }
  if(payload.status!=='approved')fail('Explicit approved or revoked status required');
  if(previous&&payload.previous_approval_id!==previous.id)fail('Reapproval must preserve prior instrument approval');
  const mandate=events.find(x=>x.id===payload.mandate_id&&x.kind==='managed_mandate');if(!mandate||mandate.payload.status!=='approved')fail('Actual prior managed mandate required');
  const binding=managedInstrumentBinding(events,payload,now);
  if(previous&&events.find(x=>x.id===binding.challenge_id).seq<=previous.seq)fail('Reapproval requires a new independent challenge after the preceding approval or revocation');
  if(payload.binding!==canonical(binding))fail('Exact reviewed instrument binding required');
  if([binding.research_id,binding.challenge_id].some(id=>events.find(x=>x.id===id).payload.author===payload.author))fail('Manager must differ from research and challenge authors');
  await renew(db,'execution',token);
  return await appendLeased(db,{id:idempotency_key,kind:'managed_instrument',payload:{...binding,status:'approved',author:payload.author,mandate_id:payload.mandate_id,previous_approval_id:previous?.id??null,binding:canonical(binding),binding_object:binding,request_hash:await hash(payload)},actor},'execution',token,isoNow(),events.at(-1)?.seq??0);
 }finally{await release(db,'execution',token);}
}
/** Fixed-host, GET-only current account and target/held/SPY observations. Not permission to trade. */
export async function observeManaged(env,symbols,approvedBySymbol,fetcher=fetch){
 if(!Array.isArray(symbols)||symbols.length>100||!symbols.length||new Set(symbols).size!==symbols.length)fail('Bounded distinct observation symbols required');
 const scope=[...new Set([...symbols,'SPY'])];scope.forEach(managedSymbol);
 const retrieval_started_at=isoNow();
 const request=async(...args)=>{if(args[1]?.method!=='GET')fail('Managed observations are GET-only');return fetcher(...args);};
 const [a,clock,positions,orders,trades,assets]=await Promise.all([
  alpaca(env,'/v2/account',{fetcher:request}),alpaca(env,'/v2/clock',{fetcher:request}),alpaca(env,'/v2/positions',{fetcher:request}),alpaca(env,'/v2/orders?status=open&limit=500',{fetcher:request}),alpaca(env,'/v2/stocks/trades/latest?symbols='+scope.join(',')+'&feed=iex',{data:true,fetcher:request}),Promise.all(scope.map(async symbol=>{
   const raw=await alpaca(env,'/v2/assets/'+encodeURIComponent(symbol),{fetcher:request});const approved=approvedBySymbol?.[symbol];
   // Read-only inspection of existing holdings or a research candidate grants no admission.
   // The execution caller must separately require an approval for its ordered asset.
   const asset=approved?assertManagedAsset(raw,approved):assetIdentity(raw,symbol);
   return {...asset,eligibility_approval_id:approved?.id??null,retrieved_at:isoNow(),source:'Alpaca paper API',source_url:PAPER+'/v2/assets/'+symbol};
  }))]);
 const number=(v,label,min=-Infinity)=>{if(!['number','string'].includes(typeof v)||String(v).trim()===''||!Number.isFinite(Number(v))||Number(v)<min)fail('Invalid broker '+label);return Number(v);};
 if(!a||a.status!=='ACTIVE'||a.currency!=='USD'||a.account_blocked||a.trading_blocked)fail('Paper account unavailable or restricted');
 for(const k of ['cash','equity','portfolio_value'])number(a[k],k,0);
 if(!Array.isArray(positions)||!Array.isArray(orders)||orders.length>=500)fail('Invalid or possibly truncated broker account inventory');
 const seen=new Set();for(const p of positions){if(!scope.includes(p.symbol)||seen.has(p.symbol)||p.side!=='long'||!Number.isSafeInteger(number(p.qty,'quantity',1)))fail('Unexpected or unsupported paper holding');seen.add(p.symbol);for(const k of ['cost_basis','market_value'])number(p[k],k,0);number(p.unrealized_pl,'unrealized P/L');}
 for(const o of orders){if(!o||typeof o.id!=='string'||!['buy','sell'].includes(o.side)||typeof o.symbol!=='string'||number(o.qty,'order quantity',1)<number(o.filled_qty,'filled quantity',0))fail('Invalid open order');}
 const retrieved_at=isoNow();if(typeof clock?.is_open!=='boolean'||Math.abs(date(clock.timestamp,'clock')-Date.parse(retrieved_at))>120000)fail('Actual current broker clock required');
 const quotes=Object.fromEntries(scope.map(symbol=>{const t=trades?.trades?.[symbol];if(!t||typeof t.p!=='number'||!Number.isFinite(t.p)||t.p<=0||date(t.t,'trade')>Date.parse(retrieved_at)+5000)fail('Actual IEX trade unavailable for '+symbol);return [symbol,{symbol,price:t.p,price_text:String(t.p),market_data_at:t.t,feed:'iex',source:'Alpaca',retrieved_at,exchange:t.x,age_seconds:Math.max(0,(Date.parse(retrieved_at)-Date.parse(t.t))/1000)}];}));
 return {managed_mode:true,source:'Alpaca',feed:'iex',asset_metadata:Object.fromEntries(assets.map(x=>[x.symbol,x])),retrieval_started_at,retrieved_at,account:{status:a.status,currency:a.currency,cash:Number(a.cash),cash_text:String(a.cash),equity:Number(a.equity),equity_text:String(a.equity),portfolio_value:Number(a.portfolio_value),portfolio_value_text:String(a.portfolio_value),account_id_suffix:a.id?.slice(-4)},clock,session:{is_open:clock.is_open,next_open:clock.next_open,next_close:clock.next_close,timezone:'America/New_York'},quotes,positions:positions.map(p=>({symbol:p.symbol,quantity:Number(p.qty),side:p.side,cost_basis:Number(p.cost_basis),cost_basis_text:String(p.cost_basis),...(p.avg_entry_price===undefined?{}:{avg_entry_price_text:String(p.avg_entry_price)}),market_value:Number(p.market_value),market_value_text:String(p.market_value),unrealized_pl:Number(p.unrealized_pl)})),open_orders:orders.map(o=>({id:o.id,client_order_id:o.client_order_id,symbol:o.symbol,side:o.side,qty:o.qty,filled_qty:o.filled_qty,status:o.status})),execution_ready:clock.is_open&&Object.values(quotes).every(q=>q.age_seconds<=120)};
}
