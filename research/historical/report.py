"""Create the shareable initial analysis from the frozen-run outputs."""
import json
import math
import hashlib
from pathlib import Path
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = Path(__file__).resolve().parent
summary = json.loads((HERE / 'summary.json').read_text(encoding='utf-8'))
audit = json.loads((HERE / 'data-audit.json').read_text(encoding='utf-8'))
cohorts = json.loads((HERE / 'cohorts.json').read_text(encoding='utf-8'))
verification = json.loads((HERE / 'verification.json').read_text(encoding='utf-8'))
daily = pd.read_csv(HERE / 'daily-primary.csv.gz', parse_dates=['date'])
results = summary['results']
primary = [r for r in results if r['tag'] == 'primary']
def get(suite, strategy, tag='primary'):
    return next(r for r in results if r['suite'] == suite and r['strategy'] == strategy and r['tag'] == tag)
def pct(x):
    return f'{x * 100:.2f}%'
def table(headers, rows):
    return '\n'.join(['| ' + ' | '.join(headers) + ' |', '| ' + ' | '.join(['---'] * len(headers)) + ' |'] +
                     ['| ' + ' | '.join(map(str, row)) + ' |' for row in rows])

plt.rcParams.update({'font.size': 9, 'axes.grid': True, 'grid.alpha': .25})
fig, axes = plt.subplots(2, 2, figsize=(13, 8.5), constrained_layout=True)
for ax, suite, ids in [(axes[0, 0], 'QQQ', ['B-STOCK','B-50','P-R1','P-R2','G-10','M-SINGLE']),
                       (axes[0, 1], 'TECH3', ['B-EQUAL-HOLD','B-EQUAL-MIX','E-025','E-1','E-4','M-MULTI'])]:
    for id in ids:
        frame = daily[(daily.suite == suite) & (daily.strategy == id)]
        ax.plot(frame.date, frame.equity / 10000, label=id, linewidth=1.1)
    ax.set_yscale('log'); ax.set_title(f'{suite}: net wealth (log scale)'); ax.set_ylabel('Initial capital = 1')
    ax.legend(fontsize=8, ncol=2)
for id in ['B-50','P-R1','P-R2','G-10','M-SINGLE']:
    frame = daily[(daily.suite == 'QQQ') & (daily.strategy == id)]
    axes[1, 0].plot(frame.date, frame.stock_weight * 100, label=id, linewidth=1)
axes[1, 0].set_title('QQQ: actual closing stock exposure'); axes[1, 0].set_ylabel('% of account equity')
axes[1, 0].set_ylim(0, 102); axes[1, 0].legend(fontsize=8, ncol=2)
for id in ['B-EQUAL-HOLD','B-EQUAL-MIX','E-025','E-1','E-4']:
    frame = daily[(daily.suite == 'TECH3') & (daily.strategy == id)]
    running_peak = frame.equity.cummax().clip(lower=10000)
    axes[1, 1].plot(frame.date, (frame.equity / running_peak - 1) * 100, label=id, linewidth=.8)
axes[1, 1].set_title('TECH3: daily close drawdowns'); axes[1, 1].set_ylabel('% below running peak')
axes[1, 1].legend(fontsize=8, ncol=2)
fig.suptitle('Cached history replay: 2010-01-04 to 2026-09-04 | monthly | one-way fee 5bp | cash yield 0%', fontsize=12)
fig.savefig(HERE / 'historical-overview.png', dpi=170); plt.close(fig)

fig, axes = plt.subplots(1, 2, figsize=(12, 4.5), constrained_layout=True)
for ax, suite in zip(axes, ['TECH3', 'ETF2']):
    base = {r['cohort_year']: r for r in cohorts if r['suite'] == suite and r['strategy'] == 'B-EQUAL-MIX'}
    values = [[(r['cagr'] - base[r['cohort_year']]['cagr']) * 100 for r in cohorts if r['suite'] == suite and r['strategy'] == id] for id in ['E-025', 'E-1', 'E-4']]
    ax.boxplot(values, tick_labels=['E-025','E-1','E-4'], showmeans=True)
    for i, v in enumerate(values, 1):
        ax.scatter([i] * len(v), v, s=15, alpha=.6)
    ax.axhline(0, color='black', linewidth=1); ax.set_title(f'{suite}: all eligible 5-year January cohorts')
    ax.set_ylabel('CAGR minus equal-weight rebalancing (percentage points)')
