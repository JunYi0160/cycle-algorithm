"""Render all held-out results without changing candidates or rerunning selection."""
import csv
import hashlib
import json
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap, BoundaryNorm

HERE = Path(__file__).resolve().parent
read = lambda name: json.loads((HERE/name).read_text(encoding='utf-8'))
r = read('results.json'); cohorts = read('cohorts.json'); audit = read('data-audit.json')
verify = read('verification.json'); frozen = read('frozen.json')
ids = r['protocol']['retained_research_candidates']; suites = list(r['suites'])
rows = r['required'] + r['stress'] + cohorts
fields = ['strategy','suite','tickers','tag','stress','cohort_year','start','end','cost',
          'extra_signal_delay','terminal_equity','total_return','cagr','max_drawdown',
          'fixed_leverage','fixed_cagr','fixed_max_drawdown','candidate_worse_drawdown_by',
          'status','average_stock_weight','fees_paid','turnover','trade_days',
          'relative_terminal_matching_error','max_sampled_fixed_leverage',
          'max_sampled_fixed_equity','candidate_above_sampled_fixed_max']
with (HERE/'all-comparisons.csv').open('w',encoding='utf-8-sig',newline='') as f:
    writer = csv.DictWriter(f,fieldnames=fields,extrasaction='ignore'); writer.writeheader()
    for row in rows:
        x = dict(row); x['tickers'] = '+'.join(x['tickers'])
        x['total_return'] = x['terminal_equity']/10000-1
        writer.writerow(x)

primary = {(x['suite'],x['strategy']):x for x in r['required'] if x['tag']=='primary'}
full = {(x['suite'],x['strategy']):x for x in r['required'] if x['tag']=='full_history'}
colors = ListedColormap(['#d96662','#dddddd','#52a987'])
fig, axes = plt.subplots(1,3,figsize=(13,11),gridspec_kw={'width_ratios':[1,1,1.1]})
for ax, title, data in [(axes[0],'2010-01-04 to 2026-09-04',primary),
                        (axes[1],'Full available history to 2026-09-04',full)]:
    matrix = np.array([[{'reject':0,'unmatched':1,'pass':2}[data[(s,i)]['status']]
                        for i in ids] for s in suites])
    ax.imshow(matrix,cmap=colors,norm=BoundaryNorm([-.5,.5,1.5,2.5],3),aspect='auto')
    for y,s in enumerate(suites):
        for x,i in enumerate(ids):
            row=data[(s,i)]; gap=row.get('candidate_worse_drawdown_by')
            ax.text(x,y,'N/A' if gap is None else f'{100*gap:+.2f}',
                    ha='center',va='center',fontsize=9)
    ax.set_title(title,fontsize=11); ax.set_xticks(range(4),ids,rotation=30)
    ax.set_yticks(range(len(suites)),suites)
    ax.set_xlabel('Drawdown excess vs equal-return control (pp)')
matrix=np.array([[next(v for v in d['per_asset'] if v['suite']==s)['passed']
                  for d in r['decisions']] for s in suites])
axes[2].imshow(matrix,cmap='YlGn',vmin=0,vmax=8,aspect='auto')
for y in range(len(suites)):
    for x in range(4): axes[2].text(x,y,f'{matrix[y,x]}/8',ha='center',va='center',fontsize=9)
axes[2].set_title('Four periods + four stress checks',fontsize=11)
axes[2].set_xticks(range(4),ids,rotation=30); axes[2].set_yticks(range(len(suites)),suites)
axes[2].set_xlabel('Passing checks (unmatched is unresolved)')
fig.suptitle('Frozen candidates on 18 held-out assets + 4 predeclared baskets',fontsize=14)
fig.text(.5,.018,'Green: pass   Red: worse drawdown   Gray: no equal-return match in 0x-3x search\n'
         'Daily-close drawdown; monthly execution; fees and borrowing included. Asset holdout, not prospective proof.',
         ha='center',fontsize=10)
