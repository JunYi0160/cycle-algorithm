import {readFileSync, writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createStrategy, LongOnlyAccount} from '../strategies.mjs';

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const save = (file, data) => writeFileSync(new URL(file, import.meta.url), JSON.stringify(data, null, 2));
const protocol = read('./protocol.json'), prices = read('./prices.json'), audit = read('./data-audit.json');
const hash = file => createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex');
if (hash('../candidates.json') !== audit.candidate_spec_sha256 || hash('./protocol.json') !== audit.protocol_sha256 || hash('./prices.json') !== audit.normalized_prices_sha256) throw new Error('Prepared data or frozen spec changed');

const SINGLE = ['B-CASH', 'B-STOCK', 'B-50', 'P-R1', 'P-R2', 'P-MIX', 'G-05', 'G-10', 'G-20', 'M-SINGLE'];
const MULTI = ['B-EQUAL-HOLD', 'B-EQUAL-MIX', 'E-025', 'E-1', 'E-4', 'M-MULTI'];
const suites = [...protocol.single_assets.map(t => ({name: t, tickers: [t], ids: SINGLE})),
  ...Object.entries(protocol.baskets).map(([name, tickers]) => ({name, tickers, ids: MULTI}))];
const sum = a => a.reduce((x, y) => x + y, 0);
const dailyLines = ['suite,strategy,date,equity,cash,stock_weight,fees,turnover'];
const all = [], cohortResults = [], exposureControls = [];
let count = 0, maxIdentityResidual = 0, maxGridAccountingResidual = 0, invariantSnapshots = 0;

