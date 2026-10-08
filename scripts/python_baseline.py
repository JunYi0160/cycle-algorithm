"""Produce public synthetic numerical fixtures from the current Python engine."""
import argparse
import calendar
import hashlib
import json
import random
import sys
from dataclasses import asdict
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--engine', type=Path, default=Path(__file__).resolve().parents[2] / 'engine')
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'tests/fixtures/python-baseline.json')
args = parser.parse_args()
sys.path.insert(0, str(args.engine.resolve()))
from core.strategy import CFG, ControllerState, ValuationLeverageController, Account, daily_close_step, envelope, shape, valuation_state
from valuation_formula import TechValuationInput, compute_tech_valuation
from strategy_preview import build_monthly_scores, compute_preview

rng = random.Random(42)
paths = [[.5,.3,.299,.2,.55,.1,.75,.25,.25,.4], [.2,0,.4,1,.6,0,1], [.2,.4], [.2,0,.4],
         [.1,.1+1e-13,.1-1e-13,.9,1,.2], [1,.9,.8], [0,1,0,1]]
paths += [[rng.randrange(0,60)/59 for _ in range(120)] for _ in range(12)]
controllers=[]
for path in paths:
    ctl=ValuationLeverageController()
    steps=[]
    for x in path:
        target=ctl.observe_month_end(x)
        observed=asdict(ctl.state)
        activated=ctl.activate_pending_target()
        steps.append({'x':x,'target':target,'observed':observed,'activated':activated,'state':asdict(ctl.state)})
    controllers.append({'steps':steps})
initial=ControllerState(initialized=True,entered=True,z=.4,previous_x=.2,direction='up',alpha=.7,beta=.8,pivot_x=.2,pivot_z=.4,current_target=1.3)
restored=ValuationLeverageController();restored.state=initial
restored_initial=asdict(initial)
restored_target=restored.observe_month_end(.3)
percentiles=[]
for history,current,higher in [(list(range(1,60)),60,True),([5]*59,5,True),([5]*59,6,True),([5]*59,4,True),
                               (list(range(80)),60,True),(list(range(1,60)),0,False)]:
    percentiles.append({'history':history,'current':current,'higher':higher,'expected':valuation_state(current,history,higher_is_cheaper=higher)})
accounts=[]
for a,b,target,ret,days,scheduled in [(15000,3000,1.5,0,1,True),(17500,7500,1.75,-.30,1,False),
    (10000,-1000,1.2,.02,30,False),(10000,5000,1.0,0,0,True)]:
    account=Account(a,b)
    result=daily_close_step(account,total_return=ret,days=days,current_target=target,scheduled_rebalance=scheduled)
    accounts.append({'input':{'a':a,'b':b,'target':target,'ret':ret,'days':days,'scheduled':scheduled},'result':result,
                     'stock_value':account.stock_value,'financing':account.financing})
valuation_inputs=[]
base=dict(price=100,eps_ttm=4,eps_ntm=5,eps_ntm_90d=4.5,revenue_ttm=100,revenue_ntm=120,g_revenue_2=.15,g_eps_2=.20,fcf_ttm=10,sbc_ttm=2,ni_ttm=8)
for changes in [{},{'eps_ntm':0},{'eps_ttm':0},{'sbc_ttm':20},{'fcf_ttm':40},{'g_eps_2':-.2}, {'revenue_ntm':-400}]:
    inp={**base,**changes};valuation_inputs.append({'input':inp,'result':asdict(compute_tech_valuation(TechValuationInput(**inp)))})
previews=[]
for variant in ['normal','fallback','short']:
    rows=[]
    for i in range(75 if variant!='short' else 40):
        if i in [21,32]:continue
        year,month=divmod(2020*12+i,12);month+=1
        d=f'{year:04d}-{month:02d}-{calendar.monthrange(year,month)[1]:02d}'
        score=(5+i*.03+rng.random()) if variant!='fallback' else 100-i
        rows.append({'valuation_date':d,'status':'valid','s_tech':score})
    rows.append({'valuation_date':'2027-01-31','status':'valid','s_tech':999})
    coverage,scores=build_monthly_scores(rows,symbol='DEMO',name='DEMO',as_of='2026-10-08')
    previews.append({'rows':rows,'as_of':'2026-10-08','coverage':coverage.asdict(),
                     'scores':[asdict(r) for r in scores],'preview':compute_preview(coverage,scores) if coverage.ready else None})
files=['core/strategy.py','core/config.json','strategy_preview.py','valuation_formula.py','portfolio_strategy.py']
result={'source_sha256':{f:hashlib.sha256((args.engine/f).read_bytes()).hexdigest() for f in files},
        'config':asdict(CFG),'controllers':controllers,'restored':{'initial':restored_initial,'x':.3,'target':restored_target,'state':asdict(restored.state)},
        'shapes':[{'u':i/100,'shape':shape(i/100),'envelope':envelope(i/100)} for i in range(101)],
        'percentiles':percentiles,'accounts':accounts,'valuations':valuation_inputs,'previews':previews}
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'Wrote synthetic Python baseline: {args.output}; {sum(len(c["steps"]) for c in controllers)} controller steps')
