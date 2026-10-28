import {canonical} from './store.js';
import {decimalUnits} from './precision.js';
const BASE='https://paper-api.alpaca.markets/v2/account/activities';
const stamp=s=>typeof s==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s));
const day=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
/** Pure receipt-time interpretation. Raw evidence is the source; no balance adjustments are accepted. */
export function cashActivityAccounting(all,opening,asOf){
 const events=all.filter(e=>!asOf||e.created_at<=asOf),problems=[],fees=[],funding=[];
 const issue=(code,message,details={})=>problems.push({code,message,...details});
 const knownFills=new Set(events.filter(e=>e.kind==='broker_activity').map(e=>canonical(e.payload.activity)));
 const scans=events.filter(e=>e.kind==='cash_activity_scan'),pages=events.filter(e=>e.kind==='cash_activity_page');
 const complete=new Map(),inventory=new Map();
 for(const scan of scans){
  const results=events.filter(e=>e.kind==='cash_activity_result'&&e.payload.scan_id===scan.id),result=results.at(-1),p=scan.payload;
  try{
   if(results.length!==1||result.payload.complete!==true)throw Error('incomplete');
   const selected=pages.filter(e=>e.payload.scan_id===scan.id).sort((a,b)=>a.payload.page-b.payload.page),r=result.payload;
   if(p.operation!=='collect_cash_activities'||p.source!==BASE||!stamp(p.until)||p.until!==r.until||Date.parse(p.until)>Date.parse(scan.created_at)||!selected.length||selected.length>20||canonical(r.page_ids)!==canonical(selected.map(e=>e.id)))throw Error('binding');
   const ids=new Set();let count=0,nonfills=0,cursor;
   for(let i=0;i<selected.length;i++){
    const page=selected[i],q=page.payload,u=new URL(q.source_url),expected=new URLSearchParams({direction:'asc',page_size:'100',until:p.until});if(cursor)expected.set('page_token',cursor);
    if(q.page!==i||u.origin+u.pathname!==BASE||q.source_url!==BASE+'?'+expected||page.seq<=scan.seq||page.seq>=result.seq||!stamp(q.retrieval_started_at)||!stamp(q.observed_at)||Date.parse(q.retrieval_started_at)<Date.parse(scan.created_at)||Date.parse(q.observed_at)<Date.parse(q.retrieval_started_at)||Date.parse(q.observed_at)>Date.parse(page.created_at)||!Array.isArray(q.activities)||q.activities.length>100||(i<selected.length-1?q.activities.length!==100:q.activities.length>=100))throw Error('page');
    for(const row of q.activities){if(!row||typeof row.id!=='string'||!row.id||row.id.length>512||ids.has(row.id))throw Error('identity');ids.add(row.id);count++;if(row.activity_type!=='FILL')nonfills++;}
    cursor=q.activities.at(-1)?.id;
   }
   if(count!==r.activity_count||nonfills!==r.non_fill_count)throw Error('count');
   for(const id of inventory.keys())if(!ids.has(id))issue('cash_activity_missing','Previously acquired activity is absent from a later complete scan.',{scan_id:scan.id,broker_activity_id:id});
   for(const id of ids)inventory.set(id,true);
   for(const page of selected)complete.set(page.id,result);
  }catch{
   // An interrupted acquisition may be retried in a new scan; its raw suspicious evidence is never discarded.
   if(scan===scans.at(-1)||result?.payload.complete===true)issue('cash_activity_incomplete','Account activity acquisition is incomplete or has invalid receipt bindings.',{scan_id:scan.id});
  }
 }
 const groups=new Map();
 for(const page of pages){
  if(!Array.isArray(page.payload.activities)){issue('cash_activity_invalid','Malformed account activity page requires review.',{page_id:page.id});continue;}
  for(const row of page.payload.activities){
   if(!row||typeof row.id!=='string'||!row.id){issue('cash_activity_unresolved','Missing account activity identity.',{page_id:page.id});continue;}
   const entries=groups.get(row.id)||[];entries.push({row,page,result:complete.get(page.id)});groups.set(row.id,entries);
  }
 }
 for(const [id,entries] of groups){
  const {row,page}=entries[0],eligible=entries.find(e=>e.result&&canonical(e.row)===canonical(row)),versions=new Set(entries.map(e=>canonical(e.row)));
  if(versions.size!==1)issue('cash_activity_changed','Contradictory account activity versions require explicit review; no automatic correction.',{broker_activity_id:id});
  if(row.activity_type==='FILL'){
   if(!['fill','partial_fill'].includes(row.type)||entries.some(e=>!knownFills.has(canonical(e.row))))issue('cash_activity_unresolved','Collected fill differs from retained broker fill evidence.',{broker_activity_id:id});continue;
  }
  try{
   if(!eligible||!opening||opening.payload.accounting_policy!=='usd-nano-v1'||!stamp(row.created_at)||!day(row.date)||row.date>row.created_at.slice(0,10)||Date.parse(row.created_at)>Date.parse(eligible.result.payload.until)||Date.parse(row.created_at)>Date.parse(eligible.page.payload.observed_at)||row.status!=='executed'||row.currency!=='USD'||typeof row.description!=='string')throw Error('Unsupported or incomplete account activity evidence');
   const allowed=['id','activity_type','date','created_at','net_amount','description','status','currency',...(row.activity_type==='FEE'?['activity_sub_type']:[])];
   if(Object.keys(row).some(k=>!allowed.includes(k)))throw Error('Unreviewed activity fields');
   const binding={id,raw_event_id:eligible.page.id,first_seen_raw_event_id:page.id,completion_id:eligible.result.id,observed_at:eligible.result.created_at,broker_created_at:row.created_at,economic_date:row.date,amount_text:row.net_amount};
   if(row.activity_type==='FEE'&&row.activity_sub_type==='CAT'){
    if(typeof row.net_amount!=='string'||!/^-[0-9]+(?:\.[0-9]+)?$/.test(row.net_amount)||Date.parse(row.created_at)<Date.parse(opening.payload.started_at)||row.date<opening.payload.started_at.slice(0,10))throw Error('CAT fee is not a post-inception debit');
    const amount=decimalUnits(row.net_amount.slice(1),9,'CAT fee');if(amount<=0n)throw Error('CAT fee must be a debit');
    fees.push({...binding,amount_nanos:amount.toString(),ordering_time:row.created_at,time_basis:'Broker created_at orders replay; economic date retained; cash-debit instant not inferred.',policy:'executed-usd-cat-v1'});
   }else if(row.activity_type==='JNLC'){
    if(typeof row.net_amount!=='string'||decimalUnits(row.net_amount,9)!==BigInt(opening.payload.initial_cash_cents)*10000000n||opening.payload.initial_cash_cents!==10000000||Date.parse(row.created_at)>=Date.parse(opening.payload.started_at)||row.date>opening.payload.started_at.slice(0,10))throw Error('Journal cash is not the original pre-inception funding');
    funding.push({...binding,opening_id:opening.id,opening_digest:opening.digest,amount_nanos:'100000000000000',treatment:'Already included in original opening; no additional cash or income.'});
   }else throw Error('Unsupported account activity type');
  }catch(error){issue('cash_activity_unresolved',error.message,{page_id:page.id,broker_activity_id:id});}
 }
 if(funding.length>1)issue('cash_activity_unresolved','Multiple funding identities cannot represent the single original opening.');
 return {problems,fees,funding};
}
