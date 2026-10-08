import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData,parseCSV,parseValuations,normalizeValuation,mergeValuations,normalizeAccount,accountSummary,validateBackup,formalMonthEnd,activateFormal,monthEnd,controllerFromLegacyRun} from '../src/model.js';
import {CONFIG,ALGORITHM_ID} from '../src/strategy.js';
import {calculatePortfolio,aggregateWeightedResults,buildMonthlyScores} from '../src/preview.js';
import {load,save,exportBackup,STORAGE_KEY,LEGACY_STORAGE_KEY} from '../src/storage.js';
const history=()=>Array.from({length:61},(_,i)=>normalizeValuation({id:'record'+i,symbol:'AAA',valuation_date:monthEnd(`${2020+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`),s_tech:i+1}));
const held=symbol=>({id:symbol,symbol,quantity:10,market_value:1000,sec_type:'STK',currency:'EUR'});
test('quoted CSV, BOM, multiline notes and atomic row errors',()=>{
  const csv='\uFEFFsymbol,valuation_date,s_tech,notes\r\nAAA,2025-01-31,4,"one, two\nthree ""quoted"""\r\n';
  const rows=parseValuations(csv,'a.csv');assert.equal(rows[0].notes,'one, two\nthree "quoted"');
  assert.throws(()=>parseValuations('symbol,valuation_date,s_tech\nAAA,2025-02-30,4\nAAA,2025-02-28,','a.csv'));
  assert.throws(()=>parseCSV('symbol,valuation_date,s_tech\nAAA,2025-01-31,"4'));
  assert.throws(()=>parseValuations('[{"symbol":"AAA","valuation_date":"2025-01-31","s_tech":null}]','a.json'));
});
test('same date score revision preserves original provenance and does not mutate input',()=>{
  const d=emptyData(),row=normalizeValuation({symbol:'AAA',valuation_date:'2025-01-31',s_tech:5,interpolated:true,source_code:'archive',raw_inputs:{price:100}});
  const a=mergeValuations(d,[row]);assert.equal(d.valuations.length,0);assert.equal(a.added,1);
  const repeat=mergeValuations(a.data,[row]);assert.equal(repeat.skipped,1);
  const b=mergeValuations(a.data,[{...row,s_tech:6}]);assert.equal(b.data.valuations.length,2);assert.equal(b.data.valuations[0].is_current,false);assert.equal(b.data.valuations[1].revision,2);
  assert.equal(b.data.valuations[0].source_code,'archive');assert.deepEqual(b.data.valuations[0].raw_inputs,{price:100});
});
test('account A is derived once, negative B is cash, and invalid inputs block saving',()=>{
  const p=normalizeAccount({currency:'EUR',financing:-500},[held('AAA')]);assert.equal(accountSummary({...emptyData(),...p},{status:'blocked'}).E,1500);
  assert.throws(()=>normalizeAccount({currency:'EUR',financing:2000},[held('AAA')]));
  assert.throws(()=>normalizeAccount({currency:'EUR',financing:0},[{...held('AAA'),currency:'USD'}]));
  assert.throws(()=>normalizeAccount({currency:'EUR',financing:0},[{...held('AAA'),quantity:-1}]));
  assert.throws(()=>normalizeAccount({currency:'EUR',financing:NaN},[held('AAA')]));
  const migrated={...held('AAA'),market_value:800,source_currency:'USD',source_market_value:1000,conversion_rate:.8,conversion_snapshot_time:'2026-10-01T00:00:00Z'};
  const converted=normalizeAccount({currency:'EUR',financing:0},[migrated]);
  const restored=validateBackup(JSON.parse(exportBackup({...emptyData(),...converted})));
  assert.deepEqual(restored.holdings[0],migrated);
  assert.throws(()=>normalizeAccount({currency:'EUR',financing:0},[{...migrated,conversion_rate:0}]));
});
test('positive market value weights, not average x fed to one controller',()=>{
  assert.deepEqual(aggregateWeightedResults([{market_value:3000,percentile:.2,target_leverage:1.2},{market_value:1000,percentile:.8,target_leverage:1.6}]),{market_value:4000,percentile:.35000000000000003,target_leverage:1.2999999999999998});
});
test('unknown holding, option, short and missing market value block entire portfolio',()=>{
  const rows=history();for(const bad of [held('MISSING'),{...held('AAA'),sec_type:'OPT'},{...held('AAA'),quantity:-1},{...held('AAA'),market_value:NaN}]){
    const p=calculatePortfolio([held('AAA'),bad],rows,'2025-02-01');assert.equal(p.status,'blocked');assert.equal(p.target_leverage,null);
  }
  const p=calculatePortfolio([held('AAA')],rows,'2025-02-01');assert.equal(p.status,'ready');
  assert.equal(calculatePortfolio([{...held('AAA'),quantity:0,market_value:0}],rows,'2025-02-01').status,'empty');
});
test('display adjustment and fee-adjusted exact trade remain different',()=>{
  const d={...emptyData(),account:{currency:'EUR',financing:200,updatedAt:'2025-01-01'},holdings:[held('AAA')]};
  const summary=accountSummary(d,{status:'ready',target_leverage:1.5});assert.equal(summary.A,1000);assert.equal(summary.E,800);assert.equal(summary.targetMarketValue,1200);assert.equal(summary.adjustment,200);assert.notEqual(summary.exact.trade,summary.adjustment);
  const invalid=accountSummary({...d,account:{...d.account,financing:2000}},{status:'ready',target_leverage:1.5});assert.equal(invalid.target,null);
});
test('formal signal, delayed activation and preview separation survive complete backup',()=>{
  let d={...emptyData(),valuations:history()};const snapshot=JSON.stringify(d);
  let next=formalMonthEnd(d,'AAA','2024-12-31','2025-02-01');assert.equal(JSON.stringify(d),snapshot);
  assert.equal(next.formalEvents[0].state.current_target,null);assert.ok(next.formalEvents[0].state.pending_target>=1);
  assert.throws(()=>activateFormal(next,'AAA','2024-12-31','2025-02-01'));
  assert.throws(()=>formalMonthEnd(next,'AAA','2025-01-31','2025-02-01'));
  next=activateFormal(next,'AAA','2025-01-02','2025-02-01');assert.equal(next.formalEvents.at(-1).state.pending_target,null);
  const restored=validateBackup(JSON.parse(exportBackup(next)));assert.deepEqual(restored.formalEvents,next.formalEvents);
  next=formalMonthEnd(restored,'AAA','2025-01-31','2025-02-01');assert.ok(next.formalEvents.at(-1).state.pending_target);
  const noGate={...emptyData(),valuations:history().map((r,i)=>({...r,s_tech:100-i}))};
  assert.equal(formalMonthEnd(noGate,'AAA','2024-12-31','2025-02-01').formalEvents[0].state.pending_target,null);
  assert.equal(noGate.formalEvents.length,0);
});
test('interpolation markers are separate from temporary gap filling',()=>{
  const rows=history().filter((_,i)=>i!==20);rows[0].interpolated=true;
  const {coverage,scores}=buildMonthlyScores(rows,{symbol:'AAA',asOf:'2025-02-01'});
  assert.deepEqual(coverage.source_interpolated_months,['2020-01']);assert.deepEqual(coverage.interpolated_months,['2021-09']);
  assert.equal(scores[0].interpolated,false);assert.equal(scores[20].interpolated,true);assert.equal(rows.length,60);
});
test('persistent roundtrip and quota failure preserve prior data',()=>{
  let text=null;const store={getItem:()=>text,setItem:(k,v)=>{text=v;}};
  const saved=save(emptyData(),store);assert.deepEqual(load(store),saved);
  const original=text;store.setItem=()=>{throw new Error('QuotaExceeded');};assert.throws(()=>save({...saved,migrationNotes:['x']},store));assert.equal(text,original);
  assert.throws(()=>validateBackup({...saved,schemaVersion:999}));
  assert.throws(()=>validateBackup({...saved,valuations:[...history(),history()[0]]}));
});

