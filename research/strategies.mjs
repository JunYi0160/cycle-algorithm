// Independent, long-only research examples. Production strategy.js is not imported.
import {readFileSync} from 'node:fs';
export const SPEC = JSON.parse(readFileSync(new URL('./candidates.json', import.meta.url), 'utf8'));
const DEFINITIONS = new Map([...SPEC.candidates, ...SPEC.controls].map(item => [item.id, item]));
const sum = values => values.reduce((a, b) => a + b, 0);
const dot = (a, b) => sum(a.map((value, i) => value * b[i]));
const clone = value => structuredClone(value);
function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
}
function pricesOK(prices, size = null) {
  if (!Array.isArray(prices) || !prices.length || (size !== null && prices.length !== size)) throw new Error('invalid price vector');
  prices.forEach((price, i) => positive(price, `prices[${i}]`));
}
function weightsOK(weights, size) {
  if (!Array.isArray(weights) || weights.length !== size || weights.some(w => !Number.isFinite(w) || w < 0) || sum(weights) > 1 + 1e-12) throw new Error('weights must be nonnegative and sum to at most one');
}
function oneAssetWeights(size, index, weight) {
  if (!Number.isInteger(index) || index < 0 || index >= size) throw new Error('invalid asset index');
  const out = Array(size).fill(0); out[index] = weight; return out;
}
const entropy = mu => -sum(mu.map(value => value * Math.log(value)));
const kl = (next, previous) => sum(next.map((value, i) => value * Math.log(value / previous[i])));

export class LongOnlyAccount {
  constructor(capital, assetCount, cost) {
    positive(capital, 'capital');
    if (!Number.isInteger(assetCount) || assetCount < 1) throw new Error('invalid asset count');
    if (!Number.isFinite(cost) || cost < 0 || cost >= 0.1) throw new Error('cost must lie in [0,0.1)');
    this.cash = capital; this.units = Array(assetCount).fill(0); this.cost = cost;
    this.totalFees = 0; this.totalTurnover = 0;
  }
  equity(prices) { pricesOK(prices, this.units.length); return this.cash + dot(this.units, prices); }
  rebalance(weights, prices) {
    pricesOK(prices, this.units.length); weightsOK(weights, this.units.length);
    const values = this.units.map((q, i) => q * prices[i]);
    const before = this.cash + sum(values);
    // Solve E_after + cost * sum |w_i E_after - old_value_i| = E_before.
    let low = 0, high = before;
    for (let k = 0; k < 80; k++) {
      const mid = (low + high) / 2;
      const fee = this.cost * sum(weights.map((w, i) => Math.abs(w * mid - values[i])));
      if (mid + fee > before) high = mid; else low = mid;
    }
    const after = (low + high) / 2;
    const trades = weights.map((w, i) => w * after - values[i]);
    const turnover = sum(trades.map(Math.abs)), fee = this.cost * turnover;
    this.cash -= sum(trades) + fee;
    if (this.cash < -1e-9 * before) throw new Error('cash became negative');
    if (Math.abs(this.cash) < 1e-12 * before) this.cash = 0;
    this.units = weights.map((w, i) => w * after / prices[i]);
    this.totalFees += fee; this.totalTurnover += turnover;
    return {trades, fee, turnover, retention: this.equity(prices) / before};
  }
  snapshot(prices) {
    const equity = this.equity(prices);
    return {equity, cash: this.cash, units: [...this.units],
      stock_weights: this.units.map((q, i) => q * prices[i] / equity),
      fees: this.totalFees, turnover: this.totalTurnover};
  }
}

export function potentialValue(definition, price, entryPrice) {
  let value = 0, derivative = 0;
  definition.anchor_multipliers.forEach((multiplier, i) => {
    const k = multiplier * entryPrice, a = definition.coefficients[i];
    value += a * price / (price + k);
    derivative += a * k / (price + k) ** 2;
  });
  return {value, derivative, weight: price * derivative / value};
}

