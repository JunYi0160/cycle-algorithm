"""One fixed batch, chronological replays, no selection of parameter neighbors."""
import copy
import csv
import gzip
import hashlib
import json
from pathlib import Path
from engine import replay
from fixed_leverage import FixedLeverage

HERE=Path(__file__).resolve().parent
spec=json.loads((HERE/'spec.json').read_text(encoding='utf-8'))
data=json.loads((HERE.parent/'historical/prices.json').read_text(encoding='utf-8'))
definitions=spec['candidates']
suites={t:[t] for t in ['QQQ','SMH','NVDA','GOOG','MSFT']}
suites.update(TECH3=['NVDA','GOOG','MSFT'],ETF2=['QQQ','SMH'])
controls={};arrays={}
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
frozen={'spec_sha256':sha(HERE/'spec.json'),'price_input_sha256':sha(HERE.parent/'historical/prices.json'),
        'source_sha256':{p.name:sha(p) for p in HERE.glob('*.py')},'parameter_search_performed':False,
        'all_market_histories_seen_in_prior_runs':True}
(HERE/'frozen-run.json').write_text(json.dumps(frozen,indent=2),encoding='utf-8')


def inputs(suite,start,end):
    key=(suite,start,end)
    if key in arrays:return arrays[key]
    maps=[{r['date']:r for r in data[t]} for t in suites[suite]]
    dates=[r['date'] for r in data[suites[suite][0]] if start<=r['date']<=end and all(r['date'] in m for m in maps)]
    anchors=[m[dates[0]]['open'] for m in maps]
    op=[sum(m[dt]['open']/anchors[i] for i,m in enumerate(maps))/len(maps) for dt in dates]
    cl=[sum(m[dt]['close']/anchors[i] for i,m in enumerate(maps))/len(maps) for dt in dates]
    arrays[key]=(dates,op,cl)
    return arrays[key]


def evaluate(suite,tag,definition,start,end,cost=.0005,frequency='monthly',delay=0,path=False):
    dates,op,cl=inputs(suite,start,end)
    result=replay(definition,dates,op,cl,cost=cost,frequency=frequency,extra_delay=delay,retain_path=path)
    key=(suite,start,end,cost)
    if key not in controls:controls[key]=FixedLeverage(dates,op,cl,cost=cost)
    match=controls[key].match(result['terminal_equity'])
    result.update(suite=suite,tag=tag,cost=cost,frequency=frequency,extra_signal_delay=delay)
    if match:
        result.update(match)
        improvement=match['fixed_max_drawdown']-result['max_drawdown']
        result.update(candidate_worse_drawdown_by=improvement,status='reject' if improvement>1e-10 else 'pass')
    else:result.update(status='unmatched')
    return result


required=[];stress=[];neighbors=[];cohorts=[];daily=[]
# Inspect development outputs first, but there is no fitting or change before later phases.
for tag in ['development_replay','validation_replay','late_replay','primary','full_history']:
    start,end=spec['required_segments'][tag]
    for suite in suites:
        for d in definitions:
            result=evaluate(suite,tag,d,start,end,path=tag=='primary')
            if tag=='primary':
                daily.extend({'suite':suite,'strategy':d['id'],**row} for row in result['path'])
            result.pop('path');required.append(result)
    print('Required segment complete:',tag,flush=True)

for tag in ['primary','full_history']:
    start,end=spec['required_segments'][tag]
    for suite in suites:
        for d in definitions:
            for name,cost,frequency,delay in [('cost_20bp',.002,'monthly',0),('extra_session_delay',.0005,'monthly',1),('daily',.0005,'daily',0)]:
                r=evaluate(suite,tag,d,start,end,cost,frequency,delay);r.pop('path');r['stress']=name;stress.append(r)
            alternatives=[]
            if d['family']=='peak_power':
                for shift in [-.05,.05]:
                    n=copy.deepcopy(d);n['alpha']+=shift;alternatives.append(('alpha',n))
            else:
                for multiplier in [.8,1.2]:
                    n=copy.deepcopy(d);n['target']*=multiplier;alternatives.append(('target',n))
                for half_life in [32,126]:
                    n=copy.deepcopy(d);n['half_life']=half_life;alternatives.append(('half_life',n))
            for parameter,n in alternatives:
                r=evaluate(suite,tag,n,start,end);r.pop('path');r.update(neighbor_parameter=parameter,neighbor_definition=n);neighbors.append(r)
    print('Stress and frozen parameter neighborhoods complete:',tag,flush=True)

