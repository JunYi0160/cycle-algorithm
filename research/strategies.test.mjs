import test from 'node:test';
import assert from 'node:assert/strict';
import {SPEC, LongOnlyAccount, potentialValue, simulate} from './strategies.mjs';
const near = (actual, expected, tol = 1e-10) => assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const rowsFor = path => path.map((prices, i) => ({date: new Date(Date.UTC(2020, 0, 2 + i)).toISOString().slice(0, 10), prices: Array.isArray(prices) ? prices : [prices]}));
let seed = 90210;
const rand = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);

test('rebalance conserves equity after fees with simultaneous buys and sells', () => {
  const a = new LongOnlyAccount(10000, 2, .0005);
  a.rebalance([.8, .2], [100, 100]);
  const before = a.equity([150, 80]);
  const out = a.rebalance([.2, .6], [150, 80]);
  const after = a.snapshot([150, 80]);
  near(after.equity, before - out.fee); near(out.fee, .0005 * out.turnover);
  near(after.stock_weights[0], .2); near(after.stock_weights[1], .6); near(after.cash / after.equity, .2);
  assert.ok(out.trades[0] < 0 && out.trades[1] > 0);
});

test('hand calculated potential roundtrips and entry weights', () => {
  for (const [id, expected] of [['P-R1', .5], ['P-R2', 2 / 3], ['P-MIX', 4 / 9]]) {
    const d = SPEC.candidates.find(item => item.id === id);
    near(potentialValue(d, 100, 100).weight, expected);
  }
  near(simulate('P-R1', rowsFor([100, 120, 100]), {cost: 0}).terminal_equity, 10000 * (1 + .2 ** 2 / (2 * 1.2)));
  near(simulate('P-R1', rowsFor([100, 80, 100]), {cost: 0}).terminal_equity, 10250);
  near(simulate('B-50', rowsFor([100, 120, 100]), {cost: 0}).terminal_equity, 10000 * (1 + .25 * .2 ** 2 / 1.2));
});

test('potential decomposition with fees, gaps, and mark-only rows', () => {
  for (const id of ['P-R1', 'P-R2', 'P-MIX']) {
    const rows = rowsFor(Array.from({length: 120}, () => 5 + 500 * rand()));
    rows.forEach((row, i) => { row.rebalance = i % 4 === 0; });
    const run = simulate(id, rows);
    for (const s of run.samples) {
      near(s.diagnostics.identity_residual, 0, 1e-9);
      assert.ok(s.cash >= 0 && s.stock_weights[0] >= 0 && s.stock_weights[0] <= 1);
      if (!s.rebalance && s !== run.samples[0]) near(s.step_fee, 0);
    }
  }
});

test('entropy decomposition is exact for three assets with fees and sparse rebalancing', () => {
  for (const id of ['E-025', 'E-1', 'E-4']) {
    const rows = rowsFor(Array.from({length: 120}, () => Array.from({length: 3}, () => 20 + 300 * rand())));
    rows.forEach((row, i) => { row.rebalance = i % 3 === 0; });
    const run = simulate(id, rows);
    for (const s of run.samples) {
      near(s.diagnostics.identity_residual, 0, 1e-9);
      near(s.stock_weights.reduce((a, b) => a + b), 1);
      assert.ok(s.stock_weights.every(w => w >= 0));
    }
  }
});

test('relative roundtrip earns excess return; common market decline remains an absolute loss', () => {
  const g = 1 - .6 * Math.log(.6) - .4 * Math.log(.4);
  const w = .6 * (1 - Math.log(.6)) / g;
  const round = simulate('E-1', rowsFor([[100, 100], [120, 80], [100, 100]]), {cost: 0});
  near(round.terminal_equity, 10000 * (1.25 - 5 / 12 * w));
  assert.ok(round.net_return > 0);
  const falling = simulate('E-1', rowsFor([[100, 100], [80, 80], [60, 60]]), {cost: 0});
  near(falling.net_return, -.4);
  near(falling.samples.at(-1).diagnostics.capture_log_term, 0);
});