class AllocationStrategy {
  constructor(definition, capital, entryPrices, cost) {
    this.definition = clone(definition); this.initialCapital = capital; this.entryPrices = [...entryPrices];
    this.account = new LongOnlyAccount(capital, entryPrices.length, cost);
    this.initialized = false; this.previous = null;
    this.logCapture = 0; this.logCostRetention = 0;
    if (definition.family === 'entropy') {
      if (entryPrices.length < 2) throw new Error('entropy needs at least two assets');
      this.referenceUnits = entryPrices.map(price => capital / entryPrices.length / price);
    }
  }
  targets(prices) {
    const d = this.definition, n = prices.length;
    if (d.family === 'potential') return oneAssetWeights(n, d.asset_index, potentialValue(d, prices[d.asset_index], this.entryPrices[d.asset_index]).weight);
    if (d.family === 'entropy') {
      const total = dot(this.referenceUnits, prices);
      const mu = prices.map((price, i) => this.referenceUnits[i] * price / total);
      const g = d.c + entropy(mu);
      return mu.map(value => value * (d.c - Math.log(value)) / g);
    }
    if (d.weights === 'equal' || d.initial_weights === 'equal') return Array(n).fill(1 / n);
    if (d.family === 'cash') return Array(n).fill(0);
    return oneAssetWeights(n, d.asset_index, d.family === 'constant_mix' ? d.stock_weight : 1);
  }
  benchmarkState(prices) {
    const d = this.definition;
    if (d.family === 'potential') return potentialValue(d, prices[d.asset_index], this.entryPrices[d.asset_index]);
    if (d.family === 'entropy') {
      const benchmark = dot(this.referenceUnits, prices);
      const mu = prices.map((price, i) => this.referenceUnits[i] * price / benchmark);
      return {benchmark, mu, value: d.c + entropy(mu)};
    }
    return null;
  }
  onPrices(prices, rebalance = true) {
    pricesOK(prices, this.entryPrices.length);
    const d = this.definition;
    const shouldTrade = !this.initialized || (rebalance && !['buy_hold', 'cash'].includes(d.family));
    const state = this.benchmarkState(prices);
    // Identities apply to intervals beginning at actual rebalancing prices.
    if (this.previous && rebalance && ['potential', 'entropy'].includes(d.family)) {
      let excess;
      if (d.family === 'potential') {
        const old = this.previous.state, index = d.asset_index;
        excess = old.value + old.derivative * (prices[index] - this.previous.prices[index]) - state.value;
      } else excess = kl(state.mu, this.previous.state.mu);
      this.logCapture += Math.log1p(Math.max(0, excess) / state.value);
    }
    let trade = {trades: Array(prices.length).fill(0), fee: 0, turnover: 0, retention: 1};
    if (shouldTrade) {
      trade = this.account.rebalance(this.targets(prices), prices);
      this.logCostRetention += Math.log(trade.retention);
      this.previous = {prices: [...prices], state};
    }
    this.initialized = true;
    const snapshot = this.account.snapshot(prices);
    const diagnostics = {};
    if (state) {
      const initial = this.benchmarkState(this.entryPrices);
      const previous = this.previous;
      let capture = this.logCapture;
      // Include the untraded terminal segment so identity diagnostics also work on mark-only rows.
      if (!shouldTrade && previous) {
        let excess;
        if (d.family === 'potential') {
          const i = d.asset_index;
          excess = previous.state.value + previous.state.derivative * (prices[i] - previous.prices[i]) - state.value;
        } else excess = kl(state.mu, previous.state.mu);
        capture += Math.log1p(Math.max(0, excess) / state.value);
      }
      const endpoint = Math.log(state.value / initial.value);
      const actual = d.family === 'potential' ? Math.log(snapshot.equity / this.initialCapital) : Math.log(snapshot.equity / state.benchmark);
      Object.assign(diagnostics, {endpoint_log_term: endpoint, capture_log_term: capture,
        cost_log_term: this.logCostRetention, identity_residual: actual - endpoint - capture - this.logCostRetention});
      if (d.family === 'potential') diagnostics.fixed_anchors = d.anchor_multipliers.map(a => a * this.entryPrices[d.asset_index]);
      else Object.assign(diagnostics, {reference_equity: state.benchmark, reference_weights: state.mu, relative_equity: snapshot.equity / state.benchmark});
    }
    return {...snapshot, step_fee: trade.fee, step_turnover: trade.turnover, trades: trade.trades, diagnostics};
  }
}

