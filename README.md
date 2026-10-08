# Cycle Algorithm · 手动数据与组合计算

公开估值、价格、汇率和逐标的策略状态保存在仓库的 [data/](data/README.md)。网页读取这些项目文件，在浏览器计算策略。没有生产运行依赖，也没有自动采集、账户连接或自动交易。

每次打开网页手动输入标的市值或比例；这些输入只留在当前页面的内存中，刷新后清空，不进入公开数据、导出文件或网络请求。

## 日常使用

1. 打开网页，在“本次组合输入”添加标的，选择市值或比例，点击“计算本次组合”。比例自动归一化；市值须采用同一参考币种，或先手动维护汇率。
2. 在“数据查阅与维护”按标的、日期、来源筛选估值、价格、汇率。点击“查看 / 编辑”查看完整原始输入，修改评分或用 11 项基本面重新算分。
3. 页面修改暂留在内存。下载“项目数据包 ZIP”，解压后用其中的文件覆盖仓库 data/，检查差异并提交；也可直接在 GitHub 或本地编辑 CSV。
4. 提交到 main 后，GitHub Actions 校验数据、运行测试并发布页面。下一次打开网页会读取仓库中已发布的版本。

GitHub Pages 是静态网站。网页不保存 GitHub 凭据，也不直接写入仓库；导出本身不会替你提交。刷新前应导出尚未提交的数据修改。本次组合输入始终需要重填。

## 数据布局

```text
data/
  manifest.json              # 标的清单和文件路径
  valuations/NVDA.csv         # 月度评分、11 项原始输入、来源及修订
  prices/NVDA.csv             # 带日期和币种的公开价格
  valuations/AVGO.csv
  prices/AVGO.csv
  fx-rates.csv               # 手动维护的换汇汇率
  formal-events.json         # 逐标的月末信号和控制器状态
  README.md                  # 字段说明与新增步骤
```

CSV 每条记录一行，缺失数据留空；只有 N/A 状态可留空评分。不用 0 代替未知值。相同估值日期更新保留旧修订；价格以 symbol + as_of 唯一，汇率以 pair 唯一。Git 历史也保留每次文件修改。

当前迁入 2026-10-08 13:08 的旧系统导出：130 条估值修订、128 条当前日期价格，标的为 NVDA 和 AVGO。价格沿用旧导入器的 USD 口径，是对应估值的 price 输入，包含旧数据的调整口径，并非实时行情。来源插值及来源待核实标记保留。旧数据库当时未运行，迁入的是已有导出，不代表更晚数据库或旧浏览器中的修改。

导入旧 JSON 只提取公开估值、价格、汇率和兼容的逐标的状态。账户、持仓、数量、市值、比例、融资、自动任务和旧审计原始载荷不保存。旧控制器事件仅保留标的提示，以便首次新版正式信号从历史重放；旧 pending target 不可直接激活。

## 策略规则

计算模块仍为原有 pivot-hysteresis-v2：固定 60 个月、rho=0.9、目标杠杆 1.00–1.75 倍；各标的独立回放后按本次输入加权。任一标的不可计算时阻塞整个组合。比例与市值不能混用。

历史预览只对内部缺月临时插值，不外推，也不把插值写成原始记录；没有合格入场点时会提示预览强制入场。正式入场仍严格要求 x<30%，月末生成 pending，下一月手动激活。正式状态也需要随公开数据提交。

数学与合成验证见 [控制器 v2](docs/hysteresis-v2.md)。研究目录保留独立、冻结的研究材料，不参与网页数据加载。

## 开发与验证

Node.js 22 或以上，无需安装生产依赖：

```powershell
npm run validate:data
npm test
npm run build
npm run preview
```

本地预览：`http://127.0.0.1:8788/cycle-algorithm/`。部署见 [DEPLOYMENT.md](DEPLOYMENT.md)。浏览器集成检查使用开发用 Playwright：`node tests/browser-smoke.mjs`。

一次性数据库导出器只读取 assets 和 valuation_history；不是日常运行依赖：

```powershell
python -B scripts/export_legacy.py --engine C:\strategy-directus\engine --env C:\strategy-directus\.env
node scripts/import-project-json.mjs private-exports/public-market-data.json
npm run validate:data
```

导入脚本合并文件前会检查已有 manifest；新增或整批替换后仍应检查差异和数据校验结果。
