import {activePolicyVersion,symbolsForVersion,policyDigest,policyEvents} from './investment-policy.js';
import { coverageState } from './action-settlement.js';
import { getEvent, latest, AppError, isoNow, acquire, renew, release, appendLeased } from './store.js';
import { readLedger, createOpeningPayload } from './reconciliation.js';
import { moneyToCents, MANDATE } from './finance.js';

export function fresh(time, now = isoNow(), seconds = 120) {
  const age = Date.parse(now) - Date.parse(time);
  return typeof time === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(time) && Number.isFinite(age) && age >= -5000 && age <= seconds * 1000;
}
const block = message => { throw new AppError(message, 423); };
/** Revalidate linked persisted records at use time; decision text never overrides a guard. */
export async function executionDecision(db, decisionId, now = isoNow()) {
  const d = await getEvent(db, decisionId); const p = d?.payload;
  if (d?.kind !== 'decision' || !['buy', 'sell'].includes(p.action)) block('Executable decision required.');
  const [r, c] = await Promise.all([getEvent(db, p.research_id), getEvent(db, p.challenge_id)]);
  if (r?.kind !== 'research' || c?.kind !== 'challenge' || c.payload.research_id !== r.id || r.payload.role !== 'researcher' || c.payload.role !== 'challenger' || p.role !== 'portfolio_manager') block('Decision requires linked independent research and challenge.');
  const authors = [r.payload.author, c.payload.author, p.author];
  if (authors.some(a => typeof a !== 'string' || !a.trim()) || new Set(authors).size !== 3) block('Research, challenger and manager authors must be distinct.');
  for (const record of [r, c, d]) {
    if (!Number.isFinite(Date.parse(record.created_at)) || Date.parse(record.created_at) > Date.parse(now)) block('Decision chain is future-dated.');
    if (!Array.isArray(record.payload.snapshot_ids) || !record.payload.snapshot_ids.length) block('Decision chain needs stored snapshots.');
    for (const id of record.payload.snapshot_ids) { const s = await getEvent(db, id); if (s?.kind !== 'snapshot' || s.seq > record.seq) block('Decision snapshot was unavailable when authored.'); }
  }
  if (r.seq >= c.seq || c.seq >= d.seq || typeof p.challenge_response !== 'string' || !p.challenge_response.trim()) block('Invalid decision chain order or missing response.');
  const version=await activePolicyVersion(db,now);
  if(version===2){const amendment=(await policyEvents(db,now)).at(-1);if(p.configuration_version!==2||p.configuration_hash!==await policyDigest(2)||p.amendment_id!==amendment.id||d.seq<=amendment.seq)block('Decision predates or mismatches admission');}
  else if(p.configuration_version!==undefined&&p.configuration_version!==1)block('Decision candidate version is not admitted');
  if (!symbolsForVersion(version).includes(p.symbol) || !Number.isSafeInteger(p.limit_price_cents) || p.limit_price_cents <= 0) block('Decision requires an approved symbol and explicit cent-denominated limit price.');
  const size = moneyToCents(p.size);
  if (size <= 0 || size > MANDATE.initial_cash_cents) block('Invalid decision size.');
  if (typeof p.valid_until !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(p.valid_until) || !Number.isFinite(Date.parse(p.valid_until)) || Date.parse(p.valid_until) <= Date.parse(now)) block('Decision expiry requires a future timestamp with timezone.');
  const revision = await db.prepare("SELECT id FROM events WHERE kind='revision' AND json_extract(payload,'$.supersedes') IN (?,?,?) LIMIT 1").bind(r.id, c.id, d.id).first();
  if (revision) block('Decision chain has been revised; submit a newly linked decision.');
  return d;
}


export const RELEASE_CHECKS=['private_hosting','persistent_readback','unattended_auth','nonzero_fill_settlement','partial_fill_retry','corporate_action_reconciliation','prospective_inception','runtime_asset_metadata'];
async function validateReleaseAttestation(db,kind,record,revision) {
 if(typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision))block('Exact release revision is required.');
 if(!record||record.payload.status!=='approved'||record.payload.mandate_version!==1||record.payload.revision!==revision||!Array.isArray(record.payload.evidence_ids)||!record.payload.evidence_ids.length)block(`Missing revision-bound ${kind} evidence.`);
 for(const id of record.payload.evidence_ids){const e=await getEvent(db,id);if(e?.kind!=='verification'||e.seq>=record.seq||e.payload.outcome!=='passed'||typeof e.payload.summary!=='string'||!e.payload.summary.trim())block(`Invalid ${kind} supporting evidence.`);}
 if(kind==='launch_approval'&&(typeof record.payload.authorization_reference!=='string'||!record.payload.authorization_reference.trim()))block('Launch approval requires the actual user authorization reference.');
 if(kind==='release_verification')for(const check of RELEASE_CHECKS){const id=record.payload.checks?.[check];const e=id?await getEvent(db,id):null;if(e?.kind!=='verification'||e.seq>=record.seq||e.payload.outcome!=='passed'||e.payload.check!==check||e.payload.revision!==revision)block('Missing measured release check: '+check);}
 return record;
}
export async function releaseEvidence(db,revision,now){
 const records={};for(const kind of ['launch_approval','release_verification'])records[kind]=await validateReleaseAttestation(db,kind,await latest(db,kind,now),revision);return records;
}
/** Records attestations to actual completed checks; never grants execution or invents approval. */
export async function stageReleaseAttestation(db,env,{idempotency_key,kind,payload},actor){
 if(!['launch_approval','release_verification'].includes(kind)||!payload||JSON.stringify(payload).length>50000)throw new AppError('Invalid release attestation.');
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  await validateReleaseAttestation(db,kind,{payload,seq:Number.MAX_SAFE_INTEGER},env.RELEASE_REVISION);
  await renew(db,'execution',token);return await appendLeased(db,{id:idempotency_key,kind,payload,actor},'execution',token);
 }finally{await release(db,'execution',token);}
}

