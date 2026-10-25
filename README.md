# 率土之滨 · 藏宝阁选号工具链

面向个人研究的《率土之滨》**藏宝阁账号采集 → 评估 → 报告**工具链。
一条命令跑通「试师区服白名单刷新 → 在售账号直采 → 合并去重 → 报告 → 策略排序」，
阈值与权重全部集中在 `data/strategy-config.json`，不写在脚本里。

> ⚠️ **找号需人工登录藏宝阁，不保证数据实时。** 脚本不绕过登录、验证码或风控；
> 采集到的价格/在售状态会变化，最终购买前必须人工复核。

---

## 1. 能做什么

- **试师区服白名单自动刷新**：抓网易官方告示板 H5 的 `teamData.json`（免登录），生成
  `data/shishi-open.json`（当前开放区服）与 `docs/试师赛季白名单.md`（全量历史）。
- **藏宝阁在售账号采集**：列表 + 详情 API 直采，慢速串行（3–4 秒/号）防账号级限流，
  登录失效自动停下等人工处理，支持断点续采。
- **合并与出处标注**：按 `ordersn`（商品号）去重，补 `source` / `capturedAt` / `statusKind`，
  过期浏览器详情文件自动跳过。
- **逐队落地报告**：按 `data/teams.json` 队伍库判断每个号能组出哪些完整队 / 只缺宝队 /
  缺战法队，结合补件成本给出最终购买建议。
- **策略漏斗排序**：L1 选品池 → L2 列表门槛 + 预筛分 → L3 评分/硬规则/画像 → L4 人工复核，
  输出「落地战力 / 性价比」排序与漏斗召回统计。

## 2. 数据流

```text
       官方 H5 teamData.json（免登录，每小时级刷新）
                 │
                 ▼
        scripts/update-shishi.js
                 │  （原子写，失败 fail-closed）
                 ├──────────────► docs/试师赛季白名单.md   （全量历史试师区服）
                 │
                 ▼
        data/shishi-open.json（当前开放试师区服，65 个左右，随赛季滚动）
                 │
                 ▼
        scripts/api-collect.js ── 列表页 L2 门槛（list-filter.js）
                 │                  详情抓取顺序（prefilter.js 预筛分）
                 ▼
        data/accounts-api.json（原始列表 + 详情）
                 │
                 ▼
        scripts/merge-api.js ──► data/accounts-final.json
                 │                （按 ordersn 去重；补 source/capturedAt/statusKind；
                 │                  静态表 data/name-camp.json；跳过过期浏览器 detail）
                 ├──────────────► scripts/report.js
                 │                   └─► docs/找号报告-<客户>-<日期>.md（逐队落地 + 购买建议）
                 ├──────────────► scripts/recommend.js
                 │                   └─► docs/最终购买建议-<日期>-自动.md（自动购买建议）
                 └──────────────► scripts/strategy-eval.js
                                     └─► reports/策略落地-20261025/策略排序.md

旁路（可选，非主链路）：
  scripts/collect.ps1 / cbg-detail-extract.js   浏览器补采（需人工登录，可带版本武将信息）
  scripts/filter-strategy.js                    用历史采样反推筛选条件（阈值调优）
  scripts/prefilter.js                          列表阶段预筛分（被 api-collect 调用）
  scripts/verify-shishi.js + verify-core.js     离线回归（npm test，不联网）
```

> 每次运行的 `runId / 参数 / 配置指纹 / 计数 / 状态` 写入 `data/run-meta.json`（本机状态，不进 git）。

## 3. 快速开始

**环境要求**

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| 系统 | Windows 10/11 | 主链路 `find-all.ps1` 用 Windows PowerShell；Linux/macOS 只能单跑 Node 脚本 |
| Node.js | ≥ 22（CI 用 22，本机 v24 亦可） | 纯 CommonJS，无构建步骤 |
| npm | ≥ 10 | 用 `npm ci` 按 `package-lock.json` 安装 |
| PowerShell | Windows PowerShell 5.1 或 pwsh 7 | `.ps1` 必须 UTF-8 **带 BOM**（见 FAQ） |
| 浏览器 | Playwright Chromium（可选） | 仅浏览器补采 / 复核需要：`npx playwright install chromium` |

```powershell
# 1) 安装依赖（不要引入新依赖）
npm ci

# 2) 可选：浏览器采集/复核所需的 Chromium
npx playwright install chromium

# 3) 刷新试师区服白名单（免登录）
npm run shishi

# 4) 离线回归（不联网、不采集）
npm test

# 5) 一键找号：直采 → 合并 → 报告 → 自动购买建议
npm run find

# 6) 单独重跑报告 / 策略排序（复用已有 data/accounts-final.json）
npm run report
npm run strategy
```

`npm run find` 参数透传示例（默认价格 1500–2500 元）：

```powershell
npm run find -- -SkipCollect                              # 跳过采集，复用已有 API 数据
npm run find -- -PriceMin 150000 -PriceMax 200000         # 价格区间（单位：分）
npm run find -- -Customer 客户A                            # 报告文件名中的客户名
npm run find -- -SkipReport                                # 只采集 + 合并
```

