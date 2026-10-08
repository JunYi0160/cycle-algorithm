// Fixed synthetic scenarios, not a market backtest or a parameter search.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONFIG,Controller,Account,dailyCloseStep,valuationState} from '../src/strategy.js';
import {computeTechValuation} from '../src/valuation.js';
import {Controller as LegacyController} from '../tests/fixtures/strategy-v1.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fundamentals={eps_ttm:4,eps_ntm:5,eps_ntm_90d:4.5,revenue_ttm:100,revenue_ntm:120,
  g_revenue_2:.15,g_eps_2:.2,fcf_ttm:10,sbc_ttm:2,ni_ttm:8};
const weekday=d=>d.getUTCDay()>0&&d.getUTCDay()<6;

export function simulate(prices,ControllerType=Controller,fixedLeverage=null){
  const scores=prices.map(price=>computeTechValuation({price,...fundamentals}).s_tech);
  const c=new ControllerType(),account=new Account();
  let entry=null,peak=1,drawdown=0,fees=0,interest=0,turnover=0,caps=0;
  const samples=[];
  for(let i=59;i<prices.length;i++){
    const year=Math.floor((2010*12+i)/12),month=(2010*12+i)%12;
    const count=new Date(Date.UTC(year,month+1,0)).getUTCDate();
    const dates=Array.from({length:count},(_,d)=>new Date(Date.UTC(year,month,d+1))).filter(weekday);
    let prior=new Date(Date.UTC(year,month,0));while(!weekday(prior))prior=new Date(prior.getTime()-86400000);
    const dailyReturn=Math.exp(Math.log(prices[i]/prices[i-1])/dates.length)-1;
    dates.forEach((closingDate,dayIndex)=>{
      if(c.state.entered){
        const out=dailyCloseStep(account,{totalReturn:dailyReturn,days:(closingDate-prior)/86400000,
          currentTarget:fixedLeverage??c.state.current_target,scheduledRebalance:false});
        interest+=out.interest;fees+=out.fee;turnover+=Math.abs(out.trade);caps+=Number(out.hard_cap_triggered);
        peak=Math.max(peak,account.equity);drawdown=Math.min(drawdown,account.equity/peak-1);
      }
      // Previous month's signal activates AFTER this close's return and interest.
      if(dayIndex===0&&c.state.pending_target!==null){
        c.activatePendingTarget();
        const [trade,fee]=account.rebalanceTo(fixedLeverage??c.state.current_target);
        fees+=fee;turnover+=Math.abs(trade);
        peak=Math.max(peak,account.equity);drawdown=Math.min(drawdown,account.equity/peak-1);
      }
      prior=closingDate;
    });
    const x=valuationState(scores[i],scores.slice(0,i),true),target=c.observeMonthEnd(x);
    if(target!==null&&entry===null)entry=i;
    samples.push({month_index:i,x,equity:account.equity,signal_target:target});
  }
  return {signal_entry_index:entry,terminal_equity:account.equity,net_return:account.equity-1,
    max_drawdown:drawdown,financing_interest:interest,transaction_fees:fees,
    gross_turnover:turnover,hard_cap_interventions:caps,samples};
}

function pricesFor(amplitude,period){
  return [...Array.from({length:60},(_,i)=>100*Math.exp(.35*(i-59)/59)),
    ...Array.from({length:120},(_,i)=>100*Math.exp(amplitude*Math.sin(2*Math.PI*i/period)))];
}

export function makeReport(){
  const scenarios=[['wide_slow',.35,24],['wide_fast',.35,12],['small_fast',.025,6],['very_small_slow',.005,24]];
  const rows=scenarios.map(([scenario,amplitude,period])=>{
    const prices=pricesFor(amplitude,period);
    const runs={legacy_v1:simulate(prices,LegacyController),pivot_v2:simulate(prices),
      unlevered:simulate(prices,Controller,1),fixed_1_75:simulate(prices,Controller,1.75)};
    assert.equal(new Set(Object.values(runs).map(r=>r.signal_entry_index)).size,1);
    const prefix=simulate(prices.slice(0,120));
    assert.deepEqual(prefix.samples,runs.pivot_v2.samples.slice(0,prefix.samples.length));
    return {scenario,monthly_log_amplitude:amplitude,period_months:period,month_count:prices.length,
      results:Object.fromEntries(Object.entries(runs).map(([name,{samples,...summary}])=>[name,summary]))};
  });
  const files=['src/strategy.js','src/valuation.js','tests/fixtures/strategy-v1.mjs','scripts/validate-oscillation.mjs'];
  return {kind:'synthetic_intent_validation_not_historical_backtest',config:CONFIG,
    timing:'month-end signal, next month first weekday close; weekday prices, calendar-day interest, no exchange holidays',
    source_sha256:Object.fromEntries(files.map(p=>[p,createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex')])),scenarios:rows};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const index=process.argv.indexOf('--output'),output=resolve(index>=0?process.argv[index+1]:resolve(root,'docs/oscillation-v2-report.json'));
  const report=makeReport();mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output,scenarios:report.scenarios.map(row=>({name:row.scenario,
    old_return:row.results.legacy_v1.net_return,new_return:row.results.pivot_v2.net_return,
    new_drawdown:row.results.pivot_v2.max_drawdown}))},null,2));
}
