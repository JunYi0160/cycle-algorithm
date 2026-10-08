"""Report every frozen candidate, separate universal and conditional evidence."""
import csv
import hashlib
import json
from pathlib import Path
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from fixed_leverage import FixedLeverage

HERE=Path(__file__).resolve().parent
j=json.loads((HERE/'results.json').read_text(encoding='utf-8'))
cohorts=json.loads((HERE/'cohorts.json').read_text(encoding='utf-8'))
verification=json.loads((HERE/'verification.json').read_text(encoding='utf-8'))
daily=pd.read_csv(HERE/'daily-primary.csv.gz',parse_dates=['date'])
source_prices=json.loads((HERE.parent/'historical/prices.json').read_text(encoding='utf-8'))
def inputs(suite,start,end):
    if suite!='TECH3':raise ValueError('This figure is defined for the frozen TECH3 basket')
    maps=[{r['date']:r for r in source_prices[t]} for t in ['NVDA','GOOG','MSFT']]
    dates=[r['date'] for r in source_prices['NVDA'] if start<=r['date']<=end and all(r['date'] in m for m in maps)]
    anchors=[m[dates[0]]['open'] for m in maps]
    op=[sum(m[dt]['open']/anchors[i] for i,m in enumerate(maps))/len(maps) for dt in dates]
    cl=[sum(m[dt]['close']/anchors[i] for i,m in enumerate(maps))/len(maps) for dt in dates]
    return dates,op,cl
def pct(x):return f'{x*100:.2f}%'
def table(head,rows):
    return '\n'.join(['| '+' | '.join(head)+' |','| '+' | '.join(['---']*len(head))+' |']+
                     ['| '+' | '.join(map(str,row))+' |' for row in rows])
def matching(r):return pct(r['fixed_max_drawdown']) if 'fixed_max_drawdown' in r else '无有效匹配'
def get(suite,id,tag):return next(r for r in j['required'] if r['suite']==suite and r['strategy']==id and r['tag']==tag)

plt.rcParams.update({'font.size':9,'axes.grid':True,'grid.alpha':.25})
fig,axes=plt.subplots(2,2,figsize=(12,8),constrained_layout=True)
for col,id in enumerate(['AY-50','RV-20']):
    r=get('TECH3',id,'primary')
    frame=daily[(daily.suite=='TECH3') & (daily.strategy==id)]
    dates,op,cl=inputs('TECH3',r['start'],r['end'])
    model=FixedLeverage(dates,op,cl)
    l=r['fixed_leverage'];eq=model.trade_equities(l)
    reference=eq[model.last]*(l*model.close_g+(1-l)*(model.debt_factor if l>1 else 1))
    axes[0,col].plot(frame.date,frame.equity/10000,label=id,lw=1.2)
    axes[0,col].plot(frame.date,reference/10000,label=f'Fixed {l:.4f}x, equal terminal return',ls='--',lw=1)
    axes[0,col].set_yscale('log');axes[0,col].set_title(f'TECH3: {id} versus equal-return control')
    axes[0,col].set_ylabel('Net wealth / initial capital');axes[0,col].legend(fontsize=8)
    peak=frame.equity.cummax().clip(lower=10000)
    control_peak=pd.Series(reference).cummax().clip(lower=10000)
    axes[1,col].plot(frame.date,(frame.equity/peak-1)*100,label=id,lw=1)
    axes[1,col].plot(frame.date,(reference/control_peak-1)*100,label='Fixed leverage',ls='--',lw=.8)
    axes[1,col].set_ylabel('Daily close drawdown (%)');axes[1,col].legend(fontsize=8)
fig.suptitle('One frozen research batch | 2010-01-04 to 2026-09-04 | monthly previous-close signals, next-open execution',fontsize=11)
fig.savefig(HERE/'equal-return-comparison.png',dpi=170);plt.close(fig)

