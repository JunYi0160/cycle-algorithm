import test from 'node:test';
import assert from 'node:assert/strict';
import {CONFIG} from '../src/strategy.js';
import {simulate,makeReport} from '../scripts/validate-oscillation.mjs';

test('synthetic entry happens after the first close return, not before it',()=>{
  const run=simulate([...Array(59).fill(100),90,99],undefined,1);
  assert.equal(run.signal_entry_index,59);
  assert.ok(Math.abs(run.terminal_equity-(99/90)**(21/22)/(1+CONFIG.one_way_cost))<1e-12);
});

test('fixed synthetic scenarios retain net gains and cost failures with shared entry and no future data',()=>{
  const cases=Object.fromEntries(makeReport().scenarios.map(row=>[row.scenario,row.results]));
  for(const name of ['wide_slow','wide_fast']){
    assert.ok(cases[name].pivot_v2.net_return>0);
    assert.ok(cases[name].pivot_v2.net_return>cases[name].legacy_v1.net_return);
    assert.ok(cases[name].pivot_v2.financing_interest>0&&cases[name].pivot_v2.transaction_fees>0);
  }
  assert.ok(cases.very_small_slow.pivot_v2.net_return<0);
  assert.ok(cases.small_fast.pivot_v2.net_return<cases.small_fast.legacy_v1.net_return);
});
