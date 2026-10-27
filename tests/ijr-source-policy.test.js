import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedPrimaryActionSource,IJR_PRIMARY_PRODUCT as url} from '../lib/issuer-source-policy.js';
import {recordActionEvidence} from '../lib/action-settlement.js';

test('IJR primary-source exception is one exact official US product URL and only that symbol',()=>{
 assert.equal(approvedPrimaryActionSource('IJR',url,2),true);
 assert.equal(approvedPrimaryActionSource('IJR',url),false);
 for(const version of [0,3,null,'2',NaN,Infinity])assert.equal(approvedPrimaryActionSource('IJR',url,version),false);
 for(const version of [0,3,null,'1',NaN,Infinity])assert.equal(approvedPrimaryActionSource('SPY','https://www.ssga.com/anything',version),false);
 for(const symbol of ['AAPL','MSFT','SPY','ijr','IJR ','OTHER'])assert.equal(approvedPrimaryActionSource(symbol,url,2),false,symbol);
 for(const value of [null,{},42,''])assert.equal(approvedPrimaryActionSource('IJR',value,2),false);
});

test('IJR URL exception rejects host, path, query, fragment, credentials, ports and scheme variants before persistence',async()=>{
 const rejected=[
  url+'/',url+'?download=true',url+'#distributions',url.replace('/239774/','/239775/'),
  url.replace('ishares-core-sp-smallcap-etf','another-product'),url.replace('/us/','/au/'),
  url.replace('https:','http:'),url.replace('https:','file:'),url.replace('https://','https://user@'),
  url.replace('https://','https://user:password@'),url.replace('.com/','.com:443/'),url.replace('.com/','.com:8443/'),
  url.replace('www.ishares.com','ishares.com'),url.replace('www.ishares.com','www.ishares.com.evil.example'),
  url.replace('www.ishares.com','evil.example@www.ishares.com'),url.replace('www.ishares.com','www.blackrock.com'),
  url.replace('www.ishares.com','WWW.ISHARES.COM'),url.replace('www.ishares.com','www.isharеs.com'),
  url.replace('www.ishares.com','www.ishares.com.'),url.replace('/products/','/products/../products/'),
  url.replace('/products/','/%70roducts/'),url.replace('/products/','//products/'),
  url.replace('239774','%32%33%39%37%37%34'),url+'?redirect=https://evil.example',
  url.replace('https://','https:\\'),url+'\n',url.replace('/us/','/US/')
 ];
 const db={prepare(){throw new Error('Invalid source must not access database');}};
 for(const candidate of rejected){
  assert.equal(approvedPrimaryActionSource('IJR',candidate,2),false,candidate);
  await assert.rejects(recordActionEvidence(db,{idempotency_key:'ijr-invalid-source',kind:'action_source',payload:{configuration_version:2,symbol:'IJR',url:candidate,excerpt:'Synthetic fixture only',content_sha256:'a'.repeat(64),observed_at:new Date().toISOString()}},'fixture'),/primary source/);
 }
});
