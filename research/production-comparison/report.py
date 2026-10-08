import json
from pathlib import Path
HERE=Path(__file__).resolve().parent
data=json.loads((HERE/'results.json').read_text());rows=data['results']
ids=['PRODUCTION-PE-PROXY','AY-50','AY-75','RV-10','RV-20','BUY-HOLD-1x']
labels={'PRODUCTION-PE-PROXY':'原策略','BUY-HOLD-1x':'1x买入持有'}
def table(headers,body):
    return '\n'.join(['| '+' | '.join(headers)+' |','|'+'|'.join(['---']*len(headers))+'|']+
                    ['| '+' | '.join(map(str,row))+' |' for row in body])
def pick(s,i,tag='proxy_entry'):return next(x for x in rows if x['suite']==s and x['strategy']==i and x['tag']==tag)
def pct(x):return f'{100*x:.2f}%'
main=table(['标的','起点','策略','年化净收益','累计净收益','最大回撤','等收益杠杆','对照回撤','判断'],
 [[s,(x:=pick(s,i))['start'],labels.get(i,i),pct(x['cagr']),pct(x['total_return']),pct(-x['max_drawdown']),
   f"{x['fixed_leverage']:.4f}x" if 'fixed_leverage' in x else '—',
   pct(-x['fixed_max_drawdown']) if 'fixed_max_drawdown' in x else '—',x['status']]
  for s in ['NVDA','GOOG','MSFT'] for i in ids])
checks=table(['标的','检查','原策略年化','原策略回撤','对照回撤','判断'],
 [[x['suite'],x['tag'],pct(x['cagr']),pct(-x['max_drawdown']),
   pct(-x['fixed_max_drawdown']) if 'fixed_max_drawdown' in x else '未匹配',x['status']]
  for x in rows if x['strategy']=='PRODUCTION-PE-PROXY' and not x['suite'].startswith('SYN-')])
syn=table(['预先固定的震荡路径','原策略累计收益／回撤','AY-50','AY-75','RV-10','RV-20','1x买入持有'],
 [[s.replace('SYN-','')]+[f"{pct((x:=pick(s,i))['total_return'])} / {pct(-x['max_drawdown'])}" for i in ids]
  for s in ['SYN-wide_slow','SYN-wide_fast','SYN-small_fast','SYN-very_small_slow']])