fig.suptitle('Cohorts overlap: these are descriptive observations, not independent statistical trials', fontsize=11)
fig.savefig(HERE / 'cohort-excess.png', dpi=170); plt.close(fig)

flat = [r for r in cohorts if r['strategy'] == 'B-STOCK' and abs(r['net_return']) <= .1]
flat_rows = []
for baseline in flat:
    lookup = {r['strategy']: r for r in cohorts if r['suite'] == baseline['suite'] and r['cohort_year'] == baseline['cohort_year']}
    flat_rows.append([baseline['suite'], f"{baseline['cohort_year']}–{baseline['cohort_year']+4}",
                      pct(baseline['net_return']), pct(lookup['B-50']['net_return']),
                      pct(lookup['P-R1']['net_return']), pct(lookup['G-10']['net_return']),
                      pct(lookup['P-R1']['max_drawdown']), pct(lookup['G-10']['max_drawdown'])])

parts = ['# 新仓位策略：缓存历史数据初步回测\n',
'''已对此前固定的全部 11 个候选例子完成回测。**震荡回收收益的机制在真实路径中能够出现，但本轮没有证据支持把任何候选直接替代为长期核心策略。**

凹势函数与有限网格在价格终点接近起点的若干窗口中获得正收益；代价包括中途回撤，以及持续上涨后仓位下降、现金闲置。熵策略能保留完整股票敞口，在三股组合上比定期等权调仓有更好的长期收益，但在强者持续胜出的行情中落后于固定份额买入持有。混合账户只做收益与风险的折中，其保证不等于跑赢最优成员。

## 数据、执行与可比范围

使用旧项目已有数据，没有下载新价格，也没有修改原缓存。主要数据涵盖 QQQ、SMH、NVDA、GOOG、MSFT；组合 TECH3 = NVDA/GOOG/MSFT，ETF2 = QQQ/SMH。统一主区间为 **2010-01-04 至 2026-09-04**。完整历史单独检验，避免只看到 2010 年后的上涨阶段。

- 初始资金 10,000；月度检查，在当月第一个可用交易日的复权开盘报价重新计算并执行。每日收盘计价。5bp 单边费用，20bp 费用压力；逐日检查作为频率敏感性。
- 开盘报价既用于计算目标也用于成交，假定观察和执行之间零延迟。这不是“前一日收盘决定、次日开盘成交”的验证，真实延迟与盘口滑点仍需单独研究；20bp 只是费用压力，不能代替延迟检验。
- 使用复权总收益价格指数和可分割单位，股息隐含再投资；复权开盘价由当日 adj_close/raw_close 比例合成。不是逐笔真实股票与股息现金账本。现金收益 0、无杠杆、无做空、无税；终点按市值计价，不强制卖出。
- 最大回撤是每日收盘净值相对历史收盘峰值的回撤，包含初始建仓费用，不代表盘中最坏损失。
- 所有锚点、网格边界、参考份额都在各次回测实际入场时固定。没有根据结果移动锚点、筛选参数或优化窗口。
- 这些是已在旧项目中看过的历史，且科技股组合具有存续者与行业选择偏差。五年窗口相互重叠，胜率不构成独立试验的统计显著性。

当前生产算法使用估值信号并允许融资；本轮候选是无杠杆价格/相对价格策略。旧估值数据质量尚未修复，因此**本报告不声称已经跑赢生产算法，也不把价格信号冒充 S_Tech**。
''',
table(['资产','缓存起点','缓存终点','行数'], [[t, d['start'], d['end'], d['rows']] for t,d in audit['price_sources'].items()]),
'\n所有价格通过正值、排序、重复日期、完整 OHLC 及区间一致性检查；QQQ 文件哈希与旧审计记录一致。文件来源、哈希、EPS 质量检查见 `data-audit.json`。\n',
'## 主结果：全部候选与简单对照\n\n表中回报均已扣除交易费用。平均仓位为每日收盘股票市值占净值的算术平均，不能直接作为风险等价证明。\n']
for suite in ['QQQ','SMH','NVDA','GOOG','MSFT','TECH3','ETF2']:
    parts.append(f'### {suite}\n')
    rows = [[r['strategy'], pct(r['cagr']), pct(r['max_drawdown']), pct(r['average_stock_weight']),
             f"{r['terminal_equity']:,.2f}", f"{r['fees_paid']:,.2f}"] for r in primary if r['suite'] == suite]
    parts.append(table(['策略','净年化','最大回撤','平均股票仓位','期末净值','累计实付费用'], rows) + '\n')
