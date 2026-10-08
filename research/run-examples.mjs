import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {SPEC, simulate} from './strategies.mjs';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[index + 1];
}
const inputPath = option('--input');
const input = JSON.parse(readFileSync(inputPath ? resolve(inputPath) : new URL('./examples.json', import.meta.url), 'utf8'));
const output = resolve(option('--output') ?? fileURLToPath(new URL('./examples-report.json', import.meta.url)));
const report = {kind: 'frozen research candidates; synthetic examples unless input explicitly provides historical data',
  source_kind: input.kind ?? 'user supplied; provenance not independently verified', version: SPEC.version,
  defaults: SPEC.defaults, parameters: [...SPEC.candidates, ...SPEC.controls],
  source_sha256: Object.fromEntries(['candidates.json', 'strategies.mjs', 'run-examples.mjs'].map(name => [name, createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex')])),
  input_sha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), scenarios: []};
for (const scenario of input.scenarios) {
  const ids = scenario.strategy_ids ?? (scenario.assets.length === 1 ? input.single_strategy_ids : input.multi_strategy_ids);
  if (!ids?.length) throw new Error(`missing strategy ids for ${scenario.id}`);
  if (!scenario.rows.every(row => row.prices.length === scenario.assets.length)) throw new Error(`asset count mismatch in ${scenario.id}`);
  const runs = ids.map(id => ({id,
    zero_cost: simulate(id, scenario.rows, {capital: SPEC.defaults.initial_capital, cost: 0}),
    configured_cost: simulate(id, scenario.rows)}));
  report.scenarios.push({id: scenario.id, assets: scenario.assets, runs});
}
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({output, scenario_count: report.scenarios.length,
  simulation_count: report.scenarios.reduce((n, s) => n + 2 * s.runs.length, 0),
  illustrative_results: report.scenarios.filter(s => ['single-up-roundtrip', 'single-tiny-roundtrip', 'single-persistent-down', 'multi-relative-roundtrip', 'multi-common-down'].includes(s.id)).map(s => ({
    scenario: s.id, results: s.runs.map(r => ({id: r.id, zero_cost_return: r.zero_cost.net_return,
      net_return: r.configured_cost.net_return, fees: r.configured_cost.fees}))}))}, null, 2));
