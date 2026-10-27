import {registeredInstrument} from './investment-policy.js';
// Verified official IR download. This exception is a document, not a CDN allowlist.
export const MICROSOFT_DIVIDEND_DOCUMENT = 'https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/Microsofts-Dividend-History';
export const NASDAQ_AAPL_DIVIDENDS = 'https://api.nasdaq.com/api/quote/AAPL/dividends?assetclass=stocks';
// Official US IJR page inspected via web tool. Raw capture was proxy-blocked (403);
// this URL rule is not a captured-byte hash, economic confirmation or asset admission.
export const IJR_PRIMARY_PRODUCT = 'https://www.ishares.com/us/products/239774/ishares-core-sp-smallcap-etf';
export function approvedPrimaryActionSource(symbol,value,version=1){
 if(typeof value!=='string')return false;
 let url,entry;try{url=new URL(value);entry=registeredInstrument(symbol,version);}catch{return false;}
 if(!entry||url.protocol!=='https:'||url.username||url.password||url.port)return false;
 return entry.primary_sources.urls.includes(value)||entry.primary_sources.hosts.includes(url.hostname);
}