parts += ['累计费用以账户货币表示；资金规模增长会增加后期费用，该列不是终点收益损失的精确数额。\n',
f'![主区间净值、仓位和回撤]({(HERE / "historical-overview.png").as_posix()})\n',
'''## 1. 凹势函数：有路径收益，但固定锚点逐渐降低参与率

QQQ 的 P-R1 年化 4.43%，回撤 7.92%，平均仓位 23.58%。拿它与 100% 买入持有直接比较会夸大防守优势：同样按 23.58% 设置的常数仓位，年化 4.48%，回撤 9.10%。P-R1 在这个标的上略微降低了回撤，但没有增加收益。

更重要的是，NVDA 的 P-R1 年化 6.30%、回撤 33.31%；按其平均仓位设置的常数仓位对照为 11.11%、19.68%。持续上涨中，价格远离初始锚点，势函数仓位越来越小，后期上涨参与率下降；早期下跌时却可能仍持有较高仓位。数学上的非负路径项并不能消除这个时间分布问题。

以下对照权重是在整段数据跑完之后确定的，属于**事后敞口诊断，不是预先可部署的策略**。平均仓位相等也不保证波动、市场 beta 或回撤相等。
''']
rows = []
for x in summary['exposure_controls']:
    r = get(x['suite'], x['strategy'][2:])
    rows.append([r['suite'],r['strategy'],pct(r['average_stock_weight']),pct(r['cagr']),pct(x['cagr']),pct(r['max_drawdown']),pct(x['max_drawdown'])])
