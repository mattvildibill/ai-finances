import {canonical,hash,parseRow} from './store.js';
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
/** Reviewed source data, not runtime admission. Additions require an audited data commit
 * and a prospective immutable mandate amendment before they can reach execution. */
export const INSTRUMENT_REGISTRY=freeze({
 AAPL:{symbol:'AAPL',instrument_type:'stock',asset_class:'us_equity',primary_sources:{hosts:['investor.apple.com','www.apple.com'],urls:['https://api.nasdaq.com/api/quote/AAPL/dividends?assetclass=stocks']}},
 MSFT:{symbol:'MSFT',instrument_type:'stock',asset_class:'us_equity',primary_sources:{hosts:['news.microsoft.com','www.microsoft.com'],urls:['https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/Microsofts-Dividend-History']}},
 SPY:{symbol:'SPY',instrument_type:'diversified_equity_etf',asset_class:'us_equity',primary_sources:{hosts:['www.ssga.com'],urls:[]}},
 IJR:{symbol:'IJR',instrument_type:'diversified_equity_etf',asset_class:'us_equity',primary_sources:{hosts:[],urls:['https://www.ishares.com/us/products/239774/ishares-core-sp-smallcap-etf']}},
});
const limits=freeze({initial_cash_cents:10_000_000,stock_weight:.10,etf_weight:.25,gross_weight:.90,cash_weight:.10,order_weight:.05});
const base=freeze({configuration_version:1,mandate_version:1,instruments:[{symbol:'AAPL',instrument_type:'stock',max_weight:.10},{symbol:'MSFT',instrument_type:'stock',max_weight:.10},{symbol:'SPY',instrument_type:'diversified_equity_etf',max_weight:.25}],limits,expansion_requirement:'Recorded mandate amendment, concrete instrument approval, current broker eligibility and independent release review before trading.'});
/** Source-controlled append-only configuration declarations. Historical entries must never change. */
const declarations=freeze([{version:1,parent_version:null,symbols:['AAPL','MSFT','SPY']},{version:2,parent_version:1,symbols:['AAPL','MSFT','SPY','IJR']}]);
/** Pure registry compiler exported for isolated hypothetical-version tests. Runtime callers
 * cannot supply its inputs: all production consumers use the closed source registry below. */
export function compilePolicyRegistry(entries,definitions){
 const policies=new Map(),parents=new Map();
 for(const d of definitions){
  if(!Number.isSafeInteger(d.version)||d.version<1||policies.has(d.version)||!Array.isArray(d.symbols)||!d.symbols.length||new Set(d.symbols).size!==d.symbols.length)throw new Error('Invalid reviewed configuration declaration');
  if(d.version===1){if(d.parent_version!==null||canonical(d.symbols)!==canonical(base.instruments.map(i=>i.symbol)))throw new Error('Historical base configuration cannot change');}
  else if(!Number.isSafeInteger(d.parent_version)||d.parent_version!==[...policies.keys()].at(-1)||!policies.has(d.parent_version)||d.version<=d.parent_version)throw new Error('Configuration requires a prior declared parent');
  const instruments=d.symbols.map(symbol=>{
   const e=entries[symbol];if(!/^[A-Z][A-Z0-9.\-]{0,14}$/.test(symbol)||!e||e.symbol!==symbol||e.asset_class!=='us_equity'||!['stock','diversified_equity_etf'].includes(e.instrument_type))throw new Error('Unsupported or unregistered instrument');
   if(!e.primary_sources||!Array.isArray(e.primary_sources.hosts)||!Array.isArray(e.primary_sources.urls)||!e.primary_sources.hosts.length&&!e.primary_sources.urls.length)throw new Error('Reviewed primary source rules required');
   return {symbol,instrument_type:e.instrument_type,max_weight:e.instrument_type==='stock'?.10:.25};
  });
  if(d.version>1){const previous=policies.get(d.parent_version).instruments;if(instruments.length<=previous.length||canonical(instruments.slice(0,previous.length))!==canonical(previous))throw new Error('Configurations may only append supported instruments; existing identity and caps cannot change');}
  const policy=freeze({...base,configuration_version:d.version,mandate_version:d.version,instruments});
  if(d.version===1&&canonical(policy)!==canonical(base))throw new Error('Historical base configuration cannot change');
  policies.set(d.version,policy);parents.set(d.version,d.parent_version);
 }
 const policyForVersion=(version=1)=>{if(!policies.has(version))throw new Error('Unknown reviewed universe configuration');return policies.get(version);};
 const policyParentVersion=version=>{policyForVersion(version);return parents.get(version);};
 const candidatePolicyVersions=from=>{policyForVersion(from);return [...parents].filter(([,p])=>p===from).map(([v])=>v);};
 function latestPolicyAmendment(events,asOf=new Date().toISOString()){
  const amendments=events.filter(e=>e.kind==='mandate_amendment'&&e.created_at<=asOf).sort((a,b)=>a.seq-b.seq);let active=1,previous=null;
  for(const e of amendments){const p=e.payload,policy=policyForVersion(p.configuration_version);
   if(p.from_version!==active||policyParentVersion(p.configuration_version)!==active||p.mandate_version!==p.configuration_version||p.status!=='approved'||p.configuration!==canonical(policy)||p.effective_at!==e.created_at||previous&&(p.previous_amendment_id!==previous.id||e.seq<=previous.seq||e.created_at<previous.created_at)||!previous&&p.previous_amendment_id!==undefined&&p.previous_amendment_id!==null)throw new Error('Invalid prospective universe amendment chain');
   active=p.configuration_version;previous=e;
  }
  return previous;
 }
 return Object.freeze({policyForVersion,policyParentVersion,candidatePolicyVersions,latestPolicyAmendment,policyVersionAt:(events,asOf)=>latestPolicyAmendment(events,asOf)?.payload.configuration_version??1,versions:Object.freeze([...policies.keys()])});
}
const registry=compilePolicyRegistry(INSTRUMENT_REGISTRY,declarations);
export const {policyForVersion,policyParentVersion,candidatePolicyVersions,latestPolicyAmendment,policyVersionAt}=registry;
export const CONFIGURATION_VERSIONS=registry.versions;
export const INVESTMENT_POLICY=policyForVersion(1);
export const PERMITTED_SYMBOLS=freeze(INVESTMENT_POLICY.instruments.map(i=>i.symbol));
export const PERMITTED_SYMBOL_QUERY=PERMITTED_SYMBOLS.join(',');
export const permittedInstrument=symbol=>INVESTMENT_POLICY.instruments.find(i=>i.symbol===symbol)??null;
export const symbolsForVersion=(version=1)=>policyForVersion(version).instruments.map(i=>i.symbol);
export const registeredInstrument=(symbol,version=1)=>symbolsForVersion(version).includes(symbol)?INSTRUMENT_REGISTRY[symbol]??null:null;
export const policyCanonical=(version=1)=>canonical(policyForVersion(version));
export const policyDigest=(version=1)=>hash(policyForVersion(version));
export async function policyEvents(db,asOf=new Date().toISOString()){
 const r=await db.prepare("SELECT * FROM events WHERE kind='mandate_amendment' AND created_at<=? ORDER BY seq").bind(asOf).all();return r.results.map(parseRow);
}
export async function activePolicyVersion(db,asOf=new Date().toISOString()){return policyVersionAt(await policyEvents(db,asOf),asOf);}
