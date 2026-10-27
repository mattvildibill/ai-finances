import {usdNanos} from './precision.js';

// Projection only. Never mutates the analytical weighted-average ledger or spendable cash.
// Alpaca documents intraday weighted average, daily compressed FIFO, and NY BOD02:15–02:30.
export const BROKER_BASIS_POLICY='alpaca-daily-compressed-fifo-v1';
const fail=m=>{throw new Error('Broker basis projection: '+m);};
const gcd=(a,b)=>{a=a<0n?-a:a;b=b<0n?-b:b;while(b){[a,b]=[b,a%b];}return a;};
const rat=(n,d=1n)=>{n=BigInt(n);d=BigInt(d);if(d<=0n)fail('invalid rational denominator');const g=gcd(n,d);return {n:n/g,d:d/g};};
const add=(a,b)=>rat(a.n*b.d+b.n*a.d,a.d*b.d),sub=(a,b)=>rat(a.n*b.d-b.n*a.d,a.d*b.d),mul=(a,b)=>rat(a.n*b.n,a.d*b.d),div=(a,b)=>{if(b.n<=0n)fail('invalid divisor');return rat(a.n*b.d,a.d*b.n);};
const min=(a,b)=>a.n*b.d<=b.n*a.d?a:b;
const out=a=>({numerator:a.n.toString(),denominator:a.d.toString()});
const integer=(n,label)=>{if(!Number.isSafeInteger(n)||n<0)fail('invalid '+label);return BigInt(n);};
function stamp(t){if(typeof t!=='string'||!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(t)||!Number.isFinite(Date.parse(t)))fail('invalid timestamp');return Date.parse(t);}
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function ny(t){const p=Object.fromEntries(formatter.formatToParts(new Date(stamp(t))).map(x=>[x.type,x.value]));return {day:p.year+'-'+p.month+'-'+p.day,minute:Number(p.hour)*60+Number(p.minute)};}
const previous=day=>new Date(Date.parse(day+'T12:00:00Z')-86400000).toISOString().slice(0,10);
const qty=lots=>lots.reduce((s,l)=>add(s,l.q),rat(0n));
const cost=lots=>lots.reduce((s,l)=>add(s,l.c),rat(0n));
function consume(lots,quantity){let left=rat(quantity),removed=rat(0n);while(left.n){if(!lots.length)fail('sale exceeds owned shares');const l=lots[0],take=min(left,l.q),basis=mul(l.c,div(take,l.q));removed=add(removed,basis);l.q=sub(l.q,take);l.c=sub(l.c,basis);left=sub(left,take);if(!l.q.n)lots.shift();}return removed;}
function split(lots,p){const before=integer(p.before?.active,'split before'),after=integer(p.after?.active,'split after');if(qty(lots).n!==before*qty(lots).d)fail('split receipt does not match historical quantity');if(!before){if(after)fail('split creates unowned shares');return;}if(!after)fail('unsupported split liquidation');for(const l of lots)l.q=mul(l.q,rat(after,before));}
function serialize(lots,realized){const q=qty(lots);if(q.d!==1n||q.n>BigInt(Number.MAX_SAFE_INTEGER))fail('unsupported final fractional/unsafe quantity');return {quantity:Number(q.n),cost_nanos:out(cost(lots)),realized_pnl_nanos:out(realized),lots:lots.map(l=>({day:l.day,quantity:out(l.q),cost_nanos:out(l.c)}))};}
/** Input is canonical received events (ledger_fill/action_split), not order averages.
 * Only events known and economically effective by asOf are included. Caller must ensure complete history.
 * Before BOD only the preceding NY day may remain intraday; older days must already be compressed.
 * During the documented window two whole-portfolio states are returned, never arbitrary per-symbol mixing.
 */