## 4. 配置说明（`data/strategy-config.json`）

**单源原则**：所有阈值/权重/文案只写在这里。脚本通过 `scripts/lib-config.js`（Node）与
`scripts/lib-config.ps1`（PowerShell）读取；缺配置或缺字段直接报错（fail-closed），
不允许再在脚本里写死。临时换配置可用环境变量 `STZB_CONFIG=<path>`。
每次运行的配置指纹（sha1 前 8 位）会写入 `data/run-meta.json` 与报告，便于复现。

| 段 | 作用 | 关键字段 |
| --- | --- | --- |
| `l0_data` | 数据时效与在售状态口径 | `maxStaleDays`（默认 14，超期即旧快照，报告必须标注）、`statusLabels`（上架/公示/售出/下架的页面文案归一化）、`excludeFromRecommend`（售出/下架不进推荐） |
| `l1_pool` | 选品池 | `priceRange`（1500–2500 元）、`bargainLine`（低价捡漏线：价格区间 / 五星 / 锻造 / topN）、`serverWhitelist`（指向 `docs/试师赛季白名单.md`，不得另写第二份） |
| `l2_list_filter` | 列表页硬门槛 + 详情预算 + 预筛分 | `fiveStarMin`、`sTacticMin`、`forgedGearMin`、`coreHeroHitsMin`、`rareEquipMin`、`maxDetailCandidates`、`detailBudget`、`prefilter.weights`（有锻造数据时）/`prefilter.weightsNoForged`（API 列表无锻造数时）、`controlMode`（`FUNNEL_CONTROL=1` 反证实验采样区间） |
| `l3_scoring` | 落地战力评分与硬规则 | `tierWeight`（T0+ 10 / T0 8 / T1 5 / T2- 2）、`onlyGearFactor`、`missingTacticCurve`（缺战法分级：缺 1 本 ×0.7 且每本战法最多救 1 队 / 缺 2 本降档 ×0.6 / 缺 3+ 记 0）、`versionOverrides`（版本武将，如「司马懿」要求晋）、`skipHeroes`、`hardRules`（只缺宝过多/溢价硬降权；旧「高 T 缺战法整队剔除」已由曲线取代）、`gate`（入选门槛：`minFullT1plus`、alt、alt2_baobao 补宝通道）、`profiles`（即战型/均衡型/补宝型画像） |
| `l4_manual_check` | 人工复核清单 | `topN`（默认复核前 3 名）、`checks`（版本武将、宝物词条、上架状态/公示期、服务器与价格二次确认） |

调参流程建议：先跑 `npm run filter-strategy` 看单因子证据与召回，再改本文件，
最后 `npm run strategy` 对比新/旧排序（详见 `reports/筛选条件策略-20261025/`）。

## 5. 目录结构

```text
.
├─ .github/
│  ├─ workflows/test.yml              # CI：离线回归 + 全量语法/BOM 检查（不联网、不采集）
│  ├─ copilot-instructions.md         # 仓库级 AI 指令（评分口径指向 strategy-config.json）
│  └─ skills/stzb-cbg-account-evaluation/SKILL.md   # 选号评估 Skill（自动化链路 + 人工流程）
├─ data/
│  ├─ strategy-config.json            # ★ 阈值/权重单源
│  ├─ shishi-open.json                # 当前开放试师区服（update-shishi 生成）
│  ├─ shishi-servers.json             # 全量历史试师区服（按批次）
│  ├─ accounts-api.json               # API 直采原始数据
│  ├─ accounts-final.json             # 合并后的统一数据（报告输入）
│  ├─ name-camp.json                  # 武将 → 阵营静态映射
│  ├─ teams.json                      # 队伍库（排行榜解析产物，报告/评分输入）
│  └─ run-meta.json                   # 运行元数据（本机状态，gitignore）
├─ docs/
│  ├─ README.md                       # 文档索引：规范 / 流程 / 模板 / 榜单
│  ├─ 选号条件与筛号流程.md、试师数据源.md、试师赛季白名单.md、队伍强度排行榜.md
│  ├─ 选号计划-v3-筛子法.md、决策矩阵模板.md、找号需求问卷* 等流程/模板
│  └─ 队伍强度榜分段图片/             # 排行榜截图素材
├─ reports/
│  ├─ 策略落地-20261025/、筛选条件策略-20261025/ 等本次评估输出
│  └─ legacy/                         # 历史选号报告归档（只复盘，不当结论）
├─ scripts/
│  ├─ update-shishi.js                # 试师白名单刷新（lib-shishi.js 统一读取入口）
│  ├─ api-collect.js / merge-api.js   # 采集 + 合并
│  ├─ list-filter.js / prefilter.js   # L2 门槛 + 预筛分
│  ├─ report.js                       # 单进程报告（逐队落地 + 购买建议）
│  ├─ strategy-eval.js / filter-strategy.js   # 策略漏斗评估 / 筛选条件分析
│  ├─ plan5-core.js / plan5-node.js   # 队伍库解析、落地判断、组队枚举
│  ├─ lib-scoring.js                  # 统一评分引擎（配置单源 l3_scoring）
│  ├─ lib-config.js / lib-config.ps1  # 配置单源读取（fail-closed）
│  ├─ lib-runmeta.js                  # 运行元数据（data/run-meta.json）
│  ├─ verify-shishi.js / verify-core.js       # 离线回归（npm test）
│  └─ legacy/                         # 历史脚本归档（不参与主链路，见其 README）
└─ README.md
```

