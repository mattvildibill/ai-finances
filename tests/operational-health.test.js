import test from 'node:test';
import assert from 'node:assert/strict';
import {operationalHealth} from '../lib/service.js';
const adoption={seq:26,id:'blue-adoption-verification-2026-10-27',kind:'verification',payload:{verified_components:['native_plugin_read_refresh_readback','independent_research_and_challenge_outputs']}};
const config={seq:36,id:'observed-config',kind:'verification',payload:{operational_status:{schedule_enabled:true,timezone:'America/Los_Angeles',schedule:'BEGIN:VEVENT\nDTSTART;TZID=America/Los_Angeles:20261027T131500\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=13;BYMINUTE=15;BYSECOND=0\nEND:VEVENT',observed_at:'2026-10-27T06:12:14Z',schedule_modification:'denied'}}};
test('observed enabled configuration does not certify unattended execution or modification access',()=>{
 const health=operationalHealth([config,adoption]);
 assert.match(health.blue_connection,/adoption verified/);
 assert.match(health.schedule,/Enabled: weekdays at 1:15 p.m./);
 assert.match(health.schedule,/observed 2026/);
 assert.match(health.scheduler,/execution unverified.*access denied/);
 assert.equal(health.operations_evidence_id,'observed-config');
});
test('historical replay without evidence does not invent adoption or schedule status',()=>{
 const health=operationalHealth([{seq:2,id:'blue-cloud-verification-legacy',kind:'verification',payload:{}}]);
 assert.match(health.blue_connection,/unavailable/);
 assert.match(health.schedule,/Configuration not observed/);
 assert.match(health.scheduler,/unverified/);
});
test('latest configuration observation supersedes older status without altering historical records',()=>{
 const before=JSON.stringify(config);
 const newer=structuredClone(config);newer.seq=40;newer.id='disabled-config';newer.payload.operational_status.schedule_enabled=false;
 assert.match(operationalHealth([newer,config,adoption]).schedule,/^Disabled:/);
 assert.equal(JSON.stringify(config),before);
});

test('different recurrence is displayed verbatim rather than called every weekday',()=>{
 const monthly=structuredClone(config);monthly.payload.operational_status.schedule=monthly.payload.operational_status.schedule.replace('FREQ=WEEKLY','FREQ=MONTHLY');
 const label=operationalHealth([monthly]).schedule;
 assert.match(label,/FREQ=MONTHLY/);assert.doesNotMatch(label,/weekdays at/);
});