function aligned(tickers, start, end) {
  const maps = tickers.map(t => new Map(prices[t].map(row => [row.date, row])));
  return prices[tickers[0]].filter(r => r.date >= start && r.date <= end && maps.every(m => m.has(r.date)))
    .map(r => ({date: r.date, open: maps.map(m => m.get(r.date).open), close: maps.map(m => m.get(r.date).close)}));
}
function fixedStrategy(weight, row, cost) {
  const account = new LongOnlyAccount(protocol.initial_capital, row.open.length, cost);
  let initialized = false;
  return {onPrices(pricesNow, rebalance) {
    let trade = {fee: 0, turnover: 0};
    if (!initialized || rebalance) trade = account.rebalance([weight], pricesNow);
    initialized = true;
    return {...account.snapshot(pricesNow), step_fee: trade.fee, step_turnover: trade.turnover, diagnostics: {}};
  }};
}
function run(suite, id, rows, frequency = 'monthly', cost = .0005, tag = 'primary', saveDaily = false, fixedWeight = null) {
  const initial = protocol.initial_capital;
  if (!rows.length) throw new Error('empty aligned data');
  const strategy = fixedWeight === null ? createStrategy(id, {capital: initial, entryPrices: rows[0].open, cost}) : fixedStrategy(fixedWeight, rows[0], cost);
  const years = (Date.parse(rows.at(-1).date) - Date.parse(rows[0].date)) / 86400000 / 365.25;
  let peak = initial, maxDD = 0, previous = initial, weightSum = 0, equitySum = 0, returns = [], snapshot;
  let zeroStockDays = 0, tradeDays = 0, feeDays = 0;
  const annual = {}, closes = [], trace = [];
  let priorYear = null, yearBase = initial, yearDD = 0, yearPeak = initial;
  function validate(s, quote) {
    invariantSnapshots++;
    const scale = Math.max(initial, s.equity);
    if (!Number.isFinite(s.equity) || s.equity <= 0 || s.cash < -1e-9 * scale || s.units.some(q => q < -1e-10)) throw new Error('invalid account');
    if (Math.abs(s.equity - s.cash - sum(s.units.map((q, i) => q * quote[i]))) > 1e-8 * scale) throw new Error('self financing failure');
    if (sum(s.stock_weights) > 1 + 1e-9) throw new Error('unfunded leverage');
    const d = s.diagnostics;
    if (d.identity_residual !== undefined) {
      maxIdentityResidual = Math.max(maxIdentityResidual, Math.abs(d.identity_residual));
      if (Math.abs(d.identity_residual) > 1e-8) throw new Error('identity failed');
    }
    if (d.accounting_residual !== undefined) {
      maxGridAccountingResidual = Math.max(maxGridAccountingResidual, Math.abs(d.accounting_residual));
      if (Math.abs(d.accounting_residual) > 1e-8 * scale || s.equity + 1e-8 * scale < d.capital_floor) throw new Error('grid identity/floor failed');
    }
    if (d.competitive_lower_bound !== undefined && s.equity + 1e-8 * scale < d.competitive_lower_bound) throw new Error('mixture guarantee failed');
  }
  rows.forEach((row, i) => {
    const year = row.date.slice(0, 4);
    if (year !== priorYear) {
      if (priorYear) annual[priorYear] = {return: previous / yearBase - 1, max_drawdown: yearDD};
      yearBase = previous; yearPeak = previous; yearDD = 0; priorYear = year;
    }
    const rebalance = i === 0 || frequency === 'daily' || row.date.slice(0, 7) !== rows[i - 1].date.slice(0, 7);
    const atOpen = strategy.onPrices(row.open, rebalance);
    validate(atOpen, row.open);
    if (atOpen.step_turnover > 1e-8) tradeDays++;
    if (atOpen.step_fee > 1e-8) feeDays++;
    snapshot = strategy.onPrices(row.close, false);
    validate(snapshot, row.close);
    peak = Math.max(peak, snapshot.equity); maxDD = Math.min(maxDD, snapshot.equity / peak - 1);
    yearPeak = Math.max(yearPeak, snapshot.equity); yearDD = Math.min(yearDD, snapshot.equity / yearPeak - 1);
    const weight = sum(snapshot.stock_weights);
    weightSum += weight; equitySum += snapshot.equity;
    if (weight < 1e-10) zeroStockDays++;
    returns.push(Math.log(snapshot.equity / previous)); previous = snapshot.equity;
    closes.push(snapshot.equity);
    if (saveDaily) dailyLines.push([suite.name, id, row.date, snapshot.equity, snapshot.cash, weight, snapshot.fees, snapshot.turnover].join(','));
    // A compact full daily trace used only for the prefix-causality verification.
    if (tag === 'causality') trace.push([snapshot.equity, snapshot.cash, ...snapshot.units]);
  });
  annual[priorYear] = {return: previous / yearBase - 1, max_drawdown: yearDD};
  const mean = sum(returns) / returns.length;
  const variance = sum(returns.map(r => (r - mean) ** 2)) / Math.max(1, returns.length - 1);
  const diagnostics = structuredClone(snapshot.diagnostics);
  if (diagnostics.cells) delete diagnostics.cells;
  if (diagnostics.fills) delete diagnostics.fills;
  const result = {suite: suite.name, tickers: suite.tickers, strategy: id, tag, frequency, one_way_cost: cost,
    start: rows[0].date, end: rows.at(-1).date, trading_days: rows.length, years,
    terminal_equity: snapshot.equity, net_return: snapshot.equity / initial - 1,
    cagr: (snapshot.equity / initial) ** (1 / years) - 1, max_drawdown: maxDD,
    annualized_daily_log_volatility: Math.sqrt(variance * 252), average_stock_weight: weightSum / rows.length,
    terminal_stock_weight: sum(snapshot.stock_weights), zero_stock_day_fraction: zeroStockDays / rows.length,
    fees_paid: snapshot.fees, gross_turnover: snapshot.turnover,
    gross_turnover_per_year_over_average_equity: snapshot.turnover / (equitySum / rows.length) / years,
    trade_days: tradeDays, fee_days: feeDays, annual_returns: annual, diagnostics};
  if (fixedWeight !== null) result.ex_post_constant_stock_weight = fixedWeight;
  count++;
  return {result, trace, closes};
}