parts=['# 第二轮策略研究：风险预算与新高资本保护\n',
'''这一轮固定了 6 个新候选，只运行一次，没有在看到结果后调整参数。**获得了在预先列入的 TECH3 组合上通过主要回撤检验和压力检查的 4 个实例，但没有任何一个通过全资产、全时间段的通用筛选。**

TECH3 通过者为 AY-50、AY-75、RV-10、RV-20；这是限定组合的研究结果。组合范围是在测试前列入的，但事后突出它仍有资产选择偏差，因此不把这些实例写入通用保留清单。它们也并非通过全部五年滚动窗口。

## 从上一轮失败中修改了什么

固定锚点的有理势函数在价格持续上涨后趋向零仓位，网格则可能完全停止工作。新高资本保护改为幂函数的峰值参考，长期参与率不会仅因价格远离初始锚点而趋向零。风险预算直接控制估计的风险额度，并保留在风险估计下降后恢复仓位的路径。

本轮没有引入均线方向、收益率预测、估值判断、止跌判断或按标的优化参数。目标波动率和参与率是预先指定的风险偏好，仍是模型假设，不能称为没有任何主观选择。

## 规则一：AY 新高资本保护

令 B 是入场时归一化为 1 的买入持有总收益指数，M 为已经观察到的历史最高收盘指数（至少为 1）。连续、无摩擦模型中的幂变换为：

`V = K M^a [1-a + a B/M]`，`q = K a M^(a-1)`。

它参考 [Azéma–Yor 变换](https://arxiv.org/abs/0902.1328) 和 [回撤约束组合研究](https://arxiv.org/abs/1110.6289)。本实现是受该理论启发的离散规则，不是连续时间定理的直接复制。

实际执行：初始股票比例 a；之后目标份额 `q_target = q_initial × M^(a-1)`，只有已知新高抬升时才减少份额。卖出的金额留在现金。a 分别固定为 0.50、0.75。M 在昨日收盘后更新，当月首个交易日开盘执行；从未根据当天尚未发生的收盘价交易。

该规则在持续上涨后的股票价值仍按 M^a 增长，改善旧有理函数的仓位耗尽问题。股票份额单调减少，但不会在有限价格的新高处突然清空。它不根据当前跌幅本身卖出；月度延迟依然可能使新高后的减仓发生在价格已经回落时。

连续公式的回撤结论有连续路径、执行和无摩擦条件；本轮费用、价格跳跃、昨日信号和月度执行不能据此获得硬回撤保证。真实净值由自融资账本计算，而不是直接把理论公式当成净值。

**循环局限：** 第一次出现新高后回到原价，可以因高价减少份额获得盈利；反复在完全相同的旧高低区间内往返，没有新的最高价时不会继续交易。因此它不是持续收割任意固定区间震荡的算法。

## 规则二：RV 波动风险预算

`v_t = λ v_(t-1) + (1-λ) r_t²`，`σ_t = sqrt(252 v_t)`，`λ = 2^(-1/63)`。

r 为总收益指数的日对数收益，63 个交易日是一个季度的半衰期。这里估计的是平方收益的均值，σ 是年度化均方根风险近似，不是无偏预测的未来标准差。每次新入场以年化 20% 初始化，之后只使用已经完成的收盘数据。

`w_next = min(1, σ_target / σ_previous)`。

RV-10、RV-20 的 σ_target 为 10%、20%。它等价于在模型估计的 `w²σ² ≤ σ_target²` 风险预算内，选择最大的市场参与比例。高风险时减少仓位，估计风险下降后恢复；不预测上涨或下跌。

另设 RVAR-10、RVAR-20 对照：`w_next = min(1, σ_target² / σ_previous²)`，可以解释为边际方差预算 `2wσ² ≤ 2σ_target²`。它对风险变化反应更强，本轮结果反而较差，不保留为优先实例。

相关研究背景是 [Moreira–Muir 的波动管理组合](https://law.yale.edu/sites/default/files/area/workshop/leo/leo17_moreira.pdf)。本轮有上限、不融资、预先指定风险水平，也没有根据全样本波动率确定缩放常数，不能把论文结论直接当作这些实例的验证。

风险预算只约束过去数据给出的风险估计。突发跳空仍可能在仓位缩减前造成损失，也可能在高波动低价阶段卖出并错过反弹。

## 可直接用于后续回测的实例

使用固定 `spec.json` 和 `engine.py`。初始资金 10,000、初始价格 100、5bp 单边费用，例子如下：
''',table(['候选','初始股票比例','关键规则'],[
['AY-50','50%','初始买约49.9875股；新高M/P0=1.2后，目标份额为初始份额/√1.2'],
['AY-75','75%','初始买约74.9719股；新高M/P0=1.2后，目标份额为初始份额/(1.2)^0.25'],
['RV-10','50%','若昨日估计σ=25%，目标股票比例40%'],
['RV-20','100%','若昨日估计σ=25%，目标股票比例80%'],
['RVAR-10','25%','若昨日估计σ=25%，目标股票比例16%'],
['RVAR-20','100%','若昨日估计σ=25%，目标股票比例64%']]),
'''\n这是资金比例/持仓规则，不是收益预测。组合使用初始等额投入后固定相对份额的同一篮子；交易只缩放整个篮子的份额，不做选股或等权再平衡。

## 防止过拟合的实际措施与局限

- 参数在第一轮 v2 执行之前写入 `spec.json`，执行前记录文件和数据哈希。全程没有改变这 6 个规则。
- 主要数据维持五个单标的、TECH3 和 ETF2。所有标的使用同一组参数，不淘汰失败资产后宣称通用通过。
- 分别重置账户检验：可用起点至2013年、2014–2019年、2020年至2026-09-04，以及2010年至今和完整历史。开发段先执行，之后没有拟合或改变规则再运行后段。
- 所有交易使用昨日已经完成的收盘信号、次日可用开盘报价；再检查多延迟一个交易日、日频执行和20bp费用。
- 预先列入参与率±0.05、风险目标±20%、半衰期32/126天的邻域。邻域结果只做稳健性诊断，不选择其中表现最好的新参数。
- 全部符合条件的逐年五年起点都保存，包括失败及找不到有效等收益对照的窗口，不只展示成功起点。
- 因为这些价格此前已经被查看，时间分段是事后时间检验，不能称为未接触过的样本外验证。各窗口重叠，通过比例也不是独立试验的胜率。
- 原先11个候选和本轮6个候选均已尝试；多次研究的选择偏差不能因本轮冻结就消失。后续需要真正新数据、未按结果挑选的更广资产池和实际交易验证。

## 全资产结果：没有通用通过者

按用户的等收益回撤标准：同期间、同费用，匹配固定杠杆的期末净财富，再比较每日收盘最大回撤。主区间＋完整历史共有14项基础检查；加入三段时间检查后为35项。固定杠杆每月恢复目标，低于1x的余额为零利息现金，超过1x按5.3%融资。无有效等收益解的结果不会被算作通过，也不直接据此证明回撤更差。
''',table(['候选','主区间＋完整历史','全部时间检查','压力检查','参数邻域','通用保留'],[
[d['strategy'],f"{d['primary_full_passed']}/{d['primary_full_checks']}",f"{d['required_passed']}/{d['required_checks']}",
 f"{d['stress_passed']}/{d['stress_checks']}",f"{d['neighbors_passed']}/{d['neighbor_checks']}",'否'] for d in j['decisions']]),
'''\nAY-50 和 AY-75 在主区间的全部7个标的/组合都通过；完整历史仅微软失败。例如 AY-50 在微软完整历史年化约5.09%，回撤34.48%，等收益固定杠杆回撤32.05%。因此即使13/14看起来接近，也按原规则剔除通用资格。

## 限定 TECH3 组合：四个有希望的研究实例

组合是入场时 NVDA、GOOG、MSFT 等额投入的固定份额篮子。下面都是2010-01-04至2026-09-04、月度、5bp净结果：
''']
ids=['AY-50','AY-75','RV-10','RV-20']
parts.append(table(['候选','相同净年化','等收益固定杠杆','候选回撤','固定杠杆回撤','回撤减少'],[
[id,pct((r:=get('TECH3',id,'primary'))['cagr']),f"{r['fixed_leverage']:.4f}x",pct(r['max_drawdown']),matching(r),
 f"{-r['candidate_worse_drawdown_by']*100:.2f}百分点"] for id in ids]))