fig.tight_layout(rect=[0,.055,1,.96]); fig.savefig(HERE/'external-validation.png',dpi=170); plt.close(fig)

def table(headers,body):
    return '\n'.join(['| '+' | '.join(headers)+' |','|'+'|'.join(['---']*len(headers))+'|']+
                    ['| '+' | '.join(map(str,row))+' |' for row in body])
def pct(value): return f'{100*value:.2f}%'
def control(row): return '未匹配' if 'fixed_max_drawdown' not in row else pct(-row['fixed_max_drawdown'])
summary = table(['候选','主区间','完整历史','四区间合计','费用／延迟压力','五年起点','未匹配：区间／五年'],
    [[d['strategy'],f"{d['primary_passed']}/22",f"{d['full_history_passed']}/22",
      f"{d['required_passed']}/88",f"{d['stress_passed']}/88",f"{d['cohort_passed']}/460",
      f"{d['required_unmatched']}/{d['cohort_unmatched']}"] for d in r['decisions']])
main_table = table(['标的／组合','AY-50 年化／回撤／对照回撤','AY-75 年化／回撤／对照回撤',
                    'RV-10 年化／回撤／对照回撤','RV-20 年化／回撤／对照回撤'],
    [[s]+[f"{pct(primary[s,i]['cagr'])} / {pct(-primary[s,i]['max_drawdown'])} / {control(primary[s,i])}"
           for i in ids] for s in suites])
coverage = table(['标的','有效日线数','最早日期','截止日期'],
    [[s,audit['sources'][s]['rows'],audit['sources'][s]['start'],audit['sources'][s]['end']]
     for s in r['protocol']['single_assets']])
nontech = [x for x in r['required']+r['stress'] if x['suite']=='NONTECH6' and x['strategy']=='AY-50']
nontech_table = table(['检查','年化收益','策略回撤','等收益对照回撤','回撤优势（百分点）'],
    [[x['tag']+('/'+x['stress'] if 'stress' in x else ''),pct(x['cagr']),pct(-x['max_drawdown']),
      control(x),f"{-100*x['candidate_worse_drawdown_by']:.4f}"] for x in nontech])
