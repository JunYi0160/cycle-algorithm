# Cycle Algorithm · 持仓比例与 Antigravity 自动补数

静态网页在浏览器中计算策略与组合目标杠杆。用户日常仅维护当前持仓比例；系统通过本机 Google Antigravity CLI 自动联网补足公开报价与历史估值数据，由项目原有确定性估值与控制器算法推演各标的杠杆，按持仓相对权重加权输出组合目标杠杆。

严格遵循**零 API 额外费用**原则：强制锁定 `useG1Credits: false`，仅消耗用户 Antigravity 套餐内基础额度（含周额度池），不启用任何付费 Gemini API、Vertex AI 或外部收费接口。

---

## 1. 核心架构与工作流程

```text
用户输入/更新持仓（市值模式 / 股数模式 / 直接比例模式）并保存
  │
  ▼
前端本地检查：缓存有效性、最新报价、各标的 60 个月历史连续性
  │
  ├─ 数据已齐备 ──► 原有确定性算法回放各标的控制器 ──► 组合加权目标杠杆
  │
  └─ 有缺失（新标的 / 缺最新报价 / 历史缺月）
       │
       ▼
     自动向本机助手 (http://127.0.0.1:8789) 提交补数任务
       │
       ▼
     本机助手预检费用保护 (useG1Credits: false) 并调用 agy CLI
       │
       ▼
     获取公开财务披露 (SEC/IR) 与分析师一致预期，附带来源与证据
       │
       ▼
     前端通过 computeTechValuation 校验并计算 S_Tech 评分
       │
       ▼
     幂等合并估值修订、更新权重、重新推演组合目标杠杆
```

---

## 2. 快速开始（Windows 本机一键启动）

### 2.1 环境准备
1. **Google Antigravity CLI (`agy`)**：
   - 官方 Windows 原生 CLI 已安装（如 `%LOCALAPPDATA%\agy\bin\agy.exe` 或用户 PATH）。
   - 首次登录：在命令行执行 `agy auth login` 完成 Google 账号登录。
   - 费用保护设置：`%USERPROFILE%\.gemini\antigravity-cli\settings.json` 中已配置：
     ```json
     {
       "useG1Credits": false,
       "permissions": {
         "allow": [
           "read_url(*)"
         ]
       }
     }
     ```
   - 本机助手在每次调用前均会**强制重写并核验** `useG1Credits: false`，杜绝任何意外扣费。

2. **Node.js**：Node.js 22+（本项目自带 Node 环境脚本，无需安装额外 npm 运行时依赖）。

### 2.2 一键启动助手与本地应用
在项目根目录下双击运行：
```cmd
scripts\start-helper.cmd
```
或在 PowerShell 中执行：
```powershell
.\scripts\start-helper.ps1
```
启动脚本将自动检测端口、核验费用设置，启动本地助手守护进程并自动打开浏览器访问：
- **本地完整入口**：`http://127.0.0.1:8789/cycle-algorithm/`
- **助手 API 状态**：`http://127.0.0.1:8789/api/status`

也可在 GitHub Pages 线上地址（`https://junyi0160.github.io/cycle-algorithm/`）运行，现代浏览器在授权 Private Network Access 后即可直接与本机助手通信。

---

## 3. 持仓模式与策略行为

### 3.1 三种持仓输入模式
- **市值模式**（推荐）：输入标的 + 市值 + 币种（如 `NVDA`, `15000`, `USD`）。无需填股数，无需抓取当天价格；异币种持仓按公开汇率自动折算。
- **股数模式**：输入标的 + 股数（如 `AAPL`, `100`）。系统自动通过 Antigravity 获取最新公开收盘报价并换算为参考币种市值。
- **直接比例模式**：输入无单位数值（如 `75`, `25`），系统自动归一化为 75% 与 25%。直接比例模式禁止与货币金额混用。

### 3.2 权重与加权杠杆计算
$$w_i = \frac{v_i}{\sum_j v_j}, \quad L_{\text{portfolio}} = \sum_i (w_i \times L_i)$$
- **比例不变性**：将所有持仓市值等比例缩放（如全部乘以 2），持仓权重和组合目标杠杆严格保持不变。
- **逐标的独立回放**：每个标的根据各自 60 个月历史评分完整回放独立控制器路径（$\rho=0.9$, 目标杠杆区间 $1.00–1.75\times$），再行加权汇总。严禁将各标的评分或百分位平均后输入单一控制器。
- **严格阻塞**：任何持仓缺少有效报价、汇率或连续 60 个月估值时，整个组合目标杠杆显示为阻塞状态（`—`），绝不静默剔除问题持仓。
- **解耦旧账户指标**：默认界面彻底移除旧版股票总市值 A、借款/现金 B、净值 E、实际杠杆以及虚构交易金额等不必要字段。

