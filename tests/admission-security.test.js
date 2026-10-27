import test from 'node:test';
import assert from 'node:assert/strict';
import {admissionBinding,admissionAuthorization,inspectAdmission} from '../lib/universe-admission.js';
import {policyDigest,policyCanonical,policyForVersion} from '../lib/investment-policy.js';
import {canonical} from '../lib/store.js';
import {temporaryDatabase,testEnv,brokerFixture} from './helpers.js';
import {listEvents} from '../lib/store.js';
import {toolDefs,authorize} from '../worker/index.js';

const revision='b'.repeat(40),now=()=>new Date().toISOString();
async function bindingFixture(){
 const time=now(),common={configuration_version:2,configuration_hash:await policyDigest(2),revision,observation_id:'observation',coverage_id:'coverage'};
 const values=[['observation','universe_observation',common],['coverage','action_coverage',{configuration_version:2}],['research','research',{...common,role:'researcher',author:'researcher'}],['challenge','challenge',{...common,role:'challenger',author:'challenger',research_id:'research'}],['decision','decision',{...common,role:'portfolio_manager',author:'manager',research_id:'research',challenge_id:'challenge',challenge_response:'Synthetic response',action:'hold',size:0,symbol:'IJR',admission_approval:true,authorization_reference:'Synthetic permission',fund_treatment:{classification:'unleveraged_noninverse_diversified_equity_etf',account_permissions_unchanged:true,incidental_instruments_assessment:'Synthetic assessment'}}]];
 const events=values.map(([id,kind,payload],i)=>({id,kind,payload,seq:i+1,digest:'d'.repeat(64),created_at:time}));
 const input={decision_id:'decision',observation_id:'observation',coverage_id:'coverage'};
 const binding=await admissionBinding(events,input,revision,time,false);
 // These are in-memory adversarial fixtures, deliberately not real evidence or persisted history.
 for(const [i,author] of ['reviewer-a','reviewer-b'].entries())events.push({id:author,kind:'verification',seq:6+i,created_at:time,payload:{author,check:'universe_admission_review',outcome:'passed',revision,binding:canonical(binding),summary:'Synthetic exact-binding review'}});
 events.push({id:'amendment',kind:'mandate_amendment',seq:8,created_at:time,payload:{...binding,status:'approved',effective_at:time,binding:canonical(binding),review_ids:['reviewer-a','reviewer-b']}});
 return {events,input,time,binding};
}

test('admission security: exact release, manager interpretation and all linked evidence are necessary',async()=>{
 const f=await bindingFixture();assert.equal((await admissionAuthorization(f.events,revision,f.time)).configuration_version,2);
 const attacks=[
  ['decision','admission_approval',false],['decision','authorization_reference',''],['decision','symbol','SPY'],['decision','action','buy'],['decision','size',1],['decision','author','researcher'],['decision','challenge_response',''],
  ['research','configuration_version',null],['challenge','configuration_version','2'],['decision','configuration_hash','0'.repeat(64)],['research','revision','c'.repeat(40)],['challenge','observation_id','unlinked'],['decision','coverage_id','unlinked'],['challenge','research_id','unlinked'],
  ['observation','configuration_version',null],['coverage','configuration_version',1],['decision','fund_treatment',{classification:'unleveraged_noninverse_diversified_equity_etf',account_permissions_unchanged:false,incidental_instruments_assessment:'Synthetic'}]
 ];
 for(const [id,key,value] of attacks){const changed=structuredClone(f.events);changed.find(e=>e.id===id).payload[key]=value;await assert.rejects(admissionAuthorization(changed,revision,f.time),undefined,id+'.'+key);}
 for(const release of [null,'',revision.toUpperCase(),'c'.repeat(40),'b'.repeat(39)])await assert.rejects(admissionAuthorization(f.events,release,f.time));
 const revised=[...f.events,{id:'revision',seq:9,kind:'revision',payload:{supersedes:'research'},created_at:f.time}];await assert.rejects(admissionAuthorization(revised,revision,f.time),/revised/);
});

test('admission security: distinct exact reviewers and later nonpassed evidence remain mandatory',async()=>{
 const f=await bindingFixture();
 for(const patch of [{author:'manager'},{author:'reviewer-b'},{revision:'c'.repeat(40)},{binding:'{}'},{outcome:'pending'},{summary:''}]){const changed=structuredClone(f.events);Object.assign(changed.find(e=>e.id==='reviewer-a').payload,patch);await assert.rejects(admissionAuthorization(changed,revision,f.time));}
 for(const outcome of ['failed','pending','unknown']){const changed=[...f.events,{id:'later-review',kind:'verification',seq:9,created_at:f.time,payload:{check:'universe_admission_review',binding:canonical(f.binding),revision,outcome}}];await assert.rejects(admissionAuthorization(changed,revision,f.time),/failed|unresolved/);}
 assert.deepEqual(await admissionAuthorization(f.events.filter(e=>e.kind!=='mandate_amendment'),revision,f.time),{configuration_version:1,amendment_id:null});
});

test('admission security: candidate inspection is fixed-host GET-only and grants no admission',async t=>{
 const {db}=temporaryDatabase(t),base=brokerFixture(),calls=[];
 const fetcher=async(url,options)=>{calls.push({url,method:options.method});assert.equal(options.method,'GET');assert.ok(['https://paper-api.alpaca.markets','https://data.alpaca.markets'].includes(new URL(url).origin));if(new URL(url).pathname.startsWith('/v2/assets/'))return Response.json({symbol:new URL(url).pathname.split('/').at(-1),status:'active',tradable:true,class:'us_equity',exchange:'ARCA'});if(new URL(url).pathname==='/v2/stocks/trades/latest')return Response.json({trades:Object.fromEntries(['AAPL','MSFT','SPY','IJR'].map(symbol=>[symbol,{p:100,t:now(),x:'V'}]))});return base.fetcher(url,options);};
 for(const configuration_version of [null,undefined,1,3,'2',{},true])await assert.rejects(inspectAdmission(db,testEnv,{idempotency_key:'invalid-inspection',configuration_version},'fixture',fetcher),/candidate/);
 assert.equal(calls.length,0);
 await inspectAdmission(db,testEnv,{idempotency_key:'valid-inspection',configuration_version:2,url:'https://evil.example',symbols:['EVIL']},'fixture',fetcher);
 const events=await listEvents(db,now());assert.deepEqual(events.map(e=>e.kind),['universe_observation']);assert.equal((await admissionAuthorization(events,revision)).configuration_version,1);
 assert.ok(calls.some(c=>new URL(c.url).pathname==='/v2/assets/IJR'));assert.ok(calls.every(c=>!c.url.includes('EVIL')));
});

test('admission security: strict versions and existing private authorization remain unchanged',()=>{
 for(const version of [null,0,3,'1','2',{},true,NaN])assert.throws(()=>policyForVersion(version));
 assert.deepEqual(toolDefs.find(t=>t.name==='universe_admission').inputSchema.properties.operation.enum,['status','inspect','review_candidate','stage']);
 assert.throws(()=>authorize(new Request('https://example.invalid/mcp'),{}),/Sign in/);
 assert.throws(()=>authorize(new Request('https://example.invalid/mcp',{headers:{authorization:'Bearer wrong'}}),{SERVICE_TOKEN:'fixture-token'}),/Sign in/);
 assert.equal(authorize(new Request('https://example.invalid/mcp',{headers:{authorization:'Bearer fixture-token'}}),{SERVICE_TOKEN:'fixture-token'}),'cloud-service');
});