parts.append(table(['资产','候选','对照目标仓位','候选年化','常数仓位年化','候选回撤','常数仓位回撤'], rows) + '\n')
parts.append('主区间 15 个凹势函数/资产组合的年化收益均低于各自平均敞口对照。这是本轮最直接的负面结果。\n')
parts += ['''## 2. 有限网格：能锁定盈利，也会长期停止工作

QQQ 的 G-10 主区间仅完成 1 次循环，累计锁定净利润 164.97，期末净值 10,164.97，平均股票仓位仅 0.60%。2020 和 2022 两个自然年净收益均为 0：价格早已离开初始网格上方。这解释了它的低回撤，也说明它没有持续捕获后续行情的震荡。

完整 QQQ 历史中，G-10 年化 0.89%、回撤 27.98%，仍不是高收益策略。保留初始资金 40% 的现金和锁定利润给出的是账户金额下界；它不承诺每个五年窗口都盈利，也不承诺相对不断变化的净值峰值有固定回撤上限。

失败例子同样存在：QQQ 2000–2004 五年累计，买入持有 -58.10%，P-R1 -31.79%，G-10 -20.49%。G-10 中途最大回撤 39.22%。锁定的已完成循环利润没有抵消未完成库存亏损。

因此，保留该例子作为“有限资本循环”的实验对照有价值，但本轮不支持把固定网格当作长期核心仓位。

## 3. 熵策略：值得继续研究相对价格循环，但不能只看捕获项

TECH3 中 E-025/E-1/E-4 年化分别为 32.15%/34.60%/36.33%，定期等权为 30.90%，固定份额持有为 37.25%。c 越大，策略越接近固定份额基准，因此本轮更高的收益不能解释成“更强的震荡捕获”。

E-025 的精确相对收益分解为：

`log(W / B_gross) = -0.867855 + 0.240415 - 0.003661 = -0.631101`。

- -0.867855：终点组合变得集中，生成函数下降。
- +0.240415：离散 KL 路径捕获项，累计乘数约 +27.18%。这是代数分解，包含相对趋势造成的份额变动，不能全称为往返震荡收益。
- -0.003661：交易费用留存项，乘数约 -0.37%。

最终 W/B_gross 约 0.5320。参考固定份额组合到终点的 NVDA 权重已经约 92.57%；终点集中度损失超过正的路径项，所以策略落后于基准。这是在实际数据中对“包围面积为正，并不保证总收益更高”的直接检验。

ETF2 中熵策略与等权调仓非常接近：E-025 年化 22.64%，等权 22.67%，买入持有 23.23%。相关性高、份额差异较小的两只 ETF 没有给出很强的独立优势。

2022 年 TECH3 的 E-025 亏损 39.39%，E-1 亏损 42.11%。完整共同历史从 GOOG 上市开始，三种熵策略最大回撤约 71%–73%。这类全股票策略回收相对变化，不能防止共同下跌。

## 4. 独立子账户混合：分散策略选择风险，收益被强者带动

QQQ 的 M-SINGLE 年化 12.37%、回撤 27.58%，介于其三个成员之间。TECH3 的 M-MULTI 年化 35.29%、回撤 54.20%，也没有超过最强单个成员。

混合账户的相对最强成员保证是终点财富不少于最强全资金成员的 1/M，等价于有限的对数财富差，不是保本或超额收益保证。随着买入持有成员增长，其自然资金权重会上升；主区间 M-SINGLE 的低起始股票配置并没有阻止后期风险上升。

## 横盘终点诊断：真实路径能够产生净利润

下面是在全部 104 个单标的五年窗口跑完后，**事后按买入持有终点总回报位于 -10% 至 +10% 筛出的全部 5 个窗口**。该标准没有用于交易，也没有用于选择参数；它只检验价格终点相近时的路径效应。它们并非每天窄幅横盘，中途包含大幅涨跌。表中“累计”是整段五年的收益，不是年化。
''', table(['资产','窗口','持有累计','50%调仓累计','P-R1累计','G-10累计','P-R1回撤','G-10回撤'], flat_rows),
'''\n例如 NVDA 2004–2008：买入持有累计 +2.66%，P-R1 +44.18%，G-10 +25.90%；但最大回撤仍分别达 41.17% 和 26.10%。这支持“无方向预测的仓位循环可能产生收益”，同时否定“震荡盈利意味着没有大额浮亏”的推断。

由于横盘终点筛选使用事后信息，不能据此推出能在事前识别出这些窗口。所有非横盘窗口也保留在 `cohorts.json` 中。

## 完整历史与起点稳健性

QQQ 完整区间从 1999-03-10 开始，经历互联网泡沫，而主区间从 2010 年开始。完整历史结果为：
''']
parts.append(table(['策略','净年化','最大回撤'], [[r['strategy'],pct(r['cagr']),pct(r['max_drawdown'])] for r in results if r['suite']=='QQQ' and r['tag']=='full_history']))
parts.append('\n从 2010 开始的低回撤不能直接推广到泡沫顶部入场。\n')
cohort_rows = []
for suite, ids, baseline in [('QQQ',['P-R1','P-R2','P-MIX','G-05','G-10','G-20','M-SINGLE'],'B-50'),
                             ('TECH3',['E-025','E-1','E-4','M-MULTI'],'B-EQUAL-MIX'),
                             ('ETF2',['E-025','E-1','E-4','M-MULTI'],'B-EQUAL-MIX')]:
    bases = {r['cohort_year']: r for r in cohorts if r['suite']==suite and r['strategy']==baseline}
    holds = {r['cohort_year']: r for r in cohorts if r['suite']==suite and r['strategy'] in ['B-STOCK','B-EQUAL-HOLD']}
    for id in ids:
        rr = [r for r in cohorts if r['suite']==suite and r['strategy']==id]
        cohort_rows.append([suite,id,len(rr),f"{sum(r['cagr']>bases[r['cohort_year']]['cagr'] for r in rr)}/{len(rr)}",
                            f"{sum(r['cagr']>holds[r['cohort_year']]['cagr'] for r in rr)}/{len(rr)}",
                            sum(r['net_return']<0 for r in rr),pct(min(r['cagr'] for r in rr)),pct(max(r['cagr'] for r in rr))])
