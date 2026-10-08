import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData,parseCSV,parseValuations,normalizeValuation,mergeValuations,normalizeSessionHolding,validateBackup,formalMonthEnd,activateFormal,monthEnd,controllerFromLegacyRun} from '../src/model.js';
import {CONFIG,ALGORITHM_ID} from '../src/strategy.js';
import {calculatePortfolio,aggregateWeightedResults,buildMonthlyScores} from '../src/preview.js';
import {exportBackup} from '../src/storage.js';
const history=()=>Array.from({length:61},(_,i)=>normalizeValuation({id:'record'+i,symbol:'AAA',valuation_date:monthEnd(`${2020+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`),s_tech:i+1}));
const held=symbol=>({id:symbol,symbol,input_mode:'market_value',market_value:1000,sec_type:'STK',currency:'EUR'});

test('quoted CSV, BOM, multiline notes and atomic row errors',()=>{
  const csv='\uFEFFsymbol,valuation_date,s_tech,notes\r\nAAA,2025-01-31,4,"one, two\nthree ""quoted"""\r\n';
  assert.equal(parseValuations(csv,'a.csv')[0].notes,'one, two\nthree "quoted"');
  assert.throws(()=>parseValuations('symbol,valuation_date,s_tech\nAAA,2025-02-30,4\nAAA,2025-02-28,','a.csv'));
  assert.throws(()=>parseCSV('symbol,valuation_date,s_tech\nAAA,2025-01-31,"4'));
  assert.throws(()=>parseValuations('[{"symbol":"AAA","valuation_date":"2025-01-31","s_tech":null}]','a.json'));
});
test('score and source-only revisions preserve originals without mutation',()=>{
  const d=emptyData(),row=normalizeValuation({symbol:'AAA',valuation_date:'2025-01-31',s_tech:5,interpolated:true,source_code:'archive',raw_inputs:{price:100}});
  const a=mergeValuations(d,[row]);assert.equal(d.valuations.length,0);assert.equal(a.added,1);
  assert.equal(mergeValuations(a.data,[row]).skipped,1);
  const b=mergeValuations(a.data,[{...row,s_tech:6}]);assert.equal(b.data.valuations.length,2);assert.equal(b.data.valuations[0].is_current,false);assert.equal(b.data.valuations[1].revision,2);
  const c=mergeValuations(b.data,[{...b.data.valuations[1],source_url:'https://example.org/report'}]);
  assert.equal(c.added,1);assert.equal(c.data.valuations.at(-1).revision,3);
});
test('session inputs allow only positive market values or ratios',()=>{
  assert.equal(normalizeSessionHolding({...held('AAA')}).market_value,1000);
  assert.equal(normalizeSessionHolding({symbol:'AAA',input_mode:'ratio',ratio:75}).ratio,75);
  for(const p of [{symbol:'AAA',input_mode:'shares',quantity:10},{symbol:'AAA',ratio:0},{symbol:'AAA',ratio:-1},{symbol:'AAA',ratio:NaN},{symbol:'AAA',ratio:''}]){
    assert.throws(()=>normalizeSessionHolding(p));
  }
  assert.ok(!('holdings' in emptyData()));assert.ok(!('account' in emptyData()));
});
test('positive weights, scale invariance, mixed modes and missing symbols',()=>{
  assert.deepEqual(aggregateWeightedResults([{market_value:3000,percentile:.2,target_leverage:1.2},{market_value:1000,percentile:.8,target_leverage:1.6}]),{market_value:4000,percentile:.35000000000000003,target_leverage:1.2999999999999998});
  const valuations=[...history(),...history().map(r=>({...r,id:'b'+r.id,symbol:'BBB',s_tech:Math.sin(r.s_tech)}))];
  const positions=[{symbol:'AAA',input_mode:'ratio',ratio:75},{symbol:'BBB',input_mode:'ratio',ratio:25}];
  const first=calculatePortfolio(positions,valuations,'2025-02-01'),scaled=calculatePortfolio(positions.map(p=>({...p,ratio:p.ratio*1000})),valuations,'2025-02-01');
  assert.equal(first.status,'ready');assert.equal(scaled.target_leverage,first.target_leverage);
  assert.equal(first.target_leverage,first.positions.reduce((sum,p)=>sum+p.holding_weight*p.target_leverage,0));
  const missing=calculatePortfolio([...positions,{symbol:'MISSING',ratio:1}],valuations,'2025-02-01');
  assert.equal(missing.status,'blocked');assert.equal(missing.target_leverage,null);
  assert.equal(calculatePortfolio([positions[0],held('BBB')],valuations,'2025-02-01').status,'blocked');
});
test('manual FX conversion and missing FX block the whole result',()=>{
  assert.equal(calculatePortfolio([{...held('AAA'),currency:'USD'}],history(),'2025-02-01',{referenceCurrency:'EUR'}).status,'blocked');
  const p=calculatePortfolio([{...held('AAA'),currency:'USD'}],history(),'2025-02-01',{referenceCurrency:'EUR',fxRates:{'USD/EUR':.8}});
  assert.equal(p.status,'ready');assert.equal(p.market_value,800);
});
test('formal signal, delayed activation and preview separation survive public export',()=>{
  let d={...emptyData(),valuations:history()};const snapshot=JSON.stringify(d);
  let next=formalMonthEnd(d,'AAA','2024-12-31','2025-02-01');assert.equal(JSON.stringify(d),snapshot);
  assert.equal(next.formalEvents[0].state.current_target,null);assert.ok(next.formalEvents[0].state.pending_target>=1);
  assert.throws(()=>activateFormal(next,'AAA','2024-12-31','2025-02-01'));
  assert.throws(()=>formalMonthEnd(next,'AAA','2025-01-31','2025-02-01'));
  next=activateFormal(next,'AAA','2025-01-02','2025-02-01');
  assert.deepEqual(validateBackup(JSON.parse(exportBackup(next))).formalEvents,next.formalEvents);
  const noGate={...emptyData(),valuations:history().map((r,i)=>({...r,s_tech:100-i}))};
  assert.equal(formalMonthEnd(noGate,'AAA','2024-12-31','2025-02-01').formalEvents[0].state.pending_target,null);
});
test('interpolation markers remain separate from temporary gap filling',()=>{
  const rows=history().filter((_,i)=>i!==20);rows[0].interpolated=true;
  const {coverage,scores}=buildMonthlyScores(rows,{symbol:'AAA',asOf:'2025-02-01'});
  assert.deepEqual(coverage.source_interpolated_months,['2020-01']);assert.deepEqual(coverage.interpolated_months,['2021-09']);
  assert.equal(scores[0].interpolated,false);assert.equal(scores[20].interpolated,true);
});
test('legacy JSON removes account, positions, jobs and arbitrary payloads',()=>{
  const data={...emptyData(),schemaVersion:2,algorithm:'finite-rational-60-rho0.9',valuations:history(),
    holdings:[{symbol:'AAA',market_value:987654}],account:{financing:12345},enrichmentJobs:[{token:'secret'}],
    formalEvents:[{symbol:'AAA',account_snapshot:999,state:{pending_target:1.3}}],
    legacyFormalEvents:[{symbol:'AAA',source_run:{account_snapshot:777}}]};
  const migrated=validateBackup(data),text=exportBackup(migrated);
  for(const forbidden of ['holdings','account','financing','enrichmentJobs','secret','source_run','987654'])assert.ok(!text.includes(forbidden),forbidden);
  assert.deepEqual(migrated.legacyFormalEvents,[{symbol:'AAA'}]);
  assert.throws(()=>activateFormal(migrated,'AAA','2025-01-02','2025-03-01'),/没有正式信号/);
  const replayed=formalMonthEnd(migrated,'AAA','2025-01-31','2025-03-01');assert.equal(replayed.formalEvents.at(-1).history_replayed,true);
});
test('current pivots validate, resumed paths match, and duplicate dates reject',()=>{
  let d=formalMonthEnd({...emptyData(),valuations:history()},'AAA','2024-12-31','2025-03-01');
  d=activateFormal(d,'AAA','2025-01-02','2025-03-01');
  const restored=validateBackup(JSON.parse(exportBackup(d)));
  assert.deepEqual(formalMonthEnd(restored,'AAA','2025-01-31','2025-03-01').formalEvents.at(-1).state,formalMonthEnd(d,'AAA','2025-01-31','2025-03-01').formalEvents.at(-1).state);
  const corrupt=structuredClone(d);delete corrupt.formalEvents[0].state.pivot_x;assert.throws(()=>validateBackup(corrupt),/pivot_x/);
  assert.throws(()=>validateBackup({...d,valuations:[...history(),history()[0]]}));
  assert.equal(controllerFromLegacyRun({z:.4,entered:true,strategy_config:CONFIG}),null);
});
