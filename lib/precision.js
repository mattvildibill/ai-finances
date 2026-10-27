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