class GridStrategy {
  constructor(definition, capital, entryPrices, cost) {
    this.definition = clone(definition); this.initialCapital = capital; this.entryPrices = [...entryPrices]; this.cost = cost;
    const d = this.definition, start = entryPrices[d.asset_index];
    positive(start, 'entry price');
    this.reserve = capital * (1 - d.budget_fraction); this.lockedProfit = 0;
    this.totalFees = 0; this.totalTurnover = 0; this.completed = 0; this.initialized = false;
    this.cells = Array.from({length: d.cells}, (_, j) => {
      const low = start / (1 + d.step) ** j, high = low * (1 + d.step);
      const budget = capital * d.budget_fraction / d.cells;
      if ((1 - cost) * high <= (1 + cost) * low) throw new Error('grid cannot cover fees');
      return {index: j, low, high, budget, cash: budget, planned_units: budget / ((1 + cost) * low), units: 0, entry_cost: 0};
    });
  }
  onPrices(prices, rebalance = true) {
    pricesOK(prices, this.entryPrices.length);
    const d = this.definition, p = prices[d.asset_index], fills = [];
    let stepFee = 0, stepTurnover = 0, netTrade = 0;
    if (!this.initialized || rebalance) for (const cell of this.cells) {
      if (cell.units > 0 && p >= cell.high * (1 - 1e-12)) {
        const gross = cell.units * p, fee = gross * this.cost, profit = gross - fee - cell.entry_cost;
        if (profit <= 0) throw new Error('completed grid cycle did not earn positive profit');
        cell.cash += gross - fee; cell.cash -= profit;
        this.lockedProfit += profit; this.completed++;
        fills.push({cell: cell.index, side: 'sell', price: p, units: cell.units, fee, realized_profit: profit});
        netTrade -= gross; stepFee += fee; stepTurnover += gross;
        cell.units = 0; cell.entry_cost = 0;
      } else if (cell.units === 0 && p <= cell.low * (1 + 1e-12)) {
        const units = cell.planned_units, gross = units * p, fee = gross * this.cost;
        if (gross + fee > cell.cash + 1e-8 * cell.budget) throw new Error('grid exceeded prefunded cell budget');
        cell.cash -= gross + fee; if (Math.abs(cell.cash) < 1e-10 * cell.budget) cell.cash = 0;
        cell.units = units; cell.entry_cost = gross + fee;
        fills.push({cell: cell.index, side: 'buy', price: p, units, fee});
        netTrade += gross; stepFee += fee; stepTurnover += gross;
      }
    }
    this.initialized = true; this.totalFees += stepFee; this.totalTurnover += stepTurnover;
    const units = Array(prices.length).fill(0); units[d.asset_index] = sum(this.cells.map(cell => cell.units));
    const cash = this.reserve + this.lockedProfit + sum(this.cells.map(cell => cell.cash));
    const equity = cash + dot(units, prices);
    const unrealized = sum(this.cells.map(cell => cell.units * p - cell.entry_cost));
    return {equity, cash, units, stock_weights: units.map((q, i) => q * prices[i] / equity), fees: this.totalFees,
      turnover: this.totalTurnover, step_fee: stepFee, step_turnover: stepTurnover,
      trades: oneAssetWeights(prices.length, d.asset_index, 0).map((_, i) => i === d.asset_index ? netTrade : 0),
      diagnostics: {completed_cycles: this.completed, locked_profit: this.lockedProfit, unrealized_pnl: unrealized,
        capital_floor: this.reserve + this.lockedProfit,
        accounting_residual: equity - this.initialCapital - this.lockedProfit - unrealized,
        cells: clone(this.cells), fills}};
  }
}