parts.append(f'\n![三股组合与等收益固定杠杆]({(HERE/"equal-return-comparison.png").as_posix()})\n')
parts.append('不同时间段重新入场也通过，但通过不代表回撤很小：\n')
parts.append(table(['区间','候选','相同净年化','候选回撤','固定杠杆回撤'],[
[tag,id,pct((r:=get('TECH3',id,tag))['cagr']),pct(r['max_drawdown']),matching(r)]
for tag in ['development_replay','validation_replay','late_replay','full_history'] for id in ids]))
parts.append('\nTECH3 上 AY 两个实例分别通过15/15项时间、费用、延迟、频率及邻域检查；RV 两个实例分别通过19/19项。但这些还不是全部五年起点的检验：\n')
cohort_rows=[]
for id in ids:
    rr=[r for r in cohorts if r['suite']=='TECH3' and r['strategy']==id]
    cohort_rows.append([id,f"{sum(r['status']=='pass' for r in rr)}/{len(rr)}",sum(r['cagr']<0 for r in rr),
                        ', '.join(str(r['cohort_year'])+('（无法匹配）' if r['status']=='unmatched' else '') for r in rr if r['status']!='pass')])
parts.append(table(['候选','五年窗口通过数','五年累计亏损数','未通过的入场年份'],cohort_rows))
parts.append('''\n这说明不能把限定组合的主要检查通过，描述成对所有入场年份都有效。比如AY-50在2007年入场的五年窗口中仍大幅失败。若把“每个五年窗口都必须通过”也列为硬条件，这四个实例同样不能保留。

## 全部标的的主区间结果
''')
parts.append(table(['标的','候选','净年化','候选回撤','等收益杠杆','对照回撤','结论'],[
[r['suite'],r['strategy'],pct(r['cagr']),pct(r['max_drawdown']),f"{r.get('fixed_leverage',float('nan')):.4f}x",matching(r),
 {'pass':'通过','reject':'剔除','unmatched':'无法匹配'}[r['status']]] for r in j['required'] if r['tag']=='primary']))
