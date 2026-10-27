import {activePolicyVersion,policyEvents,policyDigest} from '../lib/investment-policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {append,getEvent,listEvents,canonical,appendLeased,acquire,release} from '../lib/store.js';
import {observe} from '../lib/alpaca.js';
import {activateValidation,activateExperiment} from '../lib/activation.js';
import {executeValidationDecision,executeDecision,executeRolloutDecision} from '../lib/execution.js';
import {stageValidation,VALIDATION_AUTHORIZATION,VALIDATION_LIMITS,VALIDATION_PENDING,VALIDATION_CHECKS} from '../lib/validation-policy.js';
import {reconcile,readLedger} from '../lib/reconciliation.js';
import {temporaryDatabase,testEnv,brokerFixture} from './helpers.js';
import {seedCoverage} from './action-fixtures.js';
import {rolloutReviewCandidate,stageRollout,rolloutPrerequisites,rolloutOrderLimits,ROLLOUT_LIMITS,ROLLOUT_AUTHORIZATION} from '../lib/rollout-policy.js';
import {marketDate} from '../lib/action-ledger.js';
const actor='synthetic:rollout-manager',pilotRevision='a'.repeat(40),releaseRevision='b'.repeat(40);
const pilotEnv={...testEnv,RELEASE_REVISION:pilotRevision,VALIDATION_ENABLED:'true'};
const rolloutEnv={...testEnv,RELEASE_REVISION:releaseRevision,ROLLOUT_ENABLED:'true'};
const now=()=>new Date().toISOString();
const records=db=>listEvents(db,now());

