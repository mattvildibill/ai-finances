import test from 'node:test';
import assert from 'node:assert/strict';
import {temporaryDatabase} from './helpers.js';
import {acquire,appendLeased,getEvent} from '../lib/store.js';

test('SQL clock rejects an expired amendment even with an earlier caller timestamp and valid lease',async t=>{
 const {db}=temporaryDatabase(t),token='admission-deadline-token';await acquire(db,'execution',token);
 const earlier=new Date(Date.now()-10000).toISOString();
 await assert.rejects(appendLeased(db,{id:'expired-admission',kind:'mandate_amendment',actor:'fixture',payload:{submission_valid_until:new Date(Date.now()-1000).toISOString()}},'execution',token,earlier));
 assert.equal(await getEvent(db,'expired-admission'),null);
 await assert.rejects(appendLeased(db,{id:'missing-admission-deadline',kind:'mandate_amendment',actor:'fixture',payload:{}},'execution',token));
 assert.equal(await getEvent(db,'missing-admission-deadline'),null);
});