parts.append(table(['资产','策略','窗口数','胜简单调仓','胜持有','亏损窗口','最低年化','最高年化'],cohort_rows))
parts += ['\nTECH3 三种熵策略在 17 个窗口中都只于 9 个窗口跑赢等权调仓、8 个窗口跑赢固定份额持有。本轮没有稳定全面胜出的证据。\n',
f'![逐年五年窗口的熵策略超额收益]({(HERE / "cohort-excess.png").as_posix()})\n',
'## 费用、频率和下跌期\n']
sens_rows=[]
for suite, ids in [('QQQ',['P-R1','P-R2','G-10','M-SINGLE']),('TECH3',['B-EQUAL-MIX','E-025','E-1','E-4','M-MULTI']),('ETF2',['B-EQUAL-MIX','E-025','E-1','E-4'])]:
    for id in ids:
        r=get(suite,id);d=get(suite,id,'daily_sensitivity');c=get(suite,id,'cost_sensitivity')
        sens_rows.append([suite,id,pct(r['cagr']),pct(d['cagr']),pct(c['cagr']),pct(r['annual_returns']['2022']['return'])])
parts.append(table(['资产','策略','月度5bp年化','逐日5bp年化','月度20bp年化','2022累计'],sens_rows))
parts += ['\n提高频率没有普遍提升收益；费用压力也没有改变主要排序。这不意味着实际交易延迟没有影响。网格没有使用日内高低价虚构阈值成交，只在检查时以实际检查报价成交。\n',
'''## 旧估值数据问题及附加起点结果

缓存 EPS 有缺季度问题。NVDA、MSFT 的近年记录多次从一个季度跨过下一个季度；GOOG 有连续年度缺第四季度及更长空档。旧计算取“最近四个记录”相加，记录不连续时不是真正 TTM。部分信号最近报告期距信号日达 759 天。虽然检查未发现使用尚未披露的 EPS，数据完整性依然不能通过。

另外，旧缓存 x 是“越便宜越大”的排名，新代码 x 是“越贵越大”的排名，需转换为 1-x。附加回测复用了旧 PE 代理首次低于 30% 的入场日期：NVDA 2018-12-03、GOOG 2018-05-01、MSFT 2019-02-01，并让所有候选从同日起步。这些只是**旧代理起点敏感性**，不能宣称已经验证连续季度 TTM 或真实估值策略。

若下一轮需要对生产估值算法做严格对照，应先修复 EPS 的连续季度、同比较基准、拆股口径及披露时点。SEC 文档也提醒 XBRL 期间起止日期存在公司间差异，不能只靠季度标签直接拼接：[SEC XBRL API 文档](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)。

## 初步取舍

1. **继续研究熵生成组合的理论与执行。** 它保留完整股票敞口且收益来源可精确分解；当前三股结果不足以证明优于简单基准。下一步需要扩展预先定义、含退市与不同相关性的资产池，并检验真实延迟。
2. **凹势函数保留为机制和风险对照。** 横盘终点窗口有真实正收益，但固定价格锚点的长期风险/收益结果并不理想。更换锚点或改用估值属于新候选，需要重新给出证明与冻结规则，不能在本轮结果上追加优化后宣称已获验证。
3. **固定有限网格不选为长期核心。** 保留其账本和资金下界实验，长期现金闲置的问题已经明确。
4. **混合子账户可作为研究组合。** 它减少事后选错策略的损失，尚未显示独立收益优势。

## 复现与检查

在仓库根目录运行：

```text
python research/historical/prepare.py
node research/historical/run.mjs
python research/historical/report.py
node --test research/strategies.test.mjs
```

Python 绘图依赖 pandas、matplotlib；缓存绝对路径位于 `prepare.py`，迁移机器需修改来源路径。冻结规则见 `protocol.json`，候选参数见上级 `candidates.json`。计算不需联网，首次安装缺失的绘图库可能需要联网。本机绘图依赖另存于 `C:/Users/jun/.cache/cycle-algorithm-research-python`，使用随附 `reproduce.ps1` 可直接复现。
''',
f"\n产生 {len(results)} 个主/敏感性/完整历史/代理起点结果、{len(summary['exposure_controls'])} 个事后敞口对照、{len(cohorts)} 个五年窗口策略结果。检查 {verification['account_snapshots_checked']:,} 个账户快照；{len(verification['exact_prefix_checks'])} 个历史适配器前缀一致性检查全部通过。最大对数恒等式残差 {verification['maximum_log_identity_residual']:.3g}，网格账本最大金额残差 {verification['maximum_grid_currency_accounting_residual']:.3g}。11 项策略测试全部通过。\n",
'''\n文件说明：

- `summary.json`：所有主结果、敏感性、全年收益、分解及敞口对照。
- `cohorts.json`：全部逐年五年窗口，包括失败窗口。
- `daily-primary.csv.gz`：主回测全部每日净值、仓位、现金、费用与成交额。
- `data-audit.json`：来源、哈希、价格与旧 EPS 数据问题。
- `verification.json`：自融资、无杠杆、收益分解、资金下界和前缀一致性结果。

生产目录 `src/` 未改动，旧项目数据未改动。本报告是算法研究的历史初筛，不是对未来收益的承诺。
''']
if (HERE/'screened-candidates.json').exists():
    screened = json.loads((HERE/'screened-candidates.json').read_text(encoding='utf-8'))
    parts.insert(1, '后续更新：已按用户要求完成等收益固定杠杆回撤筛选。当前通用候选清单为 '+
                 ('、'.join(screened['retained_candidate_ids']) if screened['retained_candidate_ids'] else '**空，11 个候选全部剔除**')+
                 '；本报告原来的研究优先级已被该筛选取代，完整结果见 [等收益回撤筛选](等收益回撤筛选.md)。原始回测保留供复核。\n')
