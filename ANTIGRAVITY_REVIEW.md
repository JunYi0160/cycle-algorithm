# Antigravity 实施验收：未通过

检查日期：2026-10-08（Europe/Berlin）  
检查目录：`D:\Documents\GitHub\cycle-algorithm`

## 结论

**持仓比例计算与界面简化已经做出，但“自动联网补齐估值、只用套餐额度、可靠保存和恢复”的完整功能尚未实现好。当前版本不应视为完成交付，本机助手的文件访问和接口认证问题须优先修复。**

检查时有 8 个已跟踪文件修改，以及尚未提交的助手/启动脚本/测试等文件；最近提交仍是 `0b3992e`。本次检查实际访问的 Pages 仍是旧版标题，未发现新版本已发布。

以下是对现有代码的审查与复现，不是对代码的修复。

## 已确认通过的部分

- `node --test tests/*.test.mjs`：30 项通过。
- `node scripts/build.mjs`：构建 11 个白名单静态文件成功。
- 核心评分与控制器源文件未改变；已有数值基准通过。
- 纯市值、股数配合固定报价、直接比例的权重与逐标的杠杆加权，在已有数据条件下通过测试；跨币种已有汇率的数学换算可用。
- 主界面已移除 A/B/E、实际杠杆、总市值和交易金额卡片。
- Antigravity CLI 位于本机默认安装目录，`--version` 返回 `1.3.1`，帮助中包含 headless/JSON 输出选项。

**上述测试没有证明自动补数链路真实可用。**新增补数测试主要检查固定数据、数学函数、配置值和 `/api/status`；没有覆盖正常 CLI 数组结果、完整 60 月补数、真实联网来源验证或新增持仓后的刷新恢复。

## 必须修复的问题

### 1. [P1] 保存新持仓后刷新，仍被旧账户 A/B/E 校验阻塞

位置：[src/model.js:186](/D:/Documents/GitHub/cycle-algorithm/src/model.js:186)，关联默认模型第 7 行、`normalizeAccount` 第 119 行。

`emptyData()` 默认带有 EUR 的旧 `account`，但新版参考币种默认为 USD。v2 备份/存储只要带 `account`，`validateBackup()` 就重新执行 `normalizeAccount()`，强制旧币种及 `E=A−B>0`。

实际复现：

1. 新页面点击“体验虚构示例”，显示 72 条估值、目标 1.74×。
2. 刷新页面，显示“全部持仓市值须换算到账户基础币种”，原持仓与结果无法加载。
3. 使用新默认数据分别保存 USD 市值、USD 股数、直接比例后，再调用备份校验，三种模式均得到同一错误。

即使把旧账户币种同步为参考币种，纯股数/比例没有持仓市值时还会触发旧净值必须为正的限制。必须把 v2 持仓校验与旧账户档案彻底解耦；v1 迁移保留档案，但不能在 v2 加载时强制旧账户规则。

证据截图：[刷新失败](/D:/Documents/GitHub/cycle-algorithm/tests/artifacts/review-reload-failure.png)。此测试使用独立端口与虚构数据，没有覆盖用户已有真实持仓存储。

### 2. [P1] 助手允许读取发布目录外文件，接口没有实际认证

位置：[scripts/helper.mjs:332](/D:/Documents/GitHub/cycle-algorithm/scripts/helper.mjs:332)、[scripts/helper.mjs:427](/D:/Documents/GitHub/cycle-algorithm/scripts/helper.mjs:427)。

- CORS 直接回显任何 `Origin`，未限制可信页面。
- `/api/status` 无需认证即返回配对 token。
- 其他接口完全没有检查 `X-Helper-Token`；前端也没有发送它。
- 静态文件 `resolve(DIST, sub)` 后没有验证最终路径位于 `dist` 内。Windows 下 `sub` 为盘符绝对路径时，可以跳出发布目录。

已在临时 8797 端口复现：

```text
Origin: https://untrusted.example
GET /api/status → 200，回显该 Origin，返回 token
GET /cycle-algorithm/D:/Documents/GitHub/cycle-algorithm/package.json
  → 200，读取到了 dist 之外的项目 package.json
```

复现只读取了非敏感的项目文件，没有读取凭据或其他私人文件；临时助手已关闭。浏览器额外的本地网络授权不能替代助手自身的认证、来源检查和路径隔离。

修复：限定可信 origin、验证 Host 和认证、禁止匿名获取秘密、所有静态请求验证规范化路径边界，拒绝盘符路径和越界路径。对非法来源/未认证请求增加自动测试。

### 3. [P1] 正常 JSON 数组补数结果会被解析器错误处理

位置：[scripts/helper.mjs:134](/D:/Documents/GitHub/cycle-algorithm/scripts/helper.mjs:134)。

