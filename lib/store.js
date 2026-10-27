export class AppError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export const isoNow=()=>new Date().toISOString();
export function canonical(x){if(x===null||typeof x!=='object')return JSON.stringify(x);if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';}
export async function hash(x){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(x))))).map(x=>x.toString(16).padStart(2,'0')).join('');}
export function parseRow(r){return r?{...r,payload:JSON.parse(r.payload)}:null;}
export async function getEvent(db,id){return parseRow(await db.prepare('SELECT * FROM events WHERE id=?').bind(id).first());}
export async function append(db,{id,kind,payload,actor},now=isoNow()){
 if(!/^[A-Za-z0-9:_-]{8,160}$/.test(id||''))throw new AppError('Use an idempotency key of 8–160 letters, numbers, colons, underscores or hyphens.');
 const digest=await hash({kind,payload});
 await db.prepare('INSERT INTO events(id,kind,created_at,actor,payload,digest) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id,kind,now,actor,JSON.stringify(payload),digest).run();
 const existing=await getEvent(db,id);
 if(existing.digest!==digest)throw new AppError('Idempotency key already used for different content.',409);
 return existing;
}
export async function listEvents(db,asOf,limit=500){const r=await db.prepare('SELECT * FROM events WHERE created_at<=? ORDER BY seq DESC LIMIT ?').bind(asOf,limit).all();return r.results.map(parseRow).reverse();}
export async function latest(db,kind,asOf=isoNow()){return parseRow(await db.prepare('SELECT * FROM events WHERE kind=? AND created_at<=? ORDER BY seq DESC LIMIT 1').bind(kind,asOf).first());}
export async function acquire(db,name,token,now=isoNow()){
 const expires=new Date(new Date(now).getTime()+120000).toISOString();
 await db.prepare('INSERT INTO locks(name,token,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE locks.expires_at<?').bind(name,token,expires,now).run();
 const lock=await db.prepare('SELECT token FROM locks WHERE name=?').bind(name).first();
 if(lock?.token!==token)throw new AppError('Update already in progress. Retry with the same idempotency key.',409);
}
export async function release(db,name,token){await db.prepare('DELETE FROM locks WHERE name=? AND token=?').bind(name,token).run();}
/** An expired lease cannot be resurrected, even when nobody has claimed it yet. */
export async function renew(db,name,token,now=isoNow()) {
 const expires=new Date(Date.parse(now)+120000).toISOString();
 const result=await db.prepare('UPDATE locks SET expires_at=? WHERE name=? AND token=? AND expires_at>? AND expires_at>strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') AND ?>strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')').bind(expires,name,token,now,expires).run();
 if(result.meta?.changes!==1)throw new AppError('Execution lease was lost or expired; reconcile before retry.',409);
}
/** Atomic fencing: insertion succeeds only while this exact lease is still valid. */
export async function appendLeased(db,{id,kind,payload,actor},name,token,now=isoNow(),expectedSeq=null) {
 const deadline=kind==='experiment_opened'&&payload.control?.status==='validation_pending'?payload.control.submission_valid_until:kind==='order_intent'&&payload.validation_protocol_id?payload.submission_valid_until:null;
 if(deadline!==null&&(typeof deadline!=='string'||!Number.isFinite(Date.parse(deadline))))throw new AppError('Validation receipt requires an exact authorization deadline.',423);
 const digest=await hash({kind,payload});
 if(!/^[A-Za-z0-9:_-]{8,160}$/.test(id||''))throw new AppError('Invalid record id.');
 await db.prepare('INSERT INTO events(id,kind,created_at,actor,payload,digest) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM locks WHERE name=? AND token=? AND expires_at>? AND expires_at>strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')) AND (? IS NULL OR (SELECT COALESCE(MAX(seq),0) FROM events)=?) AND (? != \'experiment_opened\' OR ABS((julianday(\'now\')-julianday(?))*86400000)<=5000) AND (? IS NULL OR julianday(\'now\')<julianday(?)) ON CONFLICT(id) DO NOTHING').bind(id,kind,now,actor,JSON.stringify(payload),digest,name,token,now,expectedSeq,expectedSeq,kind,now,deadline,deadline).run();
 const existing=await getEvent(db,id);
 if(!existing)throw new AppError('Execution lease was lost or journal changed before durable receipt.',409);
 if(existing.digest!==digest)throw new AppError('Idempotency key already used for different content.',409);
 return existing;
}