function oldBackup(version=2){
  const config={...CONFIG};delete config.controller_version;
  return {...emptyData(),schemaVersion:version,algorithm:'finite-rational-60-rho0.9',
    referenceCurrency:'EUR',account:{currency:'EUR',financing:200,updatedAt:'2025-01-01'},
    holdings:[held('AAA')],valuations:history(),quotes:{AAA:{price:31,currency:'USD'}},
    fxRates:{'EUR/USD':{rate:1.1,source_url:'https://example.org/fx'}},
    enrichmentJobs:[{id:'job1',symbol:'AAA',status:'completed',details:'source evidence'}],migrationNotes:['prior note'],
    formalEvents:[{id:'old-pending',symbol:'AAA',event_type:'month_end',signal_date:'2024-12-31',config,
      state:{initialized:true,entered:false,entry_pending:true,z:.4,previous_x:.2,direction:'flat',
        alpha:1,beta:1,pending_target:1.3,current_target:null}}]};
}

test('old schema 1/2 backups retain financial data, evidence and full audit events without mutation',()=>{
  for(const version of [1,2]){
    const original=oldBackup(version),snapshot=JSON.stringify(original),upgraded=validateBackup(original);
    assert.equal(JSON.stringify(original),snapshot);assert.equal(upgraded.schemaVersion,3);
    assert.equal(upgraded.algorithm,ALGORITHM_ID);assert.equal(upgraded.formalEvents.length,0);
    assert.deepEqual(upgraded.legacyFormalEvents,original.formalEvents);
    for(const key of ['valuations','quotes','fxRates','enrichmentJobs'])assert.deepEqual(upgraded[key],original[key]);
    assert.deepEqual(upgraded.account,original.account);assert.equal(upgraded.holdings[0].market_value,1000);
    assert.throws(()=>activateFormal(upgraded,'AAA','2025-01-02','2025-03-01'),/没有正式信号/);
    const roundtrip=validateBackup(JSON.parse(exportBackup(upgraded)));
    assert.deepEqual(roundtrip,upgraded);
  }
});

