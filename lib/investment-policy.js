/** Source-controlled permitted universe. Changes require a recorded mandate revision
 * and independent release review; no caller or environment override exists.
 * A configuration entry alone never bypasses broker eligibility or source coverage.
 */
const instruments = Object.freeze([
 Object.freeze({symbol:'AAPL',instrument_type:'stock',max_weight:.10}),
 Object.freeze({symbol:'MSFT',instrument_type:'stock',max_weight:.10}),
 Object.freeze({symbol:'SPY',instrument_type:'diversified_equity_etf',max_weight:.25}),
]);
export const INVESTMENT_POLICY = Object.freeze({
 configuration_version:1,
 mandate_version:1,
 instruments,
 limits:Object.freeze({initial_cash_cents:10_000_000,stock_weight:.10,etf_weight:.25,gross_weight:.90,cash_weight:.10,order_weight:.05}),
 expansion_requirement:'Recorded mandate amendment, concrete instrument approval, current broker eligibility and independent release review before trading.',
});
export const PERMITTED_SYMBOLS = Object.freeze(instruments.map(instrument=>instrument.symbol));
export const PERMITTED_SYMBOL_QUERY = PERMITTED_SYMBOLS.join(',');
export const permittedInstrument = symbol => instruments.find(instrument=>instrument.symbol===symbol) ?? null;
