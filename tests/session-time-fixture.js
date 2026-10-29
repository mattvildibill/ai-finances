/**
 * Pick a synthetic regular-session instant after the predecessor's UTC date.
 * Adding 24h to an arbitrary wall clock can put the New York session date
 * before the predecessor's UTC expiry (and can put +1h close on another day).
 * 16:00 UTC is inside New York regular hours in both EST and EDT. This is an
 * isolated broker-calendar fixture, not a real holiday/trading-date resolver.
 */
export function nextSyntheticSession(after) {
 const time=Date.parse(after);
 if(!Number.isFinite(time))throw new Error('Synthetic predecessor must have a valid expiry.');
 const next=new Date(time);next.setUTCDate(next.getUTCDate()+1);next.setUTCHours(16,0,0,0);
 while(next.getUTCDay()===0||next.getUTCDay()===6)next.setUTCDate(next.getUTCDate()+1);
 return next.getTime();
}