## 6. 脚本与命令速查

| 命令 | 作用 |
| --- | --- |
| `npm run shishi` | 刷新试师区服白名单；`shishi:check` 只比对不写；`shishi:force-api` 走备用接口 |
| `npm run find` | 一键主链路：`update-shishi` → `api-collect` → `merge-api` → `report` → 自动购买建议 |
| `npm run report` | 用已有 `data/accounts-final.json` 重新生成报告 |
| `npm run strategy` | 按策略漏斗输出排序（`reports/策略落地-*/`） |
| `npm run filter-strategy` | 筛选条件策略分析（单因子证据 / 阈值 vs 排序 / 预算分档） |
| `npm run extract` / `npm run analyze` | 浏览器详情采集（需登录） / 旧版 PowerShell 分析报告 |
| `npm test` | 离线回归 = `verify-shishi`（白名单/接线/语法）+ `verify-core`（配置/数据契约/BOM） |
| `npm run verify:live` | 额外联网校验官方数据源（`update-shishi --check`） |

## 7. 常见问题（FAQ）

### 7.1 采集提示 `SESSION_TIMEOUT` / 要求登录

`SESSION_TIMEOUT` 表示藏宝阁登录态失效：**真实采集必须人工登录**，脚本不会绕过。
`api-collect.js` 会停下并打印提醒，按提示在浏览器完成手机验证/登录后回车继续；
登录态存在 `.cbg-profile/`（已 gitignore）。白名单刷新（`npm run shishi`）全程免登录。

### 7.2 遇到 `eb-re410`（账号级限流 / 风控）

藏宝阁按账号限流，密集并发会让列表 + 详情接口同时失效并持续 30 分钟以上，**页面 DOM 也依赖接口**。
因此主链路强制：详情 3–4 秒/号串行、翻页 800 ms、连续失败 ≥3 自动长退避 60–120 秒、
只做增量并复用缓存。日常采集时**不要并发跑其他请求**；若仍被限流，停手等待、换时间段再采。

### 7.3 `.ps1` 报中文乱码 / `The string is missing the terminator`

`.ps1` 文件必须保存为 **UTF-8 带 BOM**，否则 Windows PowerShell 5.1 会按 ANSI 解析中文注释而报错。
`.gitattributes` 只负责行尾（`*.ps1 eol=crlf`），**不会生成 BOM**；`npm test` 与 CI 会检查每个
`.ps1` 的前 3 字节是否为 `EF BB BF`。用 VS Code 保存时选「UTF-8 with BOM」。

### 7.4 数据是不是实时的 / 报告能直接用吗

不能直接用。`data/accounts-final.json` 可能是上一次采集的快照（仓库内默认快照为 2026-08 批次，
186 个号），价格与在售状态随时变化。判断方法：

- 看每条记录的 `capturedAt`（采集时间）与 `source`（api/browser）、`statusKind`（在售/公示/售出/下架）；
- 看 `data/run-meta.json` 的 `lastRun` / `history`（最近 20 次运行，含配置指纹）；
- `l0_data.maxStaleDays`（默认 14 天）之外的浏览器详情文件会被 `merge-api.js` 跳过；
- 报告与购买建议必须标注数据截点，最终 3 名候选按 `l4_manual_check` 人工复核。

### 7.5 `npm run find` 找不到 powershell

确认 `powershell` 在 PATH（Windows 自带）；或直接用 pwsh 执行：
`pwsh -File scripts/find-all.ps1 -SkipCollect`。

### 7.6 浏览器采集报 Chromium 缺失

`npm ci --ignore-scripts`（CI 用法）不会下载浏览器；本机需要浏览器补采/复核时执行
`npx playwright install chromium`。纯 API 直采不需要浏览器。

## 8. 免责声明

- 本项目为**个人学习研究**用途，与网易/藏宝阁官方无关，非官方工具。
- 找号流程**需要人工登录**藏宝阁；脚本不破解登录、不绕过验证码与风控。采集数据**不保证实时、
  准确、完整**，价格、在售状态、区服开放情况均可能变化，一切以藏宝阁页面为准。
- 使用本项目即表示你自行遵守藏宝阁用户协议、相关法律法规与平台规则；请控制请求频率，
  勿用于商业用途或大规模爬取。因使用本项目产生的账号风险、数据误差或交易损失由使用者自行承担。
- 仓库内历史报告（`reports/legacy/`）反映的是当时的数据与判断，**不构成当前购买建议**。