report = f'''# 固定候选的外部标的验证

保留 AY-50、AY-75、RV-10、RV-20 四个研究候选，参数和第二轮执行器没有修改。新增 18 个此前未用于候选构造的单标的、4 个预先指定组合，完成 2,544 项等收益回撤比较。**本轮仍没有通过全部检查的通用策略。** 保留研究定义不等于恢复已被淘汰的通用资格。

主区间：2010-01-04—2026-09-04；下载数据实际截止 2026-10-07。

## 1. 总结果

{summary}

“通过”严格沿用用户规则：找到最终净收益相同的固定杠杆路径，策略最大回撤不得更大。分母包含未匹配情况；未匹配记为未解决，不记为回撤失败。各标的、相邻五年窗口有相关性，这些比例不是独立试验的成功概率，也没有统计显著性含义。没有根据本轮结果调整任何参数、删除失败标的或选择通过率门槛。

![全部外部标的结果](external-validation.png)

## 2. 应当保留什么

- **AY-50：优先继续研究。** 完整历史通过 21/22，唯一失败为 XLE；但主区间只有 8/22，五年起点只有 146/460。长历史表面优势对入场时点敏感，不能用完整历史覆盖短窗口失败。
- **AY-75：作为同机制的敞口对照保留。** 没有任何单标的／组合通过全部八个区间与压力检查；更高参与率没有消除路径依赖。
- **RV-10：保留低优先级研究实例。** 主区间 4/22，此前科技三股组合优势未广泛迁移。GLD、NEE、JNJ、MULTIASSET4 在主区间通过，但不因此重新定义适用资产池。
- **RV-20：保留原始定义及失败记录，降低研究优先级。** 主区间只有 GLD 通过；能源上大幅劣于等收益对照。不能把较高目标波动当成稳健增强收益的方法。

只有 **AY-50 / NONTECH6** 通过四区间和四压力共 8/8 检查。NONTECH6 是下载前指定的 JPM、XOM、JNJ、PG、CAT、NEE 初始等资金固定份额组合。该组合五年起点仅通过 **12/22**；2014—2019 回撤优势约 **0.002 个百分点**，非常薄，不能视为可靠经济优势。

{nontech_table}

数学机制也解释了局限：AY 只随新的价格峰值减少单位数、把所得保留为现金。长期上涨中它改变回撤时的敞口路径，但在旧峰值以内反复震荡时没有持续买回、卖出的获利循环。RV 的风险估计有滞后，突跌发生前无法提前降低仓位，价格恢复时也可能仍保持低仓位。因此这些结果并未实现“任意震荡市场也持续盈利”的目标。

## 3. 主区间的完整比较

每格依次为策略年化净收益、策略最大回撤的正幅度、等收益固定杠杆最大回撤的正幅度。最终累计收益和匹配杠杆值均在 all-comparisons.csv 中；同一期间匹配累计收益也匹配年化收益。

{main_table}

例如 XLE / RV-20 年化收益约 **3.97%**，最大回撤 **69.06%**；达到相同最终收益的约 **0.3759x** 对照回撤仅 **32.28%**，明确淘汰其在此标的上的资格。

TLT 的 RV 两个实例在主区间及完整历史未找到等收益对照。主区间年化分别约 2.630%、2.457%，已扫描的有效 0x—3x 固定杠杆路径最高约 2.428%。这属于对照匹配范围内未解决的案例，不应直接说策略回撤更差或宣布通过；网格最大值也不是连续杠杆最优化的证明。其他已有明确失败的标的仍足以否定通用资格。

## 4. 防止回测结果反向决定策略

候选、18 个单标的和 4 个组合于 **{frozen['frozen_utc']}** 冻结后才开始下载；frozen.json 保存协议、参数、执行器与对照的 SHA-256。未沿用或优化任何已有资产的最优参数；没有修改生产策略。

固定候选的可执行规格位于 retained-candidates.json：

- AY：初始风险资产权重 α=0.50 或 0.75；初始单位 q₀，在月初按昨日已知峰值 M 执行 q=min(当前 q, q₀·(M/P₀)^(α−1))。销售收入留在现金。
- RV：日对数收益平方的指数平均 v，半衰期 63 个交易日，λ=2^(−1/63)，v←λv+(1−λ)r²；月初风险资产权重 w=min(1,目标波动/√(252v))。目标为 10% 或 20%，初始年化风险估计 20%。

各区间分别重新初始化，四区间为主区间、各标的完整可用历史、2014—2019、2020—主截止日。压力检查在主区间和完整历史分别使用 20bp 费用及额外一天信号延迟。五年检查为 2000—2021 各年一月入场、拥有完整五年资料的全部窗口，共 460 个窗口／候选。

这是**资产留出验证**。SPY 和原科技资产重叠，其他资产也有共同宏观风险；现存 ETF 和大型股票有选择及幸存者偏差，不能声称独立、无偏的全市场样本外验证。现有长历史还包含大量早已发生的行情。

另从主区间账户状态连续运行 2026-09-08—2026-10-07，共 22 个交易日，保存 time-extension.json。该段发生于规则冻结之前，是此前未使用的历史时间延伸，**不是规则冻结后的真正前瞻样本**；期间不重置账户、对照沿用主区间匹配杠杆，不用新段结果重新匹配。

## 5. 数据与统一记账

18 个标的合计 **{sum(audit['sources'][s]['rows'] for s in r['protocol']['single_assets']):,}** 条有效日线。原始 Yahoo chart JSON、分红拆股事件、获取时间、来源 URL、哈希全部留存。价格数据截至 2026-10-07，18 个标的均取得有效资料，没有因策略失败删除任何数据。

{coverage}

ETF 范围可查发行方：[SPDR 行业基金](https://www.ssga.com/us/en/individual/capabilities/equities/sector-investing/select-sector-etfs)、[iShares 基金目录](https://www.ishares.com/us/products/etf-investments)、[GLD](https://www.spdrgoldshares.com/usa/gld/)、[TLT](https://www.ishares.com/us/products/239454/TLT)。历史报价来自 Yahoo，发行方链接用于核对资产身份，不作为行情来源。

调整开高低价统一乘以 adjusted close / raw close，避免开盘与收盘复权口径混用；分红再投资包含在调整价格指数中，不二次派发。缺失、重复、非正价格和 OHLC 关系均检查；组合只对齐真实共同交易日，不填造价格。额外下载 QQQ 仅用于旧缓存口径复核，不计入新标的：6,916 个重叠日期的最大日收益差约 1.89×10⁻⁶。

组合均为入场时等资金、以后固定份额的价格指数：US-SECTOR4=XLF/XLE/XLV/XLP；GLOBAL3=SPY/EFA/EEM；MULTIASSET4=SPY/EFA/GLD/TLT；NONTECH6=JPM/XOM/JNJ/PG/CAT/NEE。策略管理整个指数的单位数，没有暗中进行成分等权再平衡。

统一初始资金 10,000，月初可用开盘成交，昨日收盘产生信号，单边比例费用 5bp；策略不借款、不做空，现金收益与税为零。对照按月复位固定风险资产杠杆，1x 与买入持有一致，低于 1x 余款为零利息现金，高于 1x 借款按年率 5.3% ACT/365 计息。0x—3x 扫描后求根，多个可偿付解使用最低杠杆解；对照终值匹配最大相对误差 **{verify['maximum_equal_return_relative_terminal_error']:.3g}**。

回撤按日收盘净值计算，初始本金计入历史峰值；没有日内路径、税务、真实买卖点差、保证金强平或现金利息建模。使用可分割的复权价格指数份额，属于可比研究记账模型，不是完整经纪账户模拟。

资金守恒最大误差 {verify['maximum_self_financing_currency_residual']:.3g}；验证 1x 对照等于买入持有、88 条时间前缀一致、88 条当天收盘变化不影响当天交易状态。verification.json 保存完整检查与哈希。

## 6. 文件与复现

- [冻结规则](protocol.json)、[候选定义](retained-candidates.json)、[冻结哈希](frozen.json)、[资格清单](research-status.json)。
- [复权日线](prices.json)、[数据审计与全部来源](data-audit.json)、raw/ 原始响应。
- [全部比较表](all-comparisons.csv)：2,544 条，保留失败和未匹配；[主要与压力结果](results.json)、[全部五年窗口](cohorts.json)。
- [日净值及仓位](daily-primary.csv.gz)、[连续时间延伸](time-extension.json)、[实现检查](verification.json)。
- 本机运行 reproduce.ps1，优先重用已保存的原始响应，重新生成规范数据、回测及报告。冻结文件发生变化即报错；依赖 Python/numpy/matplotlib，本机运行路径写于脚本。

下一步研究应围绕机制解释和事先固定的新测试规则；本轮外部数据已被查看，不能再用其挑参数后宣称同一批数据是未见样本。
'''
(HERE/'样本外标的验证.md').write_text(report,encoding='utf-8')
manifest = {'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in
                     [HERE/'all-comparisons.csv',HERE/'results.json',HERE/'cohorts.json',
                      HERE/'prices.json',HERE/'verification.json',HERE/'time-extension.json']},
            'report_uses_all_predeclared_assets':True,'comparison_rows':len(rows)}
(HERE/'artifact-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps({'report':str(HERE/'样本外标的验证.md'),'comparisons':len(rows),'chart':str(HERE/'external-validation.png')}))