test('grid locks hand calculated net profit and includes open-inventory losses', () => {
  const c = .0005, q = 1200 / (100 * (1 + c));
  const expected = q * (110 * (1 - c) - 100 * (1 + c));
  const completed = simulate('G-10', rowsFor([100, 110]));
  near(completed.samples.at(-1).diagnostics.locked_profit, expected);
  near(completed.terminal_equity, 10000 + expected);
  const open = simulate('G-10', rowsFor([100, 1]));
  const last = open.samples.at(-1);
  assert.ok(last.diagnostics.locked_profit === 0 && last.diagnostics.unrealized_pnl < 0);
  near(last.equity, 10000 + last.diagnostics.unrealized_pnl);
  assert.ok(last.equity >= 4000);
});

test('grid budget and monotone locked-profit floor survive repeated gaps', () => {
  for (const id of ['G-05', 'G-10', 'G-20']) {
    const run = simulate(id, rowsFor([100, 60, 150, 40, 200, 1, 250, .001]));
    let prior = 0;
    for (const s of run.samples) {
      const d = s.diagnostics;
      assert.ok(s.equity + 1e-8 >= d.capital_floor);
      assert.ok(d.locked_profit >= prior); prior = d.locked_profit;
      near(d.accounting_residual, 0);
      assert.ok(d.cells.every(cell => cell.cash >= 0 && cell.units >= 0));
      const fills = d.fills.map(fill => fill.cell); assert.equal(new Set(fills).size, fills.length);
    }
  }
});

test('capital mixture equals separate funded members including all member fees', () => {
  for (const [id, prices] of [['M-SINGLE', [100, 80, 120, 60, 150]], ['M-MULTI', [[100, 100], [120, 80], [60, 90], [150, 50], [100, 100]]]]) {
    const rows = rowsFor(prices), def = SPEC.candidates.find(item => item.id === id);
    const run = simulate(id, rows), members = def.members.map(member => simulate(member, rows));
    run.samples.forEach((s, i) => {
      near(s.equity, members.reduce((n, member) => n + member.samples[i].equity, 0) / members.length);
      near(s.fees, members.reduce((n, member) => n + member.samples[i].fees, 0) / members.length);
      assert.ok(s.equity + 1e-8 >= Math.max(...members.map(member => member.samples[i].equity)) / members.length);
      near(s.diagnostics.strategy_capital_weights.reduce((a, b) => a + b), 1);
    });
  }
});

test('truncating a path preserves the complete earlier trading ledger for every candidate', () => {
  for (const candidate of SPEC.candidates) {
    const multi = candidate.family === 'entropy' || candidate.id === 'M-MULTI';
    const rows = rowsFor(multi ? [[100, 100], [120, 80], [90, 110], [140, 70], [100, 100]] : [100, 120, 90, 140, 100]);
    const full = simulate(candidate.id, rows), prefix = simulate(candidate.id, rows.slice(0, 3));
    assert.deepEqual(prefix.samples, full.samples.slice(0, 3));
  }
});

test('fixed anchors and fixed reference units are unaffected by later observations', () => {
  const p = simulate('P-R2', rowsFor([100, 500, 50]));
  p.samples.forEach(s => assert.deepEqual(s.diagnostics.fixed_anchors, [200]));
  const e = simulate('E-1', rowsFor([[100, 50], [200, 50], [100, 50]]), {cost: 0});
  near(e.samples[1].diagnostics.reference_weights[0], 2 / 3);
  near(e.samples[2].diagnostics.reference_weights[0], .5);
});

test('invalid observations fail rather than being silently dropped or filled', () => {
  assert.throws(() => simulate('P-R1', rowsFor([100, 0])), /positive/);
  assert.throws(() => simulate('E-1', rowsFor([100, 120])), /two assets/);
  assert.throws(() => simulate('P-R1', [{date: '2020-01-02', prices: [100]}, {date: '2020-01-02', prices: [120]}]), /increasing/);
  assert.throws(() => simulate('P-R1', [{date: '2020-01-02', prices: [100], rebalance: 'yes'}]), /boolean/);
  assert.throws(() => simulate('P-R1', rowsFor([100]), {cost: -.001}), /cost/);
});
