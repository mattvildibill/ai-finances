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