for suite in suites:
    for year in range(2000,2022):
        start,end=f'{year}-01-01',f'{year+4}-12-31'
        dates,op,cl=inputs(suite,start,end)
        if not dates or dates[0][:7]!=f'{year}-01' or dates[-1][:7]!=f'{year+4}-12':continue
        for d in definitions:
            r=evaluate(suite,'five_year_cohort',d,start,end);r.pop('path');r['cohort_year']=year;cohorts.append(r)
    print('All eligible five-year cohorts complete:',suite,flush=True)

# The exact same earlier ledger must result when future input is removed or changed.
prefix_checks=[];no_today_close_checks=[]
for suite in suites:
    dates,op,cl=inputs(suite,'2010-01-01','2026-09-04')
    for d in definitions:
        long=replay(d,dates[:90],op[:90],cl[:90],retain_path=True)
        short=replay(d,dates[:57],op[:57],cl[:57],retain_path=True)
        assert long['path'][:57]==short['path']
        prefix_checks.append(suite+'/'+d['id'])
        altered=cl[:90].copy();altered[42]*=1.8
        new=replay(d,dates[:90],op[:90],altered,retain_path=True)
        assert long['path'][42]['units']==new['path'][42]['units']
        no_today_close_checks.append(suite+'/'+d['id'])

decisions=[]
for d in definitions:
    rr=[r for r in required if r['strategy']==d['id']]
    ss=[r for r in stress if r['strategy']==d['id']]
    nn=[r for r in neighbors if r['strategy']==d['id']]
    core=[r for r in rr if r['tag'] in ['primary','full_history']]
    asset_results=[]
    for suite in suites:
        scoped=[r for r in rr+ss+nn if r['suite']==suite]
        asset_results.append({'suite':suite,'required_passed':sum(r['status']=='pass' for r in scoped),
                              'checks':len(scoped),'all_checks_passed':all(r['status']=='pass' for r in scoped)})
    decisions.append({'strategy':d['id'],'primary_full_passed':sum(r['status']=='pass' for r in core),'primary_full_checks':len(core),
                      'all_required_passed':all(r['status']=='pass' for r in rr),'required_passed':sum(r['status']=='pass' for r in rr),
                      'required_checks':len(rr),'stress_passed':sum(r['status']=='pass' for r in ss),'stress_checks':len(ss),
                      'neighbors_passed':sum(r['status']=='pass' for r in nn),'neighbor_checks':len(nn),
                      'robust_universal_pass':all(r['status']=='pass' for r in rr+ss+nn),'per_asset_robustness':asset_results})
save=lambda name,value:(HERE/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
save('results.json',{'spec':spec,'required':required,'stress':stress,'neighbors':neighbors,'decisions':decisions})
save('cohorts.json',cohorts)
save('selected.json',{'universal_candidates':[d for d in definitions if next(x for x in decisions if x['strategy']==d['id'])['robust_universal_pass']],
                      'research_candidates_passing_required_segments':[d for d in definitions if next(x for x in decisions if x['strategy']==d['id'])['all_required_passed']],
                      'per_asset_results':[{k:r[k] for k in ['strategy','per_asset_robustness']} for r in decisions],
                      'do_not_select_parameter_neighbors':True})
with gzip.open(HERE/'daily-primary.csv.gz','wt',encoding='utf-8',newline='') as f:
    writer=csv.DictWriter(f,fieldnames=['suite','strategy','date','equity','stock_weight','cash','fees','units']);writer.writeheader();writer.writerows(daily)
save('verification.json',{'prefix_invariance_passed':prefix_checks,'today_close_cannot_change_today_units':no_today_close_checks,
                         'maximum_cash_conservation_residual':max(r['maximum_cash_conservation_residual'] for r in required+stress+neighbors+cohorts),
                         'maximum_equal_terminal_matching_error':max(r.get('relative_terminal_matching_error',0) for r in required+stress+neighbors+cohorts),
                         'spec_unchanged_after_run':sha(HERE/'spec.json')==frozen['spec_sha256']})
print(json.dumps(decisions,ensure_ascii=False,indent=2))
