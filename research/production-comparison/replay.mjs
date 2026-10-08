// Calls the current production implementation; PE inputs are explicitly a diagnostic proxy.
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {CONFIG,Controller,Account,dailyCloseStep,valuationState} from '../../src/strategy.js';
import {computeTechValuation} from '../../src/valuation.js';
const here=new URL('./',import.meta.url);
const input=JSON.parse(readFileSync(new URL('input.json',here),'utf8'));
for(const asset of Object.values(input.assets))if(asset.synthetic_case){
  const {monthly_log_amplitude:amp,period_months:period}=asset.synthetic_case;
  const ps=[...Array.from({length:60},(_,i)=>100*Math.exp(.35*(i-59)/59)),
    ...Array.from({length:120},(_,i)=>100*Math.exp(amp*Math.sin(2*Math.PI*i/period)))];
  const fundamentals={eps_ttm:4,eps_ntm:5,eps_ntm_90d:4.5,revenue_ttm:100,revenue_ntm:120,
    g_revenue_2:.15,g_eps_2:.2,fcf_ttm:10,sbc_ttm:2,ni_ttm:8};
  const scores=ps.map(price=>computeTechValuation({price,...fundamentals}).s_tech);
  asset.rows=[];asset.signals=[];
  for(let i=59;i<ps.length;i++){
    const year=Math.floor((2010*12+i)/12),month=(2010*12+i)%12;
    const count=new Date(Date.UTC(year,month+1,0)).getUTCDate();
    const dates=Array.from({length:count},(_,d)=>new Date(Date.UTC(year,month,d+1))).filter(d=>d.getUTCDay()>0&&d.getUTCDay()<6);
    const growth=Math.exp(Math.log(ps[i]/ps[i-1])/dates.length);let price=ps[i-1];
    for(const dt of dates){const close=price*growth;asset.rows.push({date:dt.toISOString().slice(0,10),open:price,close});price=close;}
    asset.signals.push({month_end:dates.at(-1).toISOString().slice(0,10),x:valuationState(scores[i],scores.slice(0,i),true)});
  }
}
writeFileSync(new URL('effective-input.json',here),JSON.stringify(input));

function replay(rows,signals,{execution='open',cost=.0005,forcedStart=null}={}) {
  const cfg={...CONFIG,one_way_cost:cost},c=new Controller(cfg),a=new Account(0,-10000);
  const signalMap=new Map(signals.map(s=>[s.month_end,s]));
  let previousClose=null,previousDate=null,started=false,path=[],fees=0,interest=0,caps=0,residual=0;
  if(forcedStart){
    const prior=signals.filter(s=>s.month_end<forcedStart).at(-1);
    assert.ok(prior,'no preceding signal'); c.observeMonthEnd(prior.x,{forceEntry:true});
  }
  for(const r of rows){
    if(forcedStart&&r.date<forcedStart)continue;
    const days=previousDate?(Date.parse(r.date)-Date.parse(previousDate))/86400000:0;
    interest+=a.applyReturnAndInterest(previousClose===null?0:r.open/previousClose-1,days,cfg);
    const trade=()=>{
      c.activatePendingTarget();const before=a.equity;
      const [value,fee]=a.rebalanceTo(c.state.current_target,cfg);fees+=fee;
      residual=Math.max(residual,Math.abs(a.equity-before+fee));
      assert.ok(residual<1e-7,'trade conservation');started=true;
    };
    if(execution==='open'&&c.state.pending_target!==null)trade();
    const step=dailyCloseStep(a,{totalReturn:r.close/r.open-1,days:0,
      currentTarget:c.state.current_target,scheduledRebalance:false,cfg});
    fees+=step.fee;caps+=Number(step.hard_cap_triggered);
    if(execution==='close'&&c.state.pending_target!==null)trade();
    if(started)path.push({date:r.date,equity:a.equity,stock_weight:a.naturalLeverage,
      financing:a.financing,target:c.state.current_target,fees,interest,hard_caps:caps});
    // Consume this month's signal only AFTER its close and all trades.
    const signal=signalMap.get(r.date);if(signal)c.observeMonthEnd(signal.x);
    previousClose=r.close;previousDate=r.date;
  }
  assert.ok(path.length,'never entered');
  let peak=10000,dd=0;for(const r of path){peak=Math.max(peak,r.equity);dd=Math.min(dd,r.equity/peak-1);}
  const first=path[0].date,last=path.at(-1),years=(Date.parse(last.date)-Date.parse(first))/86400000/365.25;
  return {strategy:'PRODUCTION-PE-PROXY',start:first,end:last.date,terminal_equity:last.equity,
    cagr:(last.equity/10000)**(1/years)-1,max_drawdown:dd,fees_paid:fees,
    financing_interest:interest,hard_cap_interventions:caps,maximum_trade_residual:residual,path};
}
const output=[];let prefixChecks=0;
for(const [ticker,asset] of Object.entries(input.assets)){
  for(const options of [{tag:'proxy_entry',execution:'open'},
    {tag:'native_close',execution:'close'},
    {tag:'cost_20bp',execution:'open',cost:.002},
    {tag:'reset_2020',execution:'open',forcedStart:'2020-01-01'},
    {tag:'reset_2022',execution:'open',forcedStart:'2022-01-01'}]){
    if(ticker.startsWith('SYN-')&&options.forcedStart)continue;
    const result=replay(asset.rows,asset.signals,options);
    const cutoff=result.path[Math.floor(result.path.length*.6)].date;
    const prefix=replay(asset.rows.filter(r=>r.date<=cutoff),asset.signals,options);
    assert.deepEqual(prefix.path,result.path.filter(r=>r.date<=cutoff));prefixChecks++;
    output.push({suite:ticker,...options,cost:options.cost??.0005,...result});
  }
}
writeFileSync(new URL('production-paths.json',here),JSON.stringify({config:CONFIG,prefixChecks,results:output}));
console.log(JSON.stringify({runs:output.length,prefixChecks}));
