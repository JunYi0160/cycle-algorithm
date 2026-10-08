import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CONFIG,Controller,Account,shape,envelope,valuationState,dailyCloseStep} from '../src/strategy.js';
import {computeTechValuation} from '../src/valuation.js';
import {buildMonthlyScores,computePreview} from '../src/preview.js';
const baseline=JSON.parse(readFileSync(new URL('./fixtures/python-baseline.json',import.meta.url),'utf8'));
function compare(actual,expected,path=''){
  if(typeof expected==='number'){assert.equal(typeof actual,'number',path);assert.ok(Math.abs(actual-expected)<=1e-12*Math.max(1,Math.abs(expected)),`${path}: ${actual} != ${expected}`);}
  else if(Array.isArray(expected)){assert.equal(actual.length,expected.length,path);expected.forEach((v,i)=>compare(actual[i],v,path+'/'+i));}
  else if(expected&&typeof expected==='object'){for(const [k,v] of Object.entries(expected))compare(actual[k],v,path+'/'+k);}
  else assert.equal(actual,expected,path);
}
test('fixtures refer to the current original Python source when it is present',()=>{
  for(const [file,hash] of Object.entries(baseline.source_sha256)){
    const path=fileURLToPath(new URL('../../engine/'+file,import.meta.url));
    if(existsSync(path))assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),hash,`Regenerate baseline: ${file}`);
  }
  assert.deepEqual(CONFIG,baseline.config);
});
test('strict percentile ties, orientation and last 59 observations match Python',()=>{
  for(const p of baseline.percentiles)compare(valuationState(p.current,p.history,p.higher),p.expected);
  assert.throws(()=>valuationState(1,[1]));assert.throws(()=>valuationState(Infinity,Array(59).fill(1)));
});
test('101 curve and envelope points match Python',()=>{for(const p of baseline.shapes){compare(shape(p.u),p.shape);compare(envelope(p.u),p.envelope);}});
test('controller entry, pending/activation, turns, endpoints and 1,000+ path steps match Python',()=>{
  for(const path of baseline.controllers){const c=new Controller();for(const step of path.steps){
    compare(c.observeMonthEnd(step.x),step.target);compare(c.state,step.observed);compare(c.activatePendingTarget(),step.activated);compare(c.state,step.state);
  }}
});
test('restoring the entire controller retains reversal pivots and paths',()=>{
  const p=baseline.restored,c=new Controller(CONFIG,p.initial);compare(c.observeMonthEnd(p.x),p.target);compare(c.state,p.state);
  const waiting=new Controller();waiting.observeMonthEnd(.2);const before=structuredClone(waiting.state);
  waiting.observeMonthEnd(.1);assert.deepEqual(waiting.state,before);
});
test('same current x has different leverage after a non-extreme historical reversal',()=>{
  const finish=path=>{const c=new Controller();for(const x of path){c.observeMonthEnd(x);c.activatePendingTarget();}return c.state.current_target;};
  assert.notEqual(finish([.2,.4]),finish([.2,.7,.4]));
  assert.throws(()=>new Controller(CONFIG,{...baseline.restored.initial,pivot_x:null}),/反转锚点/);
  assert.throws(()=>new Controller(CONFIG,{...baseline.restored.initial,pivot_z:1.1}),/反转锚点/);
});
test('interest, scheduled trades, cap trigger and exact fees match Python',()=>{
  for(const sample of baseline.accounts){const p=sample.input,a=new Account(p.a,p.b);
    compare(dailyCloseStep(a,{totalReturn:p.ret,days:p.days,currentTarget:p.target,scheduledRebalance:p.scheduled}),sample.result);
    compare(a.stockValue,sample.stock_value);compare(a.financing,sample.financing);}
});
test('fundamental scoring and N/A results match Python',()=>{
  for(const p of baseline.valuations){const actual=computeTechValuation(p.input);if(p.result.status==='na')assert.equal(actual.status,'na');else compare(actual,p.result);}
  assert.throws(()=>computeTechValuation({...baseline.valuations[0].input,price:''}));
});
test('historical interpolation, entry/fallback and complete preview points match Python',()=>{
  for(const p of baseline.previews){const {coverage,scores}=buildMonthlyScores(p.rows,{symbol:'DEMO',asOf:p.as_of});
    for(const k of Object.keys(p.coverage).filter(k=>k!=='reason'))compare(coverage[k],p.coverage[k],k);
    compare(scores,p.scores);if(p.preview){const preview=computePreview(coverage,scores);compare(preview.points,p.preview.points);compare(preview.latest,p.preview.latest);compare(preview.entry.x,p.preview.entry.x);assert.equal(preview.entry.fallback,p.preview.entry.fallback);}
    else assert.throws(()=>computePreview(coverage,scores));
  }
});