---

## 4. 自动估值与真实数据保证

权威算分函数位于 [`src/valuation.js`](src/valuation.js)，输入必须包含完整的 11 项原始数据：
- `price`（月末收盘价）
- `eps_ttm` / `eps_ntm` / `eps_ntm_90d`（一致预期及 90 天前一致预期）
- `revenue_ttm` / `revenue_ntm`
- `g_revenue_2` / `g_eps_2`（下一阶段预期增长率，小数形式）
- `fcf_ttm` / `sbc_ttm` / `ni_ttm`（现金流与利润质量项）

### 真实性与缺失处理
- **杜绝数据幻觉**：大模型仅负责检索与提取公开披露数据，所有最终评分必须由程序调用 `computeTechValuation` 严格复核，不采信 AI 自行生成的评分数字。
- **充分证据保留**：每条补齐的估值记录完整保存 `source_url`、`source_institution`、`as_of_period`、`evidence_summary` 与 `retrieved_at`。
- **公开数据不足报告**：若公开网络无法免费检索到标的历史一致预期（例如 5 年前的逐月 90 天预期），系统返回结构化 `insufficient_data` 并精确列出缺数月份，不进行无根据的数值猜测、不平铺复制当前值、不使用后来披露冒充历史当时数据。
- **临时插值标记**：内部月份临时插值仅用于预览展示，并与数据源自带的插值严格区分。

---

## 5. 数据存储与迁移

- **存储隔离与升级**：数据保存在浏览器 localStorage 的 `cycle-algorithm-v2:` 命名空间下。
- **v1 平滑升级**：读取旧版 `cycle-algorithm-v1:` 数据或恢复 v1 备份时，自动平滑升级为 v2 架构，旧持仓自动转换为 `input_mode: 'market_value'`，旧估值、修订历史与正式事件 100% 完整保留。
- **完整 JSON 备份**：支持一键导出和导入包含持仓、最新报价缓存、汇率缓存、估值历史、正式事件和补数任务的完整备份。

---

## 6. 代码结构与验证

| 文件 | 职责说明 |
| --- | --- |
| `src/valuation.js` | 权威 11 项基本面输入计算 `S_Tech` 固定公式及 N/A 判定 |
| `src/strategy.js` | 百分位、曲线、包络、控制器有状态路径回放、账户利息与费用 |
| `src/preview.js` | 多币种汇率换算、持仓权重归一化、各标的回放与组合加权 |
| `src/model.js` | Schema v2 数据归一化、备份导入导出、历史修订幂等合并 |
| `src/storage.js` | 浏览器 localStorage 存储管理与 v1/v2 自动迁移 |
| `src/app.js` | 响应式前端交互、持仓编辑器、补数任务调度与可视化图表 |
| `scripts/helper.mjs` | 本机轻量级 HTTP 守护进程（端口 8789），负责 agy CLI 调度与费用锁定 |
| `scripts/build.mjs` | 严格白名单静态资源打包至 `dist/` |
| `tests/` | 完整的自动化测试套件（数值基准、策略行为、补数工作流） |

### 运行测试与构建
```powershell
# 运行全部 30 项单元与集成测试（包含 Python 数值基准与 12.A/B/C 验收标准）
node --test tests/*.test.mjs

# 构建静态产物至 dist/ 目录（11 个白名单文件）
node scripts/build.mjs
```

测试覆盖：
- **Acceptance 12.A**：市值模式权重（75%/25% 对应 1.3× 组合杠杆）、股数模式报价推导、比例缩放不变性、多币种折算与阻塞、逐标的独立路径控制器加权。
- **Acceptance 12.B**：11 项公式严谨性与 N/A 拦截、来源证据保留与往返还原、部分补齐与公开数据不足报告。
- **Acceptance 12.C**：`useG1Credits: false` 费用保护拦截、本地助手 `/api/status` 与 `/api/protect-cost` 接口、v1 至 v2 兼容往返、重复合并幂等性（修订号自增且不重复记录）。