// The fixture exercises the real protocol, opening, submission and reconciliation
// functions. Its broker never connects to a network or writes official records.
function broker(){
 const base=brokerFixture();const orders=new Map(),activities=[],holdings=new Map();let cash=100000,posts=0,lookups=0;
 const marks={AAPL:100,MSFT:200,SPY:500,IJR:100};
 const fetcher=async(url,options)=>{
  const u=new URL(url);assert.ok(['https://paper-api.alpaca.markets','https://data.alpaca.markets'].includes(u.origin));
  if(options.method==='POST'){
   assert.equal(u.pathname,'/v2/orders');const payload=JSON.parse(options.body);posts++;
   const order={...payload,id:'synthetic-broker-order-'+posts,asset_class:'us_equity',status:'new',filled_qty:'0',created_at:now()};orders.set(order.client_order_id,order);return Response.json(order);
  }
  assert.equal(options.method,'GET');
  if(u.pathname.startsWith('/v2/assets/')){const symbol=u.pathname.split('/').at(-1);return Response.json({symbol,status:'active',tradable:true,class:'us_equity',exchange:symbol==='SPY'?'ARCA':'NASDAQ'});}
  if(u.pathname==='/v2/orders:by_client_order_id'){lookups++;return Response.json(orders.get(u.searchParams.get('client_order_id')));}
  if(u.pathname==='/v2/orders')return Response.json([...orders.values()].filter(o=>o.status==='new'));
  if(u.pathname==='/v2/account/activities/FILL')return Response.json(activities);
  if(u.pathname==='/v2/stocks/trades/latest')return Response.json({trades:Object.fromEntries(Object.entries(marks).map(([s,p])=>[s,{p,t:now(),x:'V'}]))});
  if(u.pathname==='/v2/account'){const value=cash+[...holdings].reduce((v,[s,h])=>v+h.qty*marks[s],0);return Response.json({status:'ACTIVE',currency:'USD',cash:cash.toFixed(2),equity:value.toFixed(2),portfolio_value:value.toFixed(2)});}
  if(u.pathname==='/v2/positions')return Response.json([...holdings].map(([symbol,h])=>({symbol,side:'long',qty:String(h.qty),cost_basis:h.cost.toFixed(2),market_value:(h.qty*marks[symbol]).toFixed(2),unrealized_pl:(h.qty*marks[symbol]-h.cost).toFixed(2)})));
  return base.fetcher(url,options);
 };
 const settle=(terminalStatus='filled')=>{for(const o of orders.values())if(o.status==='new'){const q=Number(o.qty),p=marks[o.symbol],h=holdings.get(o.symbol)||{qty:0,cost:0};assert.equal(o.side,'buy');cash-=q*p;holdings.set(o.symbol,{qty:h.qty+q,cost:h.cost+q*p});o.status=terminalStatus;o.filled_qty=o.qty;o.filled_avg_price=String(p);o.filled_at=now();activities.push({id:'fill-'+o.id,activity_type:'FILL',type:'fill',order_id:o.id,symbol:o.symbol,side:o.side,qty:o.qty,price:String(p),transaction_time:o.filled_at});}};
 return {fetcher,settle,orders,activities,get posts(){return posts;},get lookups(){return lookups;}};
}
export async function decisionChain(db,f,id,{symbol='SPY',size=500,limit=50000}={}){
 const snapshot=await append(db,{id:id+'-snapshot',kind:'snapshot',actor,payload:await observe(testEnv,f.fetcher,await activePolicyVersion(db))});
 const version=await activePolicyVersion(db);const amendment=(await policyEvents(db)).at(-1);
 const common={snapshot_ids:[snapshot.id],...(version===2?{configuration_version:2,configuration_hash:await policyDigest(2),amendment_id:amendment.id}:{})};
 const research=await append(db,{id:id+'-research',kind:'research',actor,payload:{...common,role:'researcher',author:'synthetic-researcher',thesis:'Isolated test thesis'}});
 const challenge=await append(db,{id:id+'-challenge',kind:'challenge',actor,payload:{...common,role:'challenger',author:'synthetic-challenger',research_id:research.id,counterargument:'Isolated test counterargument'}});
 return append(db,{id,kind:'decision',actor,payload:{...common,role:'portfolio_manager',author:'synthetic-manager',research_id:research.id,challenge_id:challenge.id,challenge_response:'Isolated test response',symbol,action:'buy',size,limit_price_cents:limit,valid_until:new Date(Date.now()+60000).toISOString()}});
}
async function checks(db,revision,prefix){const result={};for(const check of VALIDATION_CHECKS){const id=prefix+'-'+check;await append(db,{id,kind:'verification',actor,payload:{check,revision,outcome:'passed',summary:'Isolated measured-check fixture only'}});result[check]=id;}return result;}
export async function completedPilot(db,{terminalStatus='filled'}={}){
 const f=broker(),decision=await decisionChain(db,f,'pilot-decision');await seedCoverage(db);
 const protocol=await stageValidation(db,pilotEnv,{idempotency_key:'pilot-protocol',kind:'validation_protocol',payload:{revision:pilotRevision,status:'approved',mandate_version:1,protocol_version:1,authorization_reference:VALIDATION_AUTHORIZATION,general_trading_enabled:false,limits:VALIDATION_LIMITS,pending_evidence:VALIDATION_PENDING,decision_id:decision.id,valid_until:decision.payload.valid_until}},actor);
 await stageValidation(db,pilotEnv,{idempotency_key:'pilot-release',kind:'validation_release',payload:{revision:pilotRevision,status:'approved',protocol_id:protocol.id,checks:await checks(db,pilotRevision,'pilot-check')}},actor);
 const opening=await activateValidation(db,pilotEnv,{idempotency_key:'pilot-inception'},actor,f.fetcher);
 await reconcile(db,pilotEnv,'pilot-preorder-reconciliation',actor,f.fetcher);
 await executeValidationDecision(db,pilotEnv,decision.id,actor,f.fetcher);f.settle(terminalStatus);
 const reconciliation=await reconcile(db,pilotEnv,'pilot-filled-reconciliation',actor,f.fetcher);
 assert.equal(reconciliation.payload.status,'reconciled');assert.equal(reconciliation.payload.new_fills,1);
 const ledger=await readLedger(db);assert.equal(ledger.portfolio.holdings.SPY.quantity,1);assert.equal(ledger.portfolio.cash_nanos,'99500000000000');
 return {f,opening,protocol,reconciliation,decision,checks:await checks(db,releaseRevision,'rollout-check')};
}

export async function reviewed(db){
 const completed=await completedPilot(db);const intent=(await records(db)).find(e=>e.kind==='order_intent');
 const input={pilot_intent_id:intent.id,reconciliation_id:completed.reconciliation.id};
 const candidate=await rolloutReviewCandidate(db,input);const review_ids=[];
 for(const author of ['synthetic-outcome-review-a','synthetic-outcome-review-b']){
  const review=await append(db,{id:author,kind:'verification',actor:author,payload:{check:'pilot_outcome_review',outcome:'passed',revision:releaseRevision,pilot_binding:candidate.binding,author,summary:'Observed only the complete simulated pilot fixture; no production claim'}});review_ids.push(review.id);
 }
 return {...completed,input,candidate,payload:{...input,pilot_binding:candidate.binding,review_ids,checks:completed.checks,revision:releaseRevision,status:'approved',protocol_version:1,mandate_version:1,authorization_reference:ROLLOUT_AUTHORIZATION,general_trading_enabled:false,author:actor,limits:ROLLOUT_LIMITS,session_date:marketDate(now()),valid_until:new Date(Date.now()+60000).toISOString()}};
}

export {rolloutEnv,actor,records};