test('the first v2 formal signal replays prior history, then restored pivots continue identically',()=>{
  let upgraded=validateBackup(oldBackup());
  upgraded=formalMonthEnd(upgraded,'AAA','2025-01-31','2025-03-01');
  const event=upgraded.formalEvents.at(-1);
  assert.equal(event.history_replayed,true);assert.equal(event.state.entered,true);
  assert.equal(event.state.current_target,1.75);assert.equal(event.state.pending_target,1.75);
  upgraded=activateFormal(upgraded,'AAA','2025-02-03','2025-03-01');
  upgraded.valuations.push(normalizeValuation({symbol:'AAA',valuation_date:'2025-02-28',s_tech:31}));
  const restored=validateBackup(JSON.parse(exportBackup(upgraded)));
  const resumed=formalMonthEnd(restored,'AAA','2025-02-28','2025-03-01');
  const continuous=formalMonthEnd(upgraded,'AAA','2025-02-28','2025-03-01');
  assert.deepEqual(resumed.formalEvents.at(-1).state,continuous.formalEvents.at(-1).state);
  assert.equal(resumed.formalEvents.at(-1).history_replayed,false);
  assert.deepEqual(resumed.legacyFormalEvents,oldBackup().formalEvents);
});

test('existing storage namespaces upgrade without deleting old raw data',()=>{
  for(const key of [STORAGE_KEY,LEGACY_STORAGE_KEY]){
    const original=JSON.stringify(oldBackup(key===LEGACY_STORAGE_KEY?1:2)),entries=new Map([[key,original]]);
    const store={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v)};
    const upgraded=load(store);assert.equal(upgraded.algorithm,ALGORITHM_ID);
    assert.equal(upgraded.legacyFormalEvents.length,1);
    if(key===STORAGE_KEY)assert.equal(entries.get(key),original);
    save(upgraded,store);assert.equal(load(store).legacyFormalEvents.length,1);
    if(key===LEGACY_STORAGE_KEY)assert.equal(entries.get(key),original);
  }
});

test('current v2 controller backups validate pivots and accept compatible schema 2 exports',()=>{
  const data=formalMonthEnd({...emptyData(),valuations:history()},'AAA','2024-12-31','2025-03-01');
  assert.equal(validateBackup({...data,schemaVersion:2}).formalEvents.length,1);
  const corrupt=structuredClone(data);delete corrupt.formalEvents[0].state.pivot_x;
  assert.throws(()=>validateBackup(corrupt),/pivot_x/);
  assert.equal(controllerFromLegacyRun({z:.4,entered:true,strategy_config:{rho:.9}}),null);
  assert.equal(controllerFromLegacyRun({z:.4,entered:true,strategy_config:CONFIG}),null);
});
