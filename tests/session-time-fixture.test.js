import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSyntheticSession} from './session-time-fixture.js';
import {marketDate} from '../lib/action-ledger.js';

test('synthetic next sessions remain after predecessor UTC expiry and inside one New York session across midnight, DST and weekends',()=>{
 const cases=[
  ['2026-10-29T02:01:00Z','2026-10-30T16:00:00.000Z'],
  ['2026-10-29T23:59:59Z','2026-10-30T16:00:00.000Z'],
  ['2026-10-30T20:01:00Z','2026-11-02T16:00:00.000Z'],
  ['2026-11-01T05:59:59Z','2026-11-02T16:00:00.000Z'],
  ['2026-03-08T06:59:59Z','2026-03-09T16:00:00.000Z'],
  ['2026-12-31T23:59:59Z','2027-01-01T16:00:00.000Z'],
 ];
 for(const [expiry,expected] of cases){
  const instant=nextSyntheticSession(expiry),date=new Date(instant).toISOString(),session=marketDate(date);
  assert.equal(date,expected);assert.ok(Date.parse(expiry)<Date.parse(session+'T00:00:00Z'));
  assert.equal(marketDate(new Date(instant+3600000).toISOString()),session);
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',hourCycle:'h23'}).format(new Date(instant)));assert.ok(hour===11||hour===12);
 }
 assert.throws(()=>nextSyntheticSession('invalid'));
});