class MixtureStrategy {
  constructor(definition, capital, entryPrices, cost) {
    this.definition = clone(definition); this.initialCapital = capital;
    this.members = definition.members.map(id => createStrategy(id, {capital: capital / definition.members.length, entryPrices, cost}));
  }
  onPrices(prices, rebalance = true) {
    const snapshots = this.members.map(member => member.onPrices(prices, rebalance));
    const equity = sum(snapshots.map(s => s.equity));
    const units = prices.map((_, i) => sum(snapshots.map(s => s.units[i])));
    const componentEquities = snapshots.map(s => s.equity), m = snapshots.length;
    return {equity, cash: sum(snapshots.map(s => s.cash)), units,
      stock_weights: units.map((q, i) => q * prices[i] / equity),
      fees: sum(snapshots.map(s => s.fees)), turnover: sum(snapshots.map(s => s.turnover)),
      step_fee: sum(snapshots.map(s => s.step_fee)), step_turnover: sum(snapshots.map(s => s.step_turnover)),
      trades: prices.map((_, i) => sum(snapshots.map(s => s.trades[i]))),
      diagnostics: {members: [...this.definition.members], component_equities: componentEquities,
        strategy_capital_weights: componentEquities.map(value => value / equity),
        best_full_capital_equity: m * Math.max(...componentEquities),
        competitive_lower_bound: Math.max(...componentEquities),
        components: snapshots.map(s => s.diagnostics)}};
  }
}

export function createStrategy(id, {capital = SPEC.defaults.initial_capital, entryPrices, cost = SPEC.defaults.one_way_cost} = {}) {
  const d = DEFINITIONS.get(id); if (!d) throw new Error(`unknown strategy ${id}`);
  positive(capital, 'capital'); pricesOK(entryPrices);
  if (!Number.isFinite(cost) || cost < 0 || cost >= 0.1) throw new Error('cost must lie in [0,0.1)');
  if (d.asset_index !== undefined && (d.asset_index < 0 || d.asset_index >= entryPrices.length)) throw new Error('asset index out of range');
  if (d.family === 'grid') return new GridStrategy(d, capital, entryPrices, cost);
  if (d.family === 'mixture') return new MixtureStrategy(d, capital, entryPrices, cost);
  return new AllocationStrategy(d, capital, entryPrices, cost);
}

export function simulate(id, rows, {capital = SPEC.defaults.initial_capital, cost = SPEC.defaults.one_way_cost} = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('rows must be nonempty');
  const parsedDates = rows.map(row => Date.parse(row.date));
  if (parsedDates.some(x => !Number.isFinite(x)) || parsedDates.some((x, i) => i > 0 && x <= parsedDates[i - 1])) throw new Error('dates must be valid and strictly increasing');
  const strategy = createStrategy(id, {capital, entryPrices: rows[0].prices, cost});
  let peak = capital, drawdown = 0;
  const samples = rows.map(row => {
    if (row.rebalance !== undefined && typeof row.rebalance !== 'boolean') throw new Error('rebalance must be boolean');
    const snapshot = strategy.onPrices(row.prices, row.rebalance !== false);
    peak = Math.max(peak, snapshot.equity); drawdown = Math.min(drawdown, snapshot.equity / peak - 1);
    return {date: row.date, prices: [...row.prices], rebalance: row.rebalance !== false, ...snapshot};
  });
  const last = samples.at(-1);
  const maxResidual = Math.max(...samples.map(s => Math.abs(s.diagnostics.identity_residual ?? s.diagnostics.accounting_residual ?? 0)));
  return {id, initial_capital: capital, cost, terminal_equity: last.equity, net_return: last.equity / capital - 1,
    max_drawdown_at_observations: drawdown, fees: last.fees, turnover: last.turnover,
    maximum_accounting_or_identity_residual: maxResidual, samples};
}