parts+=['''\n## 研究结论与下一步边界

本轮最明确的改进是：峰值幂变换避免旧有理函数的参与率耗尽；风险预算把调仓目标改为可以明确写出的风险约束。它们确实改善了等收益回撤比较，但没有得到全资产通用赢家。

保留4个TECH3实例用于理论与后续数据检验，不能据此先选择这个组合再声称不存在资产选择偏差。不修改参数来修复微软或某个五年窗口，也不把半衰期、波动目标的邻域赢家改成最终策略。

若要求上一轮的全资产通用筛选，`selected.json` 的通用清单仍为空；这轮证据尚不足以替换生产核心。真正的下一步应检验新时间数据和更广、预先规定的资产池，而不是继续在相同历史上搜索直到全部通过。

## 复现和验收

本机运行 `research/v2/reproduce.ps1`。单独运行也可以：

```text
python research/v2/test_engine.py
python research/v2/run.py
python research/v2/report.py
```

计算无需联网；画图需要pandas、matplotlib。价格使用上一轮已审计的 `research/historical/prices.json`。账本不融资、不做空、不含税，现金收益为0；总收益指数隐含股息再投资。盘中回撤、实际交易冲击和借款强制平仓仍未模拟。
''',
f"\n7项独立策略/账本测试通过；{len(verification['prefix_invariance_passed'])}项前缀一致性、{len(verification['today_close_cannot_change_today_units'])}项今日收盘不能改变今日交易的检查通过。最大自融资残差 {verification['maximum_cash_conservation_residual']:.3g}，最大等收益期末匹配相对误差 {verification['maximum_equal_terminal_matching_error']:.3g}。\n",
f"\n保存 {len(j['required'])}项时间检查、{len(j['stress'])}项压力、{len(j['neighbors'])}项邻域和{len(cohorts)}项五年窗口结果。全部结果见 `results.json`、`cohorts.json`，每日主账本见 `daily-primary.csv.gz`。原生产算法和第一轮定义未改变。\n"]
(HERE/'第二轮策略研究.md').write_text('\n\n'.join(parts),encoding='utf-8')
columns=['suite','strategy','tag','cost','frequency','extra_signal_delay','start','end','cagr','max_drawdown','fixed_leverage','fixed_max_drawdown','candidate_worse_drawdown_by','status']
rows=[{**r,'check_type':kind} for kind,rr in [('required',j['required']),('stress',j['stress']),('neighbor',j['neighbors']),('cohort',cohorts)] for r in rr]
with (HERE/'all-comparisons.csv').open('w',encoding='utf-8-sig',newline='') as f:
    writer=csv.DictWriter(f,fieldnames=['check_type']+columns,extrasaction='ignore');writer.writeheader();writer.writerows(rows)
files=[p for p in HERE.iterdir() if p.is_file() and p.name!='manifest.json']
(HERE/'conditional-examples.json').write_text(json.dumps({'universal_status':'No candidate retained',
    'examples':[{'definition':d,'scope':r['suite'],'status':'Conditional research example only',
                 'specified_checks_passed':r['checks'],'five_year_cohorts_passed':sum(c['status']=='pass' for c in cohorts if c['suite']==r['suite'] and c['strategy']==d['id']),
                 'five_year_cohort_count':sum(c['suite']==r['suite'] and c['strategy']==d['id'] for c in cohorts)}
                for d in j['spec']['candidates'] for decision in j['decisions'] if decision['strategy']==d['id']
                for r in decision['per_asset_robustness'] if r['all_checks_passed']],
    'scope_highlighting_is_posthoc':True,'parameter_neighbors_were_not_selected':True},ensure_ascii=False,indent=2),encoding='utf-8')
files=[p for p in HERE.iterdir() if p.is_file() and p.name!='manifest.json']
(HERE/'manifest.json').write_text(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files},ensure_ascii=False,indent=2),encoding='utf-8')
print('Wrote full report, figure, CSV and artifact manifest')
