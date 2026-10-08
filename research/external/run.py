"""Unchanged candidates on a predeclared held-out asset universe."""
import csv
import gzip
import hashlib
import json
import sys
from pathlib import Path
import numpy as np

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'v2'))
from engine import replay
from fixed_leverage import FixedLeverage

protocol=json.loads((HERE/'protocol.json').read_text(encoding='utf-8'))
frozen=json.loads((HERE/'frozen.json').read_text(encoding='utf-8'))
definitions=json.loads((HERE/'retained-candidates.json').read_text(encoding='utf-8'))['candidates']
data=json.loads((HERE/'prices.json').read_text(encoding='utf-8'))
audit=json.loads((HERE/'data-audit.json').read_text(encoding='utf-8'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for name,path in [('protocol_sha256',HERE/'protocol.json'),('candidate_sha256',HERE/'retained-candidates.json'),
                  ('engine_sha256',HERE.parent/'v2/engine.py'),('benchmark_sha256',HERE.parent/'v2/fixed_leverage.py')]:
    assert sha(path)==frozen[name],name
assert sha(HERE/'prices.json')==audit['normalized_prices_sha256']
assert not audit['missing_predeclared_assets']
suites={t:[t] for t in protocol['single_assets']};suites.update(protocol['baskets'])
common_dates=set.intersection(*[{r['date'] for r in data[t]} for t in protocol['single_assets']])
primary_end=min(protocol['intended_common_end'],max(common_dates))
extension_end=min(protocol['request_complete_through'],max(common_dates))
segments={'primary':(protocol['primary_start'],primary_end),
          'full_history':('1900-01-01',primary_end),
          'validation_2014_2019':('2014-01-01','2019-12-31'),
          'late_2020_onward':('2020-01-01',primary_end)}
arrays={};controls={}
checks=[]


def inputs(suite,start,end):
    key=(suite,start,end)
    if key in arrays:return arrays[key]
    maps=[{r['date']:r for r in data[t]} for t in suites[suite]]
    dates=[r['date'] for r in data[suites[suite][0]] if start<=r['date']<=end and all(r['date'] in m for m in maps)]
    if not dates:return [],[],[]
    anchors=[m[dates[0]]['open'] for m in maps]
    op=[sum(m[dt]['open']/anchors[i] for i,m in enumerate(maps))/len(maps) for dt in dates]
    cl=[sum(m[dt]['close']/anchors[i] for i,m in enumerate(maps))/len(maps) for dt in dates]
    arrays[key]=(dates,op,cl)
    return arrays[key]


def get_control(suite,start,end,cost):
    key=(suite,start,end,cost)
    if key not in controls:
        dates,op,cl=inputs(suite,start,end);model=FixedLeverage(dates,op,cl,cost=cost)
        expected=10000/(1+cost)*np.asarray(cl)/op[0]
        peak=np.maximum.accumulate(np.maximum(expected,10000))
        check=model.path(1)
        assert abs(check['terminal_equity']/expected[-1]-1)<1e-10
        assert abs(check['max_drawdown']-np.min(expected/peak-1))<1e-10
        checks.append({'suite':suite,'start':dates[0],'end':dates[-1],'cost':cost,'one_x_buy_hold_verified':True})
        controls[key]=model
    return controls[key]


def evaluate(suite,tag,d,start,end,cost=.0005,delay=0,path=False):
    dates,op,cl=inputs(suite,start,end)
    result=replay(d,dates,op,cl,cost=cost,extra_delay=delay,retain_path=path)
    model=get_control(suite,start,end,cost);match=model.match(result['terminal_equity'])
    result.update(suite=suite,tickers=suites[suite],tag=tag,cost=cost,extra_signal_delay=delay)
    if match:
        result.update(match)
        worse=match['fixed_max_drawdown']-result['max_drawdown']
        result.update(candidate_worse_drawdown_by=worse,status='reject' if worse>1e-10 else 'pass')
    else:
        solvent=[(l,p) for l in model.grid if (p:=model.path(l)) is not None]
        best_l,best=max(solvent,key=lambda pair:pair[1]['terminal_equity'])
        result.update(status='unmatched',max_sampled_fixed_equity=best['terminal_equity'],
                      max_sampled_fixed_leverage=float(best_l),
                      candidate_above_sampled_fixed_max=result['terminal_equity']>best['terminal_equity'])
    return result


required=[];stress=[];cohorts=[];daily=[];probes=[]
for tag,(start,end) in segments.items():
    for suite in suites:
        for d in definitions:
            r=evaluate(suite,tag,d,start,end,path=tag=='primary')
            if tag=='primary':daily.extend({'suite':suite,'strategy':d['id'],**row} for row in r['path'])
            r.pop('path');required.append(r)
    print('Held-out required segment complete:',tag,flush=True)

for tag in ['primary','full_history']:
    start,end=segments[tag]
    for suite in suites:
        for d in definitions:
            for name,cost,delay in [('cost_20bp',.002,0),('extra_session_delay',.0005,1)]:
                r=evaluate(suite,tag,d,start,end,cost,delay);r.pop('path');r['stress']=name;stress.append(r)
    print('Held-out cost/delay stress complete:',tag,flush=True)

for suite in suites:
    for year in range(2000,2022):
        start,end=f'{year}-01-01',f'{year+4}-12-31';dates,op,cl=inputs(suite,start,end)
        if not dates or dates[0][:7]!=f'{year}-01' or dates[-1][:7]!=f'{year+4}-12':continue
        for d in definitions:
            r=evaluate(suite,'five_year_cohort',d,start,end);r.pop('path');r['cohort_year']=year;cohorts.append(r)
    print('All eligible held-out cohorts complete:',suite,flush=True)

prefix_checks=[];close_leakage_checks=[]
for suite in suites:
    dates,op,cl=inputs(suite,protocol['primary_start'],primary_end)
    for d in definitions:
        a=replay(d,dates[:90],op[:90],cl[:90],retain_path=True)
        b=replay(d,dates[:57],op[:57],cl[:57],retain_path=True)
        assert a['path'][:57]==b['path'];prefix_checks.append(suite+'/'+d['id'])
        altered=cl[:90].copy();altered[42]*=1.8
        c=replay(d,dates[:90],op[:90],altered,retain_path=True)
        assert a['path'][42]['units']==c['path'][42]['units'];close_leakage_checks.append(suite+'/'+d['id'])
        if extension_end>primary_end:
            long_dates,long_op,long_cl=inputs(suite,protocol['primary_start'],extension_end)
            short=replay(d,dates,op,cl,retain_path=True)
            long=replay(d,long_dates,long_op,long_cl,retain_path=True)
            assert long['path'][:len(dates)]==short['path']
            boundary=short['path'][-1]['equity'];tail=long['path'][len(dates):]
            running=np.maximum.accumulate(np.maximum([p['equity'] for p in tail],boundary))
            probe={'suite':suite,'strategy':d['id'],'start':tail[0]['date'],'end':tail[-1]['date'],'sessions':len(tail),
                   'continuous_state':True,'return':long['terminal_equity']/boundary-1,
                   'max_drawdown_since_prior_cutoff':float(np.min(np.array([p['equity'] for p in tail])/running-1)),
                   'scope':'Short retrospective unseen-time extension, not prospective performance'}
            main=next(r for r in required if r['suite']==suite and r['strategy']==d['id'] and r['tag']=='primary')
            if 'fixed_leverage' in main:
                l=main['fixed_leverage'];model=get_control(suite,protocol['primary_start'],extension_end,.0005)
                trade_eq=model.trade_equities(l);debt=model.debt_factor if l>1 else 1.
                nav=trade_eq[model.last]*(l*model.close_g+(1-l)*debt)
                assert abs(nav[len(dates)-1]/boundary-1)<1e-10
                probe.update(precutoff_matched_fixed_leverage=l,
                             fixed_return=float(nav[-1]/nav[len(dates)-1]-1),
                             relative_extension_return=long['terminal_equity']/boundary-1-(nav[-1]/nav[len(dates)-1]-1))
            probes.append(probe)

decisions=[]
for d in definitions:
    rr=[r for r in required if r['strategy']==d['id']]
    ss=[r for r in stress if r['strategy']==d['id']]
    cc=[r for r in cohorts if r['strategy']==d['id']]
    per_asset=[]
    for suite in suites:
        scoped=[r for r in rr+ss if r['suite']==suite]
        per_asset.append({'suite':suite,'passed':sum(r['status']=='pass' for r in scoped),'checks':len(scoped),
                          'unmatched':sum(r['status']=='unmatched' for r in scoped),
                          'all_required_and_stress_passed':all(r['status']=='pass' for r in scoped)})
    decisions.append({'strategy':d['id'],'primary_passed':sum(r['status']=='pass' for r in rr if r['tag']=='primary'),
                      'primary_checks':len(suites),'full_history_passed':sum(r['status']=='pass' for r in rr if r['tag']=='full_history'),
                      'required_passed':sum(r['status']=='pass' for r in rr),'required_checks':len(rr),
                      'required_unmatched':sum(r['status']=='unmatched' for r in rr),
                      'stress_passed':sum(r['status']=='pass' for r in ss),'stress_checks':len(ss),
                      'cohort_passed':sum(r['status']=='pass' for r in cc),'cohort_checks':len(cc),
                      'cohort_unmatched':sum(r['status']=='unmatched' for r in cc),
                      'negative_return_cohorts':sum(r['cagr']<0 for r in cc),
                      'universal_pass':all(r['status']=='pass' for r in rr+ss),'per_asset':per_asset})

save=lambda name,v:(HERE/name).write_text(json.dumps(v,ensure_ascii=False,indent=2),encoding='utf-8')
save('results.json',{'protocol':protocol,'actual_primary_end':primary_end,'extension_end':extension_end,
                     'suites':suites,'required':required,'stress':stress,'decisions':decisions})
save('cohorts.json',cohorts);save('time-extension.json',probes)
with gzip.open(HERE/'daily-primary.csv.gz','wt',encoding='utf-8',newline='') as f:
    writer=csv.DictWriter(f,fieldnames=['suite','strategy','date','equity','stock_weight','cash','fees','units']);writer.writeheader();writer.writerows(daily)
save('verification.json',{'one_x_buy_hold_checks':checks,'prefix_invariance_checks':prefix_checks,
                         'no_today_close_leakage_checks':close_leakage_checks,
                         'maximum_self_financing_currency_residual':max(r['maximum_cash_conservation_residual'] for r in required+stress+cohorts),
                         'maximum_equal_return_relative_terminal_error':max(r.get('relative_terminal_matching_error',0) for r in required+stress+cohorts),
                         'parameters_and_implementation_unchanged':True,
                         'input_and_source_hashes':{'prices':sha(HERE/'prices.json'),'runner':sha(HERE/'run.py'),
                                                    'engine':sha(HERE.parent/'v2/engine.py'),'benchmark':sha(HERE.parent/'v2/fixed_leverage.py')}})
save('research-status.json',{'retained_research_candidates':definitions,
                           'accepted_universal_candidates':[d for d in definitions if next(r for r in decisions if r['strategy']==d['id'])['universal_pass']],
                           'all_failures_kept':True,'winning_assets_not_selected_as_deployment_universe':True})
print(json.dumps([{k:r[k] for k in ['strategy','primary_passed','primary_checks','full_history_passed','required_passed','required_checks','required_unmatched','stress_passed','stress_checks','cohort_passed','cohort_checks','universal_pass']} for r in decisions],indent=2))
