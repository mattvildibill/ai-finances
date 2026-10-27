import test from 'node:test';import assert from 'node:assert/strict';
import {approvedPrimaryActionSource,MICROSOFT_DIVIDEND_DOCUMENT as url,NASDAQ_AAPL_DIVIDENDS as nasdaq} from '../lib/issuer-source-policy.js';
import {recordActionEvidence,confirmCorporateAction} from '../lib/action-settlement.js';
import {actionCoverage} from '../lib/action-ledger.js';
import {canonical,listEvents} from '../lib/store.js';
import {temporaryDatabase} from './helpers.js';import {seedAction,seedCoverage} from './action-fixtures.js';
const invalid=[url.replace('https:','http:'),url.replace('cdn-dynmedia-1.microsoft.com','cdn-dynmedia-1.microsoft.com.evil.test'),url.replace('cdn-dynmedia-1','cdn-dynmedia-2'),url.replace('https://','https://user@'),url.replace('https://','https://user:password@'),url.replace('.com/','.com:8443/'),url.replace('.com/','.com:443/'),url+'/',url+'?download=1',url+'#fragment',url.replace('Microsofts-Dividend-History','other'),url.replace('/is/content/','/is/other/../content/'),url.replace('Microsofts','%4dicrosofts')];
test('Microsoft exception accepts only exact verified HTTPS document for MSFT',()=>{
 assert.equal(approvedPrimaryActionSource('MSFT',url),true);
 for(const value of invalid)assert.equal(approvedPrimaryActionSource('MSFT',value),false,value);
 for(const symbol of ['AAPL','SPY','OTHER'])assert.equal(approvedPrimaryActionSource(symbol,url),false);
 for(const value of ['https://user@www.microsoft.com/faq','https://www.microsoft.com:8443/faq'])assert.equal(approvedPrimaryActionSource('MSFT',value),false);
 assert.equal(approvedPrimaryActionSource('MSFT','https://www.microsoft.com/en-us/investor/FAQ'),true);
});
test('typed recording and exact action confirmation accept document without relabeling provenance',async t=>{
 const {db}=temporaryDatabase(t);const at=new Date().toISOString();
 const raw={id:'synthetic-msft-dividend',symbol:'MSFT',cusip:'594918104',ex_date:'2026-11-19',record_date:'2026-11-19',payable_date:'2026-12-10',rate:0.98,special:false,foreign:false};
 const seeded=await seedAction(db,raw,{confirm:false});
 const payload={...seeded.source.payload,url,observed_at:at,provenance:{scope:'Synthetic economic evidence only; no issuer attestation of broker flags'}};
 for(let i=0;i<invalid.length;i++)await assert.rejects(recordActionEvidence(db,{idempotency_key:'invalid-source-'+i,kind:'action_source',payload:{...payload,url:invalid[i]}},'fixture'),/primary source/);
 const source=await recordActionEvidence(db,{idempotency_key:'exact-msft-document',kind:'action_source',payload},'fixture');assert.deepEqual(source.payload,payload);
 const binding=canonical({action_id:raw.id,raw_event_id:seeded.page.id,raw_signature:canonical({type:'cash_dividends',raw}),source_id:source.id,source_digest:source.digest,terms:source.payload.terms});
 const review_ids=[];for(const author of ['reviewer-a','reviewer-b']){const r=await recordActionEvidence(db,{idempotency_key:'exact-'+author,kind:'action_review',payload:{author,status:'approved',binding,scope:'Synthetic test only'}},author);review_ids.push(r.id);}
 const receipt=await confirmCorporateAction(db,{...seeded.input,source_id:source.id,review_ids},'fixture-manager');assert.equal(receipt.payload.source_digest,source.digest);
});
test('coverage uses same strict source policy without bypassing other coverage guards',async t=>{
 const {db}=temporaryDatabase(t);const at=new Date().toISOString();await seedCoverage(db,{at});
 const events=await listEvents(db,at);const msft=events.find(e=>e.kind==='action_source'&&e.payload.symbol==='MSFT');msft.payload.url=url;
 assert.equal(actionCoverage(events,at).ok,true);
 for(const bad of invalid){msft.payload.url=bad;assert.equal(actionCoverage(events,at).ok,false,bad);}
 msft.payload.url=url;events.find(e=>e.kind==='coverage_review').payload.status='rejected';assert.equal(actionCoverage(events,at).ok,false);
});

test('Nasdaq AAPL exception is exact public exchange endpoint, not arbitrary host or query',async t=>{
 assert.equal(approvedPrimaryActionSource('AAPL',nasdaq),true);
 for(const symbol of ['MSFT','SPY','OTHER'])assert.equal(approvedPrimaryActionSource(symbol,nasdaq),false);
 const bad=[nasdaq.replace('https:','http:'),nasdaq.replace('https://','https://user@'),nasdaq.replace('https://','https://user:pw@'),nasdaq.replace('.com/','.com:443/'),nasdaq.replace('.com/','.com:8443/'),nasdaq.replace('api.nasdaq.com','api.nasdaq.com.evil.test'),nasdaq.replace('AAPL','MSFT'),nasdaq.replace('assetclass=stocks','assetclass=etf'),nasdaq+'&extra=1',nasdaq+'#fragment',nasdaq.replace('/dividends?','/other/../dividends?'),nasdaq.replace('AAPL','%41APL'),nasdaq.split('?')[0]];
 const {db}=temporaryDatabase(t);
 const payload={symbol:'AAPL',url:nasdaq,observed_at:new Date().toISOString(),excerpt:'Synthetic exchange evidence, not issuer authorship.',content_sha256:'a'.repeat(64),provenance:{source_kind:'official_exchange'}};
 const saved=await recordActionEvidence(db,{idempotency_key:'synthetic-nasdaq-source',kind:'action_source',payload},'fixture');assert.deepEqual(saved.payload,payload);
 for(let i=0;i<bad.length;i++){assert.equal(approvedPrimaryActionSource('AAPL',bad[i]),false,bad[i]);await assert.rejects(recordActionEvidence(db,{idempotency_key:'bad-nasdaq-source-'+i,kind:'action_source',payload:{...payload,url:bad[i]}},'fixture'),/primary source/);}
});