export function projectBrokerBasis(events,asOf,{knowledgeAsOf=asOf}={}){
 const cutoff=stamp(asOf),knowledgeCutoff=stamp(knowledgeAsOf),local=ny(asOf),yesterday=previous(local.day);
 const timeline=[],seen=new Set();
 for(const e of events){if(!['ledger_fill','action_split'].includes(e.kind))continue;if(stamp(e.created_at)>knowledgeCutoff)continue;
  if(!e.id||seen.has(e.id))fail('duplicate or missing receipt identity');seen.add(e.id);
  if(e.kind==='ledger_fill'){const f=e.payload?.fill;if(!f||!['buy','sell'].includes(f.side)||!f.symbol||integer(f.quantity,'fill quantity')===0n)fail('unsupported fill');if(stamp(f.occurred_at)>cutoff)continue;if(f.fee_cents!==undefined&&f.fee_cents!==0)fail('nonzero fees require explicit projection');const price=f.price_text===undefined?integer(f.price_cents,'cent price')*10000000n:usdNanos(f.price_text);if(price<=0n)fail('nonpositive fill price');timeline.push({kind:'fill',day:ny(f.occurred_at).day,time:stamp(f.occurred_at),seq:e.seq??0,symbol:f.symbol,quantity:BigInt(f.quantity),side:f.side,amount:price*BigInt(f.quantity)});
  }else{const p=e.payload;if(!/^\d{4}-\d{2}-\d{2}$/.test(p?.effective_date||'')||new Date(p.effective_date+'T12:00:00Z').toISOString().slice(0,10)!==p.effective_date||!p.symbol)fail('invalid split receipt');if(p.effective_date>local.day)continue;timeline.push({kind:'split',day:p.effective_date,time:-Infinity,seq:e.seq??0,symbol:p.symbol,p});}
 }
 timeline.sort((a,b)=>a.day.localeCompare(b.day)||a.time-b.time||a.seq-b.seq);
 const boundaries=local.minute<135?[{label:'before_bod',through:previous(yesterday)}]:local.minute<150?[{label:'bod_pending',through:previous(yesterday)},{label:'bod_completed',through:yesterday}]:[{label:'after_bod',through:yesterday}];
 const candidates=boundaries.map(boundary=>{const holdings={},symbols=[...new Set(timeline.map(x=>x.symbol))].sort();for(const symbol of symbols){let lots=[],realized=rat(0n);const rows=timeline.filter(x=>x.symbol===symbol),days=[...new Set(rows.map(x=>x.day))];
   for(const day of days){const daily=rows.filter(x=>x.day===day);for(const e of daily.filter(x=>x.kind==='split'))split(lots,e.p);const fills=daily.filter(x=>x.kind==='fill');
    // Validate economic inventory in chronological order even when EOD compresses later buys.
    let running=qty(lots);for(const f of fills){running=add(running,rat(f.side==='buy'?f.quantity:-f.quantity));if(running.n<0n)fail('chronological sale exceeds owned shares');}
    if(day<=boundary.through){const buys=fills.filter(f=>f.side==='buy'),buyQ=buys.reduce((s,f)=>s+f.quantity,0n),buyCost=buys.reduce((s,f)=>s+f.amount,0n);if(buyQ)lots.push({day,q:rat(buyQ),c:rat(buyCost)});for(const f of fills.filter(f=>f.side==='sell'))realized=add(realized,sub(rat(f.amount),consume(lots,f.quantity)));
    }else{for(const f of fills){if(f.side==='buy')lots.push({day,q:rat(f.quantity),c:rat(f.amount)});else{const totalQ=qty(lots),totalC=cost(lots),removed=mul(totalC,div(rat(f.quantity),totalQ));realized=add(realized,sub(rat(f.amount),removed));const remaining=sub(totalQ,rat(f.quantity));lots=remaining.n?[{day,q:remaining,c:sub(totalC,removed)}]:[];}}}
   }
   const value=serialize(lots,realized);if(value.quantity||value.realized_pnl_nanos.numerator!=='0')holdings[symbol]=value;
  }return {phase:boundary.label,compressed_through:boundary.through,holdings};});
 return {policy:BROKER_BASIS_POLICY,as_of:asOf,knowledge_as_of:knowledgeAsOf,new_york_date:local.day,bod_ambiguous:candidates.length===2,candidates,precision:'Exact rational nano-dollars; no broker rounding tolerance inferred.'};
}
/** Exact representable comparison only. A rounded broker decimal is not silently accepted. */
export function exactBrokerBasisMatches(projected,raw){try{return usdNanos(raw)*BigInt(projected.denominator)===BigInt(projected.numerator);}catch{return false;}}

export const BROKER_BASIS_DISPLAY_POLICY='derived-basis-display-half-up-v1';
/** Explicit application display normalization, NOT a claim of Alpaca's undocumented rounding rule.
 * Exact nano-dollar results remain strict. Nonrepresentable rationals may be compared at
 * the reported 2..9 decimal precision; integer text does not grant a whole-dollar tolerance.
 */
export function brokerBasisDisplayMatch(projected,raw){
 try{
  const text=String(raw);if(!/^\d+(?:\.\d{1,9})?$/.test(text))throw new Error('Invalid unsigned basis display');
  const n=BigInt(projected.numerator),d=BigInt(projected.denominator);if(n<0n||d<=0n)throw new Error('Invalid exact basis');
  const digits=Math.max(2,(text.split('.')[1]||'').length),unit=10n**BigInt(9-digits),den=d*unit;
  const rounded=n/den+(2n*(n%den)>=den?1n:0n),scale=10n**BigInt(digits);
  const expected=(rounded/scale).toString()+'.'+(rounded%scale).toString().padStart(digits,'0');
  const exact=n%d===0n,matched=exact?usdNanos(text)===n/d:usdNanos(text)===rounded*unit;
  return {matched,policy:exact?'exact-nano-dollar':BROKER_BASIS_DISPLAY_POLICY,raw:text,precision:digits,expected_display:expected,exact_nanos:{numerator:n.toString(),denominator:d.toString()}};
 }catch{return {matched:false,policy:BROKER_BASIS_DISPLAY_POLICY,raw:String(raw),error:'Unsupported basis display or rational'};}
}
