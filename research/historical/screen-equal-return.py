"""Apply the user's equal-return, lower-drawdown rejection rule without tuning candidates."""
import csv
import hashlib
import json
from datetime import date
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
summary = json.loads((HERE/'summary.json').read_text(encoding='utf-8'))
data = json.loads((HERE/'prices.json').read_text(encoding='utf-8'))
spec = json.loads((HERE.parent/'candidates.json').read_text(encoding='utf-8'))
candidate_ids = [d['id'] for d in spec['candidates']]
CAPITAL, RATE, COST = 10000., .053, .0005


class FixedLeverage:
    """Monthly target exposure to the original fixed-share total-return basket.

    Between trades q stays fixed. Debt accrues daily simple interest, capitalized
    across sessions; positive cash earns zero. Fees solve the post-fee target
    exactly. At L=1 this is buy-and-hold, including its initial purchase fee.
    """
    def __init__(self, tickers, start, end):
        maps = [{r['date']:r for r in data[t]} for t in tickers]
        dates = [r['date'] for r in data[tickers[0]] if start <= r['date'] <= end and all(r['date'] in m for m in maps)]
        self.dates = dates
        prices_open = np.array([[m[d]['open'] for m in maps] for d in dates])
        prices_close = np.array([[m[d]['close'] for m in maps] for d in dates])
        self.op = (prices_open/prices_open[0]).mean(axis=1)
        self.cl = (prices_close/prices_open[0]).mean(axis=1)
        trade = np.array([i for i,d in enumerate(dates) if i==0 or d[:7]!=dates[i-1][:7]])
        days = np.array([0]+[(date.fromisoformat(dates[i])-date.fromisoformat(dates[i-1])).days for i in range(1,len(dates))])
        log_interest = np.cumsum(np.log1p(RATE*days/365))
        self.trade = trade
        self.trade_g = self.op[trade[1:]]/self.op[trade[:-1]]
        self.trade_debt_factor = np.exp(log_interest[trade[1:]]-log_interest[trade[:-1]])
        self.last = np.searchsorted(trade, np.arange(len(dates)), side='right')-1
        self.close_g = self.cl/self.op[trade[self.last]]
        self.open_g = self.op/self.op[trade[self.last]]
        self.debt_factor = np.exp(log_interest-log_interest[trade[self.last]])
        self.years = (date.fromisoformat(dates[-1])-date.fromisoformat(dates[0])).days/365.25

    def trade_equities(self, leverage):
        l = float(leverage)
        debt = self.trade_debt_factor if l>1 else np.ones_like(self.trade_g)
        before = l*self.trade_g+(1-l)*debt
        gap = l*(before-self.trade_g)
        after = before-COST*np.abs(gap)/(1+COST*l*np.where(gap>=0,1,-1))
        if np.any(before<=0) or np.any(after<=0):
            return None
        return CAPITAL/(1+COST*l)*np.r_[1.,np.cumprod(after)]

    def terminal(self, leverage):
        eq = self.trade_equities(leverage)
        if eq is None:
            return float('nan')
        l = float(leverage)
        factor = l*self.close_g[-1]+(1-l)*(self.debt_factor[-1] if l>1 else 1.)
        return float(eq[-1]*factor) if factor>0 else float('nan')

    def path(self, leverage):
        eq = self.trade_equities(leverage)
        if eq is None:
            return None
        l = float(leverage)
        debt = self.debt_factor if l>1 else np.ones_like(self.debt_factor)
        close = eq[self.last]*(l*self.close_g+(1-l)*debt)
        op = eq[self.last]*(l*self.open_g+(1-l)*debt)
        if np.any(close<=0) or np.any(op<=0):
            return None
        peak = np.maximum.accumulate(np.maximum(close,CAPITAL))
        return {'terminal_equity':float(close[-1]), 'cagr':float((close[-1]/CAPITAL)**(1/self.years)-1),
                'max_drawdown':float(np.min(close/peak-1))}