report=f'''# 原策略与固定候选的配对诊断

**原策略值得保留；已有候选没有证明优于它。** 在三个旧科技股、同日起步的 PE 代理诊断中，原策略收益最高，并全部通过等收益固定杠杆回撤比较。但原策略绝对回撤显著较大，且真实 S_Tech 历史不足，不能把本报告当成生产策略的合格实盘回测或外部资产通用验证。

## 可比较的范围与输入限制

直接调用当前 src/strategy.js 的 Controller、Account 和 dailyCloseStep，没有移植控制器公式或修改生产参数。原策略 60 月估值排名、x<30% 入场门槛、ρ=0.9、目标融资杠杆 1—1.75、2.25 强制降杠杆阈值全部保留。候选为冻结的 AY-50、AY-75、RV-10、RV-20。

真实历史部分只拥有 NVDA、GOOG、MSFT 的旧 PE 排名缓存，其 EPS 季度有缺漏，不是经过验证的连续季度 TTM，也不是 S_Tech。旧 x 越便宜越大，本报告取 1−x，变为当前控制器使用的昂贵程度。检查缓存记录中的 latest_eps_filing 不晚于信号日期；这不能修复底层 EPS 质量、拆股及历史修订的问题。

当前 S_Tech 还需要当时的 EPS_NTM、90 天前 EPS_NTM、收入预测、第二阶段增长率，以及实际现金流、股权激励和净利润。现有报价无法恢复这些历史输入，也不能用今天的预测回填过去。SEC 的公开接口提供申报文件和财务报表 XBRL，不能据此假定已获得完整历史分析师预测：[SEC API 文档](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)。所以新下载的 GLD、TLT 等外部标的没有被强行套上不适用的科技估值公式。

## 同日期、同费用的历史配对

三股分别从原控制器首次满足旧代理入场门槛后的实际交易日起步，候选从同一日开盘入场，全部截止 2026-09-04。原策略等待入场前的机会成本不计入该表，所以这不是从 2010 年共同现金账户出发的完整策略比较。初始资金 10,000，单边费用 5bp，现金利息零，融资年率 5.3% 按实际日数计息。月末信号下一交易日开盘执行；原策略的收盘强制降杠杆保留。

{main}

原策略通过的回撤优势分别约 **6.59、5.27、3.81 个百分点**。AY 两个实例也各通过 3/3；RV 两个实例各通过 1/3。

较高收益不能全部归因于循环机制，因为原策略允许融资、候选最多 1x。等收益杠杆比较说明，在这些输入和区间上，原策略的敞口路径优于所匹配的固定杠杆路径；仍不能证明它在整个收益—风险前沿上支配其他候选。各策略的匹配收益水平不同，回撤优势百分点也不是可直接相加的排名分数。

## 区间、费用与成交时点敏感性

{checks}

三个标的的默认起点、次日收盘成交、20bp 费用和 2020 起点共 12 项均通过。2022 重置中 NVDA 通过，GOOG、MSFT 未匹配，因此合计是 **13 个通过、2 个未解决、0 个明确回撤失败**。不能把未匹配说成通过。2020/2022 的原策略按前一个已知月末估值强制入场，各策略均重置为 10,000；这是入场敏感性，不是默认门槛策略的完整历史。

固定杠杆对照沿用上一轮按月复位、0x—3x 搜索、多个有效解取最低杠杆的规则。融资成本可使终值随杠杆非单调，连 1x 买入持有在某些合成路径也可能有另一个更低杠杆等收益解；不保证任意目标收益都能匹配。每日收盘回撤含初始本金。原策略强制减仓在收盘价即时执行是假定，没有日内触发价、延迟成交或真实保证金强平模型。

## 不靠单边上涨的合成检查

复用项目已有的四条固定合成路径，没有看到新结果后改振幅或周期。前 60 月价格由约 70.47 单调升至 100，之后 120 月为 100·exp(A·sin(2πt/T))；(A,T) 分别为 (0.35,24)、(0.35,12)、(0.025,6)、(0.005,24)。完整前后价格锚点相同，账户入场时点由原策略决定，故入场到终点的买入持有收益不一定为零。月内用平滑日收益并仅保留周一到周五，不是假定真实市场必然如此。

各基本面固定为已有脚本的输入，通过真实 computeTechValuation 算出 S_Tech=C/P，再调用 valuationState，不使用 PE 代理；高低点没有被预先告知控制器。候选从相同入场日开始。每格为累计净收益／日收盘最大回撤；与股票表的年化收益不可混淆。

{syn}

这组受控路径里，原策略在大幅循环的累计收益远高于四个候选，说明它的迟滞路径在特定震荡结构下确实能形成净收益。但极小慢周期中，循环收入不足以覆盖融资成本，原策略亏损约 6.25%，并明确未通过等收益回撤检查。因此“震荡必赚”仍不成立。其他三条合成路径的原策略终值未找到 0x—3x 等收益固定杠杆解，收益优势不替代用户要求的回撤资格判定。

合成价格平滑且重复，固定基本面让估值与价格严格反向，条件对迟滞机制有利；真实盈利预期变化、跳空、滚动排名漂移会改变这层关系。它是机制诊断，不是新增市场样本外证据。

## 判断与验收

原策略更贴近最初的“不同调仓路径产生循环收益”目标，值得作为核心研究对象保留。AY 是较低敞口的风险对照，RV 在这次配对中没有提供普遍优势；目前没有根据替换生产策略。

真正要判断原策略是否优于候选，缺少的是连续、可追溯到当时披露／预测时点的 S_Tech 历史，然后把它加入同一批留出标的及五年起点检验。不能把旧 PE 代理当作这一步已经完成。

当前生产单元测试 9/9 通过；本适配器 27 条路径通过前缀一致检查、27 项 1x 买入持有对照校验；四条次日收盘合成路径与旧生产验证报告逐一对账，累计收益误差小于 10⁻¹⁰。资金守恒最大残差约 {data['verification']['maximum_trade_residual']:.3g}。协议、源文件哈希及检查在 protocol.json、results.json 中；全部 162 条配对结果在 comparisons.csv；日路径在 production-paths.json，输入及原始来源不改写。

复现：本机运行 run.py 后运行 report.py；需要 Node 和已有 numpy 的 Python。原估值缓存来源路径写于协议。README 不会把本诊断计入外部资产通过数量。
'''
(HERE/'原策略配对比较.md').write_text(report,encoding='utf-8')
print(HERE/'原策略配对比较.md')
