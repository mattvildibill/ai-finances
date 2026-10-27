// Verified official IR download. This exception is a document, not a CDN allowlist.
export const MICROSOFT_DIVIDEND_DOCUMENT = 'https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/Microsofts-Dividend-History';
export const NASDAQ_AAPL_DIVIDENDS = 'https://api.nasdaq.com/api/quote/AAPL/dividends?assetclass=stocks';
const issuerHosts = {AAPL:['investor.apple.com','www.apple.com'],MSFT:['news.microsoft.com','www.microsoft.com'],SPY:['www.ssga.com']};
export function approvedPrimaryActionSource(symbol, value) {
 if(typeof value!=='string')return false;
 let url;try{url=new URL(value);}catch{return false;}
 if(url.protocol!=='https:'||url.username||url.password||url.port)return false;
 if(symbol==='MSFT'&&value===MICROSOFT_DIVIDEND_DOCUMENT)return true;
 // Official exchange event evidence; this does not label Nasdaq as the issuer.
 if(symbol==='AAPL'&&value===NASDAQ_AAPL_DIVIDENDS)return true;
 return issuerHosts[symbol]?.includes(url.hostname)===true;
}
