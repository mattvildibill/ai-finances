/** Exact unsigned decimal arithmetic; no binary floating point or implicit rounding. */
export function decimalUnits(value, scale, label = 'Decimal') {
  const text = String(value);
  if (text.length > 80 || !/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`${label} must be an unsigned decimal`);
  const [whole, fraction = ''] = text.split('.');
  if (fraction.slice(scale).replace(/0/g, '')) throw new Error(`${label} has unsupported precision`);
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.slice(0, scale).padEnd(scale, '0') || '0');
}
export function exactWholeFillCents(quantity, price) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Fill quantity must be a positive safe whole share count');
  const priceUnits = decimalUnits(price, 9, 'Fill price');
  if (priceUnits <= 0n) throw new Error('Fill price must be positive');
  const cashUnits = BigInt(quantity) * priceUnits;
  if (cashUnits % 10000000n) throw new Error('Unsupported fractional-cent fill cash amount requires explicit broker normalization; no rounding applied');
  const cents = cashUnits / 10000000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Fill cash amount exceeds safe integer range');
  return Number(cents);
}

export const USD_NANOS_PER_CENT = 10000000n;
export function usdNanos(value, label = 'USD') {
  const text = String(value);
  const negative = text.startsWith('-');
  const units = decimalUnits(negative ? text.slice(1) : text, 9, label);
  return negative ? -units : units;
}
/** Conservative integer-cent projection; exact nano fields remain authoritative. */
export function nanosToCents(value, {ceil = false} = {}) {
  const n = BigInt(value); let cents = n / USD_NANOS_PER_CENT;
  if (n % USD_NANOS_PER_CENT && (ceil ? n > 0n : n < 0n)) cents += ceil ? 1n : -1n;
  const result = Number(cents);
  if (!Number.isSafeInteger(result)) throw new Error('USD projection exceeds safe integer range');
  return result;
}
export function wholeFillNanos(quantity, price) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Fill quantity must be a positive safe whole share count');
  const units = decimalUnits(price, 9, 'Fill price');
  if (units <= 0n) throw new Error('Fill price must be positive');
  return BigInt(quantity) * units;
}
