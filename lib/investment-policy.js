import {canonical,hash,parseRow} from './store.js';
/** Source-controlled permitted universe. Changes require a recorded mandate revision
 * and independent release review; no caller or environment override exists.
 * A configuration entry alone never bypasses broker eligibility or source coverage.
 */
const instruments = Object.freeze([
 Object.freeze({symbol:'AAPL',instrument_type:'stock',max_weight:.10}),
 Object.freeze({symbol:'MSFT',instrument_type:'stock',max_weight:.10}),
 Object.freeze({symbol:'SPY',instrument_type:'diversified_equity_etf',max_weight:.25}),
]);
export const INVESTMENT_POLICY = Object.freeze({
 configuration_version:1,
 mandate_version:1,
 instruments,
 limits:Object.freeze({initial_cash_cents:10_000_000,stock_weight:.10,etf_weight:.25,gross_weight:.90,cash_weight:.10,order_weight:.05}),
 expansion_requirement:'Recorded mandate amendment, concrete instrument approval, current broker eligibility and independent release review before trading.',
});
export const PERMITTED_SYMBOLS = Object.freeze(instruments.map(instrument=>instrument.symbol));
export const PERMITTED_SYMBOL_QUERY = PERMITTED_SYMBOLS.join(',');
export const permittedInstrument = symbol => instruments.find(instrument=>instrument.symbol===symbol) ?? null;

// Candidate configuration is discoverable for evidence collection, never an admission by itself.
const version2=Object.freeze({...INVESTMENT_POLICY,configuration_version:2,mandate_version:2,instruments:Object.freeze([...instruments,Object.freeze({symbol:'IJR',instrument_type:'diversified_equity_etf',max_weight:.25})])});
export function policyForVersion(version=1){if(version===1)return INVESTMENT_POLICY;if(version===2)return version2;throw new Error('Unknown reviewed universe configuration');}
export const symbolsForVersion=(version=1)=>policyForVersion(version).instruments.map(i=>i.symbol);
export function policyCanonical(version=1){return canonical(policyForVersion(version));}
export const policyDigest=(version=1)=>hash(policyForVersion(version));
export function policyVersionAt(events,asOf=new Date().toISOString()){
 const amendments=events.filter(e=>e.kind==='mandate_amendment'&&e.created_at<=asOf).sort((a,b)=>a.seq-b.seq);
 if(!amendments.length)return 1;
 if(amendments.length!==1)throw new Error('Ambiguous universe amendment history');
 const e=amendments[0],p=e.payload;
 if(p.from_version!==1||p.configuration_version!==2||p.mandate_version!==2||p.status!=='approved'||p.configuration!==policyCanonical(2)||p.effective_at!==e.created_at)throw new Error('Invalid prospective universe amendment');
 return 2;
}
export async function policyEvents(db,asOf=new Date().toISOString()){
 const r=await db.prepare("SELECT * FROM events WHERE kind='mandate_amendment' AND created_at<=? ORDER BY seq").bind(asOf).all();return r.results.map(parseRow);
}
export async function activePolicyVersion(db,asOf=new Date().toISOString()){return policyVersionAt(await policyEvents(db,asOf),asOf);}