comparisons, benchmark_checks = [], []
for tag in ['primary','full_history']:
    for suite in ['QQQ','SMH','NVDA','GOOG','MSFT','TECH3','ETF2']:
        rows = [r for r in summary['results'] if r['tag']==tag and r['suite']==suite]
        source = rows[0]
        model = FixedLeverage(source['tickers'],source['start'],source['end'])
        hold_id = 'B-STOCK' if len(source['tickers'])==1 else 'B-EQUAL-HOLD'
        hold = next(r for r in rows if r['strategy']==hold_id)
        check = model.path(1)
        assert abs(check['terminal_equity']/hold['terminal_equity']-1)<1e-10
        assert abs(check['max_drawdown']-hold['max_drawdown'])<1e-10
        benchmark_checks.append({'suite':suite,'tag':tag,'one_x_matches_prior_buy_hold':True})
        if len(source['tickers'])==1:
            half = next(r for r in rows if r['strategy']=='B-50')
            check = model.path(.5)
            assert abs(check['terminal_equity']/half['terminal_equity']-1)<1e-10
            assert abs(check['max_drawdown']-half['max_drawdown'])<1e-10
        grid = np.linspace(0,3,301)
        values = np.array([model.terminal(l) for l in grid])
        for r in rows:
            if r['strategy'] not in candidate_ids:
                continue
            target = r['terminal_equity']; roots = []
            residual = values-target
            for i,l in enumerate(grid):
                if np.isfinite(residual[i]) and abs(residual[i]/target)<1e-12:
                    roots.append(float(l))
                if i==0 or not np.isfinite(residual[i-1]) or not np.isfinite(residual[i]) or residual[i-1]*residual[i]>=0:
                    continue
                low,high,fl = grid[i-1],l,residual[i-1]
                for _ in range(65):
                    mid = (low+high)/2
                    fm = model.terminal(mid)-target
                    if fl*fm<=0: high=mid
                    else: low,fl=mid,fm
                roots.append(float((low+high)/2))
            roots = sorted({round(root,14) for root in roots})
            valid = [(l,model.path(l)) for l in roots]
            valid = [(l,p) for l,p in valid if p is not None]
            item = {'suite':suite,'tag':tag,'strategy':r['strategy'],'start':r['start'],'end':r['end'],
                    'candidate_cagr':r['cagr'],'candidate_max_drawdown':r['max_drawdown'],
                    'candidate_terminal_equity':target,'solvent_root_count':len(valid)}
            if not valid:
                item.update(status='unmatched',reason='No solvent equal-return root located within 0x–3x; not counted as passing')
            else:
                # Lower-leverage solution is the prespecified comparator if several roots exist.
                leverage,control = valid[0]
                error = abs(control['terminal_equity']/target-1)
                assert error<1e-10
                # Positive means candidate drawdown magnitude is larger, hence fails.
                worse_by = control['max_drawdown']-r['max_drawdown']
                item.update(fixed_leverage=leverage,fixed_cagr=control['cagr'],fixed_max_drawdown=control['max_drawdown'],
                            fixed_terminal_equity=control['terminal_equity'],relative_terminal_matching_error=error,
                            candidate_worse_drawdown_by=worse_by,status='reject' if worse_by>1e-10 else 'pass')
            comparisons.append(item)
        print(f'Equal-return comparison complete: {tag}/{suite}')

screen = []
for id in candidate_ids:
    rr = [r for r in comparisons if r['strategy']==id]
    failures = [r for r in rr if r['status']=='reject']
    unresolved = [r for r in rr if r['status']=='unmatched']
    screen.append({'strategy':id,'status':'reject' if failures else ('unresolved' if unresolved else 'retain'),
                   'applicable_comparisons':len(rr),'passed':len(rr)-len(failures)-len(unresolved),
                   'unmatched_count':len(unresolved),
                   'failed_or_unmatched':[{'suite':r['suite'],'tag':r['tag'],'status':r['status'],
                                           'candidate_worse_drawdown_by':r.get('candidate_worse_drawdown_by')} for r in failures+unresolved]})
protocol = {'criterion':'Match net terminal wealth (equivalently CAGR on identical dates), reject if candidate maximum drawdown magnitude exceeds comparator.',
            'screening_scope':'All applicable primary and full-history assets; any strictly worse drawdown removes the candidate from the research shortlist. Unmatched comparisons are unresolved, not automatic failures. Overlapping cohorts, legacy PE proxies and frequency/cost sensitivity are not additional rejection gates.',
            'comparator':'Monthly fixed target leverage to the same fixed-share buy-and-hold asset/basket; multi-asset relative shares are never equal-weight rebalanced.',
            'cash_rate':0,'borrowing_rate':RATE,'one_way_cost':COST,'initial_capital':CAPITAL,
            'execution_and_drawdown':'Same opening quotes and daily closing drawdown as prior main replay; no forced terminal sale.',
            'root_search':'0x–3x scanned at 0.01x, sign changes bisected 65 times; lowest solvent root retained; no root is unresolved, not an automatic pass. Tangent roots without sign changes could be missed.',
            'drawdown_numerical_tolerance':1e-10,
            'interpretation':'Ex-post equal-return diagnostic; not a leverage recommendation or an out-of-sample test.'}
