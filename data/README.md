# 人工维护的公开市场数据

这里保存公开的估值、价格、汇率和逐标的策略状态。每次计算输入的持仓、市值、数量和比例不属于本目录的数据。

## 文件用途

| 文件 | 用途 | 唯一标识 |
|---|---|---|
| manifest.json | 标的清单、名称、文件路径 | symbol |
| valuations/SYMBOL.csv | 月度评分、原始基本面、来源及修订 | id；同日仅一条 is_current=true |
| prices/SYMBOL.csv | 某日价格及币种 | symbol + as_of |
| fx-rates.csv | 两种币种的换汇汇率 | pair |
| formal-events.json | 正式月末控制器事件和旧版重放标的提示 | events 中的 id |

CSV 可用文本编辑器、Excel 或 GitHub 文件编辑器查看。每行一条记录，日期为 YYYY-MM-DD，数值用点作小数点；修改时保留全部表头。备注含逗号、换行或双引号时用 CSV 双引号规则。缺失数值留空，不填虚构的 0。

## 估值列

| 列 | 含义 |
|---|---|
| id | 记录标识。新记录可手写如 NVDA-2026-09-r1 |
| symbol / valuation_date | 标的及观测日期，通常填月末 |
| status | valid 或 na；na 的 s_tech 留空 |
| s_tech | 固定估值评分，越高越便宜 |
| score_method | manual：人工给定评分；formula：11 项输入算分，程序检查结果一致 |
| price | 该估值日期使用的价格，沿用标的报价币种 |
| eps_ttm / eps_ntm / eps_ntm_90d | 过去 12 月 EPS、未来 12 月 EPS、90 天前同口径预测 |
| revenue_ttm / revenue_ntm | 过去 / 未来 12 月收入，同一单位 |
| g_revenue_2 / g_eps_2 | 第二阶段预计增速，用小数，30% 填 0.30 |
| fcf_ttm / sbc_ttm / ni_ttm | 自由现金流、股权激励、净利润，统一金额单位 |
| source_code / source_url / source_institution | 来源代码、链接及机构 |
| as_of_period / evidence_summary / notes | 数据期、证据简述、备注 |
| interpolated | true 表示来源中的估计或插值；false 表示不是来源插值 |
| provenance | observation、source-interpolated、legacy-unknown |
| is_current / revision / supersedes | 是否当前修订、正整数修订号、被替代记录 id |
| observed_at / source_timestamp / retrieved_at | 观测、来源和获取时间；未知留空 |

直接评分可以没有基本面输入。formula 必须填全 11 项；缺输入或结果不一致会阻止构建。网页的临时缺月插值不会写进文件，来源插值则必须注明。网页编辑保留旧修订；直接编辑 CSV 时建议把旧行 is_current 改为 false，新增 revision+1 的当前行，并填写 supersedes。

## 价格与汇率

价格列：symbol、as_of、price、currency、source_name、source_url、notes、retrieved_at。价格须为正数，日期和币种必填。价格文件与估值中的 price 是不同用途：改行情记录不会悄悄重算过去评分。需要重算时，修改对应估值输入并用公式创建修订。

汇率列：pair、as_of、rate、source_url、notes、retrieved_at。EUR/USD=1.10 表示 1 EUR 换成 1.10 USD。可以只填一个方向，程序可取倒数；同一 pair 保存一条当前使用记录，历史变化由 Git 保留。没有异币种输入时可以不填汇率。日期和来源便于检查，程序不会自动更新或抓取报价。

## 新增标的

1. 复制 public/templates/valuation-history.csv 和 prices.csv，分别存为 valuations/SYMBOL.csv、prices/SYMBOL.csv。即使暂无价格，价格文件也保留表头。
2. 在 manifest.json 的 assets 数组新增 `{ "symbol": "SYMBOL", "name": "名称", "valuations": "valuations/SYMBOL.csv", "prices": "prices/SYMBOL.csv" }`。文件路径严格与大写 symbol 对应。
3. 填真实数据。需要至少覆盖 60 个月才可预览；内部缺月会明示临时插值，不外推两端。
4. 执行 `npm run validate:data`、`npm test`、`npm run build`，检查文件差异后提交到 main。

也可在网页添加数据，下载项目 ZIP 并解压覆盖 data/。ZIP 不含本次输入的市值、比例或持仓。不要把旧完整账户备份直接复制进此目录。

## 迁入数据的范围

来源为旧系统 2026-10-08 13:08 的现有导出，NVDA / AVGO 共 130 条估值修订（128 条当前记录），以及 128 条从当前估值 price 输入提取的日期价格。保留原始数字、全部修订和来源标记；旧资料没有独立观测标记的月份沿用 legacy-unknown。

价格沿用旧供应商 price_usd_split_adjusted_month_end_or_latest 字段的 USD 口径，包含旧供应商调整口径，并非实时价格。汇率初始为空，请在使用异币种市值前手动填入。旧账户和持仓未迁入。更晚的旧浏览器修改不会自动带入。
