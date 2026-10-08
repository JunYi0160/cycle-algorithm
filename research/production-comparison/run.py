"""Paired diagnostic: production controller with legacy PE rank vs frozen candidates."""
import csv,hashlib,json,subprocess,sys
from pathlib import Path
import numpy as np
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
sys.path.insert(0,str(HERE.parent/'v2'))
from engine import replay
from fixed_leverage import FixedLeverage
OLD=Path(r'C:\Users\jun\Documents\Codex\2026-09-09\referenced-chatgpt-conversation-this-is-an\outputs\nvda-goog-msft-validation')
prices=json.loads((HERE.parent/'historical/prices.json').read_text())
definitions=json.loads((HERE.parent/'external/retained-candidates.json').read_text())['candidates']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assets={};sources={}
for ticker in ['NVDA','GOOG','MSFT']:
    p=OLD/f'{ticker}_valuation_signals.csv'
    with p.open(encoding='utf-8-sig') as f: signals=list(csv.DictReader(f))
    assert all(s['latest_eps_filing']<=s['month_end'] for s in signals)
    assets[ticker]={'rows':[r for r in prices[ticker] if r['date']<='2026-09-04'],
      'signals':[{'month_end':s['month_end'],'x':1-float(s['x'])} for s in signals]}
    sources[ticker]={'signal_path':str(p),'sha256':sha(p),'rows':len(signals),
                    'warning':'Legacy PE, not verified consecutive-quarter TTM, not S_Tech'}
# Reuse all four pre-existing synthetic scenarios, including the unfavorable tiny cycle.
# Fixed fundamental inputs imply S_Tech=C/P exactly, so rank can be computed from prices.
synthetic=json.loads((ROOT/'docs/oscillation-v2-report.json').read_text())
assert synthetic['source_sha256']['src/strategy.js']==sha(ROOT/'src/strategy.js')
for case in synthetic['scenarios']:
    name='SYN-'+case['scenario']
    # Generate quotes and genuine synthetic S_Tech with the production JS math.
    assets[name]={'synthetic_case':case}
protocol={'comparison':'Same entry/exit dates, costs, execution quote and price index; equal-return drawdown',
  'scope':'Three previously examined technology stocks; diagnostic proxy, not production S_Tech performance or held-out test',
  'synthetic_scope':'All four existing fixed-fundamental sinusoidal scenarios reused without tuning. S_Tech=C/P, no market-data claim.',
  'production_parameters_changed':False,'source_sha256':{str(p.relative_to(ROOT)):sha(p) for p in
    [ROOT/'src/strategy.js',ROOT/'src/valuation.js',HERE.parent/'v2/engine.py',HERE.parent/'v2/fixed_leverage.py',
     HERE.parent/'historical/prices.json',HERE.parent/'external/retained-candidates.json',ROOT/'docs/oscillation-v2-report.json']},
  'signals':sources,'execution':'Primary previous month-end signal to next trading-day open. Native-close sensitivity explicitly separate.',
  'forced_resets':'2020 and 2022 reset all portfolios, force production entry from latest previously known monthly proxy. Not default entry-gate performance.',
  'hard_cap':'Production 2.25x cap kept, tested at close and reduced to current target at close. Fixed leverage has no cap.',
  'benchmark':'Same monthly fixed leverage 0x-3x, 5.3% annual borrow, minimum solvent matching root'}
(HERE/'protocol.json').write_text(json.dumps(protocol,indent=2),encoding='utf-8')
(HERE/'input.json').write_text(json.dumps({'assets':assets}),encoding='utf-8')
subprocess.run(['node',str(HERE/'replay.mjs')],check=True,cwd=ROOT)
assets=json.loads((HERE/'effective-input.json').read_text())['assets']
production=json.loads((HERE/'production-paths.json').read_text())
results=[];one_x_checks=0
for p in production['results']:
    rows=[r for r in assets[p['suite']]['rows'] if p['start']<=r['date']<=p['end']]
    dates=[r['date'] for r in rows]
    op=[r['close'] if p['execution']=='close' else r['open'] for r in rows];cl=[r['close'] for r in rows]
    model=FixedLeverage(dates,op,cl,cost=p['cost'])
    assert abs(model.path(1)['terminal_equity']/(10000/(1+p['cost'])*cl[-1]/op[0])-1)<1e-10
    one_x_checks+=1
    paired=[p]+[replay(d,dates,op,cl,cost=p['cost']) for d in definitions]
    paired.append({'strategy':'BUY-HOLD-1x','start':dates[0],'end':dates[-1],**model.path(1)})
    for x in paired:
        match=model.match(x['terminal_equity']);x={k:v for k,v in x.items() if k!='path'}
        x.update(suite=p['suite'],tag=p['tag'],cost=p['cost'],execution=p['execution'],
                 total_return=x['terminal_equity']/10000-1)
        if match:
            worse=match['fixed_max_drawdown']-x['max_drawdown']
            x.update(match,candidate_worse_drawdown_by=worse,status='reject' if worse>1e-10 else 'pass')
        else:x['status']='unmatched'
        results.append(x)
synthetic_reconciliation=[]
for case in synthetic['scenarios']:
    current=next(x for x in results if x['suite']=='SYN-'+case['scenario'] and
                 x['tag']=='native_close' and x['strategy']=='PRODUCTION-PE-PROXY')
    expected=case['results']['pivot_v2']
    for key in ['max_drawdown','financing_interest']:
        value=expected[key]*(10000 if key=='financing_interest' else 1)
        assert abs(current[key]-value)<1e-8*max(1,abs(value)),key
    assert abs(current['total_return']-expected['net_return'])<1e-10
    synthetic_reconciliation.append({'scenario':case['scenario'],'net_return_error':current['total_return']-expected['net_return'],
                                     'drawdown_error':current['max_drawdown']-expected['max_drawdown']})
(HERE/'results.json').write_text(json.dumps({'protocol':protocol,'results':results,
  'verification':{'production_prefix_checks':production['prefixChecks'],'one_x_buy_hold_checks':one_x_checks,
    'synthetic_native_close_reconciliation':synthetic_reconciliation,
    'maximum_trade_residual':max(p['maximum_trade_residual'] for p in production['results']),
    'all_source_hashes_unchanged':all(sha(ROOT/k)==v for k,v in protocol['source_sha256'].items())}},indent=2),encoding='utf-8')
fields=['suite','strategy','tag','execution','start','end','total_return','cagr','max_drawdown',
        'fixed_leverage','fixed_max_drawdown','candidate_worse_drawdown_by','status','fees_paid',
        'financing_interest','hard_cap_interventions']
with (HERE/'comparisons.csv').open('w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fields,extrasaction='ignore');w.writeheader();w.writerows(results)
for x in results:
    if x['tag']=='proxy_entry':print(x['suite'],x['strategy'],x['start'],round(x['cagr']*100,2),round(-x['max_drawdown']*100,2),x['status'],round(x.get('fixed_max_drawdown',0)*-100,2))