output = {'protocol':protocol,'comparisons':comparisons,'candidate_screen':screen,'benchmark_checks':benchmark_checks,
          'maximum_relative_matching_error':max(r.get('relative_terminal_matching_error',0) for r in comparisons),
          'input_sha256':{f:hashlib.sha256((HERE/f).read_bytes()).hexdigest() for f in ['prices.json','summary.json','screen-equal-return.py']}}
(HERE/'equal-return-screen.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
headers = ['suite','tag','strategy','candidate_cagr','fixed_leverage','candidate_max_drawdown','fixed_max_drawdown','candidate_worse_drawdown_by','status']
with (HERE/'equal-return-screen.csv').open('w',encoding='utf-8-sig',newline='') as f:
    writer=csv.DictWriter(f,fieldnames=headers,extrasaction='ignore'); writer.writeheader();writer.writerows(comparisons)
retained=[r['strategy'] for r in screen if r['status']=='retain']
rejected=[r['strategy'] for r in screen if r['status']=='reject']
(HERE/'screened-candidates.json').write_text(json.dumps({'screening_rule':protocol,'retained_candidate_ids':retained,
    'rejected_candidate_ids':rejected,'candidates':[d for d in spec['candidates'] if d['id'] in retained],
    'original_definition_file':'../candidates.json','historical_definitions_preserved':True},ensure_ascii=False,indent=2),encoding='utf-8')
def pct(v):return f'{v*100:.2f}%'
def table(head,rows):return '\n'.join(['| '+' | '.join(head)+' |','| '+' | '.join(['---']*len(head))+' |']+['| '+' | '.join(map(str,row))+' |' for row in rows])
report=['# 等收益固定杠杆筛选\n',
        '按用户要求，收益相同后比较回撤。剔除回撤更大的候选；原始定义与历史结果保留供复核，后续候选使用 `screened-candidates.json`。\n',
        '范围为上一轮主区间与完整历史，所有适用标的都需通过。单标的是同一标的，组合是同一初始等额、固定相对份额的买入持有篮子。固定杠杆每月恢复目标值；0–1x 对应股票/现金，超过1x借款，年利率5.3%。现金利率0，单边费用5bp，执行报价、日期及收盘回撤口径一致。\n',
        '匹配的是期末净财富，同一时间段内等价于匹配累计回报和年化回报。不能直接用“策略年化/标的年化”作为杠杆，因为复利、调仓和费用会改变关系。求解范围0–3x，有多解取较低的有效解；无有效解不视为通过。\n',
        f'**保留：{", ".join(retained) if retained else "无"}。剔除：{", ".join(rejected)}。**\n',
        table(['候选','通过/检查数','结论'],[[r['strategy'],f"{r['passed']}/{r['applicable_comparisons']}",'保留' if r['status']=='retain' else '剔除'] for r in screen])]
for tag in ['primary','full_history']:
    report.append('\n## '+('统一主区间：2010-01-04 至 2026-09-04' if tag=='primary' else '完整历史：各标的可用起点至 2026-09-04')+'\n')
    report.append(table(['标的','候选','相同净年化','固定杠杆','候选最大回撤','对照最大回撤','候选回撤多出','结论'],
      [[r['suite'],r['strategy'],pct(r['candidate_cagr']),f"{r.get('fixed_leverage',float('nan')):.6f}x",pct(r['candidate_max_drawdown']),
        pct(r.get('fixed_max_drawdown',float('nan'))),f"{r.get('candidate_worse_drawdown_by',float('nan'))*100:+.3f}百分点",
        {'pass':'通过','reject':'剔除','unmatched':'无法匹配'}[r['status']]] for r in comparisons if r['tag']==tag]))
report.append(f"\n最大期末财富相对匹配误差：{output['maximum_relative_matching_error']:.3g}。14 个1x对照及10个单标的0.5x对照均复现此前结果。筛选只回答历史等收益回撤问题，不证明样本外优势。\n")
report.append('\n复现：`python research/historical/screen-equal-return.py`。原先分析中的“值得继续研究”判断以本筛选结果为准。\n')
(HERE/'等收益回撤筛选.md').write_text('\n\n'.join(report),encoding='utf-8')
print(json.dumps({'retained':retained,'rejected':rejected,'comparisons':len(comparisons),'max_match_error':output['maximum_relative_matching_error']},ensure_ascii=False,indent=2))