for (const suite of suites) {
  const rows = aligned(suite.tickers, protocol.primary_start, protocol.common_end);
  for (const id of suite.ids) {
    const main = run(suite, id, rows, 'monthly', .0005, 'primary', true).result;
    all.push(main);
    all.push(run(suite, id, rows, 'daily', .0005, 'daily_sensitivity').result);
    all.push(run(suite, id, rows, 'monthly', .002, 'cost_sensitivity').result);
    if (id.startsWith('P-')) exposureControls.push(run(suite, `X-${id}`, rows, 'monthly', .0005, 'ex_post_exposure_diagnostic', false, main.average_stock_weight).result);
  }
  console.log(`Primary and frequency/cost sensitivity complete: ${suite.name}`);
}

for (const suite of suites) {
  const full = aligned(suite.tickers, '1900-01-01', protocol.common_end);
  for (const id of suite.ids) all.push(run(suite, id, full, 'monthly', .0005, 'full_history').result);
  if (audit.legacy_proxy_entries[suite.name]) {
    const gateRows = aligned(suite.tickers, audit.legacy_proxy_entries[suite.name].execution_date, protocol.common_end);
    for (const id of suite.ids) all.push(run(suite, id, gateRows, 'monthly', .0005, 'legacy_PE_proxy_entry').result);
  }
  for (let year = 2000; year <= 2021; year++) {
    const start = `${year}-01-01`, end = `${year + 5}-01-01`;
    const rows = aligned(suite.tickers, start, `${year + 4}-12-31`);
    // Require January entry and a complete fifth December; do not test truncated windows.
    if (!rows.length || rows[0].date.slice(0, 7) !== `${year}-01` || rows.at(-1).date.slice(0, 7) !== `${year + 4}-12`) continue;
    for (const id of suite.ids) cohortResults.push({...run(suite, id, rows, 'monthly', .0005, 'five_year_cohort').result, cohort_year: year});
  }
  console.log(`Full history, legacy entries and five-year cohorts complete: ${suite.name}`);
}

// Verify the historical adapter makes exactly the same decisions on a data prefix.
const causalChecks = [];
for (const suite of suites) {
  const rows = aligned(suite.tickers, protocol.primary_start, protocol.common_end).slice(0, 90);
  for (const id of suite.ids) {
    const full = run(suite, id, rows, 'monthly', .0005, 'causality').trace;
    const prefix = run(suite, id, rows.slice(0, 57), 'monthly', .0005, 'causality').trace;
    if (JSON.stringify(full.slice(0, 57)) !== JSON.stringify(prefix)) throw new Error('future-data dependency');
    causalChecks.push(`${suite.name}/${id}`);
  }
}
save('./summary.json', {protocol, results: all, exposure_controls: exposureControls});
save('./cohorts.json', cohortResults);
writeFileSync(new URL('./daily-primary.csv.gz', import.meta.url), gzipSync(dailyLines.join('\n') + '\n'));
save('./verification.json', {runs_including_verification: count, account_snapshots_checked: invariantSnapshots,
  maximum_log_identity_residual: maxIdentityResidual, maximum_grid_currency_accounting_residual: maxGridAccountingResidual,
  exact_prefix_checks: causalChecks, source_data_and_spec_hashes_verified: true,
  reproducibility_hashes: Object.fromEntries(['../candidates.json','../strategies.mjs','./protocol.json','./prepare.py','./run.mjs','./prices.json'].map(file => [file, hash(file)]))});
console.log(JSON.stringify({result_runs: all.length, exposure_controls: exposureControls.length, five_year_cohort_runs: cohortResults.length,
  snapshots_checked: invariantSnapshots, maxIdentityResidual, maxGridAccountingResidual}, null, 2));