/** Read-only launch evidence check. It cannot create an opening or enable execution. */
export async function activationPreflight(db, snapshotId, now = isoNow(), revision) {
  const problems = []; let proposed_opening = null;
  const opening = await latest(db, 'experiment_opened');
  if (opening) problems.push('An official opening already exists; inception cannot be reset.');
  const snapshot = await getEvent(db, snapshotId);
  try { proposed_opening = createOpeningPayload(snapshot, now); } catch (error) { problems.push(error.message); }
  const reconciliation = await latest(db, 'reconciliation');
  if (!reconciliation || !fresh(reconciliation.created_at, now) || reconciliation.payload.ledger_status !== 'not_started' || reconciliation.payload.problems?.some(p => p.code !== 'not_started') || !Array.isArray(reconciliation.payload.problems)) problems.push('Fresh flat-account reconciliation with no unresolved issues is required.');
  if (snapshot && reconciliation && reconciliation.seq <= snapshot.seq) problems.push('Reconciliation must follow the opening snapshot.');
  // These internal attestations are never accepted through submit_record.
  try { await releaseEvidence(db, revision, now); } catch (error) { problems.push(error.message); }
  const coverage=await coverageState(db,now);if(!coverage.ok)problems.push(...coverage.problems);
  const unresolved=await db.prepare("SELECT id FROM events WHERE kind='order_intent' LIMIT 1").first();if(unresolved)problems.push('An unstarted experiment cannot have prior order intents.');
  return { ready: false, prerequisites_complete:problems.length===0, trading_permitted: false, gate:'hard_disabled', problems, proposed_opening, snapshot_id: snapshotId, reconciliation_id: reconciliation?.id ?? null };
}

/** Must be called under the execution lease, and again immediately before the intent. */
export async function executionPrerequisites(db, decisionId, now = isoNow(), revision) {
  const head = await db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').first();
  const decision = await executionDecision(db, decisionId, now);
  const ledger = await readLedger(db, now);
  if (ledger.status !== 'ready' || !ledger.portfolio || !ledger.benchmark) block('A valid simultaneous official opening is required.');
  const release = await releaseEvidence(db, revision, now);
  const opening=await latest(db,'experiment_opened',now);
  const storedControl=await latest(db,'experiment_control',now);
  const control=storedControl || (opening?.payload.control?{...opening,payload:opening.payload.control}:null);
  if (!control || control.payload.status !== 'active' || control.payload.started_at !== ledger.started_at) block('Experiment has no verified active control record.');
  if(control.payload.release_revision!==revision || control.payload.approval_id!==release.launch_approval.id || control.payload.verification_id!==release.release_verification.id || control.seq<=Math.max(release.launch_approval.seq,release.release_verification.seq)) block('Active control is not bound to the approved release.');
  const coverage=await coverageState(db,now);if(!coverage.ok)block(coverage.problems.join('; '));
  const reconciliation = await latest(db, 'reconciliation', now);
  if (!reconciliation || !fresh(reconciliation.created_at, now) || reconciliation.payload.status !== 'reconciled' || reconciliation.payload.ledger_status !== 'ready' || !Array.isArray(reconciliation.payload.problems) || reconciliation.payload.problems.length) block('Fresh successful reconciliation is required.');
  const later = await db.prepare("SELECT id FROM events WHERE seq>? AND kind IN ('ledger_fill','broker_activity','broker_order','order_intent','experiment_opened','corporate_action','corporate_action_page','corporate_action_fetch_failed','action_confirmed','action_entitlement','action_payment','action_split','action_source','action_coverage','refresh_failed') LIMIT 1").bind(reconciliation.seq).first();
  if (later) block('New accounting or failed-source evidence requires reconciliation.');
  if (control.seq < (await latest(db, 'experiment_opened', now)).seq) block('Active control predates inception.');
  const after = await db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').first();
  if(after.seq!==head.seq) block('Journal changed during prerequisite validation; retry after reconciliation.');
  return { decision, ledger, reconciliation, control, journal_seq: head.seq };
}