提示词要求返回 JSON 数组，但解析器先提取 `{...}`。一个合法的单元素数组会被解析成对象；随后 `Array.isArray(list)` 为假，得到零条记录。

已使用现有函数源码、固定 CLI 返回值复现：

```text
response = '[{"valuation_date":"2026-09-30","inputs":{...},"source_url":"..."}]'
实际：status=insufficient_data，results=0
```

带代码围栏的数组反而可被接受，说明行为取决于文本包装。应优先使用 CLI 的 `structured_output`/JSON schema；兼容解析先完整解析 payload，不能用贪婪对象正则破坏数组。还需检查 CLI 终态和权限软拒绝，不只检查进程退出码。

### 4. [P1] 新标的只补最近 12 月，没有自动继续补足 60 月

位置：[src/app.js:394](/D:/Documents/GitHub/cycle-algorithm/src/app.js:394)。

前端计算了缺失的 60 个月，却通过 `missingToEnrich.slice(-12)` 只请求 12 个月。该任务只执行一次，没有批次队列或自动续跑；用户仍需反复触发才能处理其余月份。

独立复现确认：新标的第一次请求 12 月，另外 48 月未请求。补数进度也只记录这 12 月的返回缺失，不能据此表示整个标的历史已完成。

修复：按完整缺失集合分批、连续执行、保存批次和总进度，缺数或额度耗尽时提供真实可续跑状态，不能靠用户重复保存代替自动补数。

### 5. [P1] 异币种自动换汇没有接入前端

位置：[src/app.js:327](/D:/Documents/GitHub/cycle-algorithm/src/app.js:327)。

助手定义了 `/api/fx`，但前端没有调用它，也没有把返回汇率写入 `data.fxRates`。`normalizeFxRate` 仅被导入，未实际使用。

因此参考币种 EUR、持仓/报价 USD 等新情况，即使报价和历史补齐，仍会因缺汇率阻塞；固定测试中手动提供汇率通过，并不代表用户流程能自动获取汇率。

修复：在报价之后检查所有需要的币种对，缓存有效汇率、保存来源并重算，验证市值/股数混合输入的真实流程。

### 6. [P1] 后台补数会覆盖用户期间修改的持仓

位置：[src/app.js:343](/D:/Documents/GitHub/cycle-algorithm/src/app.js:343)、[src/app.js:412](/D:/Documents/GitHub/cycle-algorithm/src/app.js:412)。

任务开始时复制整个 `data`，联网等待后把旧副本整体 `commit`。期间用户修改股数、比例、币种或删除持仓，都会被旧副本覆盖。

独立复现：任务开始时 AAA 市值为 100，等待期间改为 200，任务结束后又被覆盖回 100。多次保存还可启动多个并发任务，`activeTaskCount` 未用来阻止或合并。

修复：任务结果只向最新数据合并对应估值/报价，持仓使用最新版本；加任务版本、幂等键及可控并发，取消必须绑定具体任务，不用单一全局 `activeAgyProcess`。

### 7. [P1] 费用保护不能证明只消耗 Antigravity 套餐额度

位置：[scripts/helper.mjs:49](/D:/Documents/GitHub/cycle-algorithm/scripts/helper.mjs:49)、[src/app.js:44](/D:/Documents/GitHub/cycle-algorithm/src/app.js:44)。

预检只查看 `useG1Credits`，未排除 Gemini API provider、自定义 endpoint、其他认证/配置覆盖；配置不存在或 JSON 无法解析时也默认报告保护已启用。前端只要助手能连接，就无条件显示“基础额度已保护”，不检查 `costProtection`。

隔离模拟预检结果：

```text
modelProvider='gemini', useG1Credits=false → costProtectionActive=true
settings 内容为不可解析 JSON → costProtectionActive=true
```

这是“错误放行”，不符合费用路径无法确认就停止的要求。关闭 credits 回退与证明账户基础额度通道是两项不同检查。

本机当前可读设置为 `useG1Credits=false`，未配置 `modelProvider`；本次未观察到实际扣费，也没有通过真实模型任务验明基础额度链路。不能把这些配置值解释为所有运行路径的零费用保证。

修复：未知配置失败关闭，确认实际 account provider/认证方式及覆盖配置，核对 credits Never，界面忠实显示预检状态。配置解析失败不得重写为空对象，也不应在每次请求中静默扩大权限。

### 8. [P1] 无来源或错月份结果仍可被算作补数完成

位置：[scripts/helper.mjs:267](/D:/Documents/GitHub/cycle-algorithm/scripts/helper.mjs:267)、[scripts/helper.mjs:303](/D:/Documents/GitHub/cycle-algorithm/scripts/helper.mjs:303)。