(HERE/'初步回测分析.md').write_text('\n\n'.join(parts),encoding='utf-8')
# Small, uncompressed comparison table for straightforward reuse.
pd.DataFrame([{k:r[k] for k in ['suite','strategy','tag','frequency','one_way_cost','start','end','cagr','max_drawdown','average_stock_weight','terminal_equity','fees_paid']} for r in results]).to_csv(HERE/'summary-table.csv',index=False,encoding='utf-8-sig')
for source in audit['price_sources'].values():
    assert hashlib.sha256(Path(source['source_path']).read_bytes()).hexdigest() == source['source_sha256'], 'Source cache changed during replay'
artifact_names = ['../candidates.json','../strategies.mjs','protocol.json','prepare.py','run.mjs','report.py','reproduce.ps1',
                  'prices.json','data-audit.json','summary.json','cohorts.json','verification.json','daily-primary.csv.gz',
                  'summary-table.csv','初步回测分析.md','historical-overview.png','cohort-excess.png']
artifact_names += [name for name in ['screen-equal-return.py','equal-return-screen.json','equal-return-screen.csv','screened-candidates.json','等收益回撤筛选.md'] if (HERE/name).exists()]
manifest = {name: hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in artifact_names}
(HERE/'manifest.json').write_text(json.dumps({'sha256':manifest,'source_price_files_unchanged_after_replay':True},ensure_ascii=False,indent=2),encoding='utf-8')
print('Wrote initial analysis, two figures, and summary-table.csv')