后端只检查数字和公式，没有要求证据 URL、字段单位/币种、披露时点或请求月份；完成状态仅比较结果条数。

已复现：

- 数字完整但没有任何来源的结果，被标为 `completed`、`observation`。
- 请求 2026-09，却返回 2020-01；结果仍标 `completed`，同时 `missing` 还包含 2026-09。

修复：验证证券、日期、请求月份、逐字段证据/口径和 point-in-time；按请求月份的唯一完整覆盖判断完成。源数据不足与格式/工具失败应区分；不能把模型给出的数字自动视为观测。

### 9. [P2] 估值来源 URL 在保存时丢失

位置：[src/model.js:26](/D:/Documents/GitHub/cycle-algorithm/src/model.js:26)。

助手返回 `source_url`，但 `normalizeValuation` 的白名单没有保留该字段。直接复现 `normalizeValuation({...,source_url:'https://example.org/report'})`，输出无此字段。

也未实现每项原始输入到来源、单位、时点和派生规则的映射。已有“证据往返”测试只检查文字摘要等字段，未检查 URL，因而没能发现问题。

修复：建立明确证据 schema，贯穿归一化、修订、存储和备份的完整往返校验。

### 10. [P2] 报价缓存时效、任务展示与错误处理不足

位置：[src/app.js:351](/D:/Documents/GitHub/cycle-algorithm/src/app.js:351)、[src/app.js:400](/D:/Documents/GitHub/cycle-algorithm/src/app.js:400)。

- 保存持仓时只检查报价是否存在/数值有限，过期报价不会自动刷新；后端缓存时效判断因此可能根本不会执行。
- 报价、补数错误仅写入 `console.warn`，任务状态没有持久化失败或额度耗尽，结束仍提示“补数完成”。
- `enrichmentJobs` 被存储但没有完整的用户任务进度/错误/续跑界面。
- 股份类别/交易所身份未建模，股票仍仅按 ticker 合并。

修复：时效判断前后端一致，任务状态在界面可见，错误不被伪装成完成；用明确证券身份作为缓存/组合键。

### 11. [P2] 发布与启动交付尚未完善

位置：[package.json](/D:/Documents/GitHub/cycle-algorithm/package.json)、[.gitignore](/D:/Documents/GitHub/cycle-algorithm/.gitignore)、启动脚本。

- 页面要求运行 `npm run helper`，但 `package.json` 没有 `helper` script。
- `.gitignore` 没有排除 `scripts/.cache/`；配对 token 当前出现在未跟踪文件集合中，不能直接全量提交。
- PowerShell 启动脚本未补充 CLI 默认安装路径；本次 shell 中 `agy` 不在 PATH，只有默认完整路径可运行。
- 两个脚本都先打开网页再启动服务；未验证“服务已就绪”再开页面，且启动/构建失败处理不完整。
- 当前改动没有提交/推送，实际 Pages 仍是旧版。安全和持久化问题修复之前不要发布新助手流程。

修复：补充可靠启动命令、排除缓存/秘密、进程就绪检查与冲突检查；完成验收后再部署并验证实际线上版本。

## 重新验收应优先完成的测试

1. 新默认空数据 → 市值/股数/比例各保存一次 → 刷新 → 完整备份恢复，均成功，且不要求 A/B/E。
2. 可信来源与认证测试；非法 origin、未认证请求、盘符绝对路径与越界文件均拒绝。
3. CLI 正常纯 JSON 数组和 structured output → 完整解析；错误终态、权限软拒绝和格式错误必须正确分类。
4. 新标的缺 60 月 → 连续分批处理全部范围；期间修改/删除持仓不被旧任务覆盖。
5. 异币种股数/市值模式 → 自动获取正确汇率 → 保存来源 → 加权计算。
6. API provider/未知配置/credits 开启 → 任务拒绝启动；确认套餐额度路径后再做小型真实联网验证。
7. 无来源、错日期、后见数据、单位不一致或部分字段缺失 → 不进入有效观测；备份后字段来源仍完整。

测试不要依赖或改写用户真实全局 CLI 设置；使用隔离配置和进程依赖注入。30 项单元测试通过可以保留，但必须补上以上会失败的实际用户流程。

## 验证范围

本次完成静态审查、30 项现有测试、构建、独立函数/任务复现、临时 HTTP 服务检查及真实浏览器保存后刷新复现。未调用真实 Antigravity 模型补数任务、未证明历史数据能被实际检索，也未消耗模型额度去验证已知失败链路。

代码中已经存在可确定复现的阻塞缺陷，因此即使某次联网报价成功，也不足以通过完整验收。请先修复上述问题，再按原需求文件重新验收。
