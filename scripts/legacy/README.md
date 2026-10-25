# scripts/legacy/ — 历史脚本归档

本目录保存 2026-08 及更早的采集/评估脚本，**已不参与现行主链路，不再维护**。
保留原因：复盘历史报告（`reports/legacy/`）时能对上当时的算法与结论。

> 归档 = 只读参考。不要在新流程里调用这里的脚本；阈值/权重已统一到
> `data/strategy-config.json`，采集/评估/报告请用仓库根目录脚本。

## 文件清单

| 文件 | 用途 | 现行替代 |
| --- | --- | --- |
| `plan5-v2.ps1` | PowerShell 版「账号最佳 5 队枚举」（武将不重复 + 版本校验 + 落地判断） | `scripts/plan5-core.js` + `scripts/plan5-node.js`（参数化，报告链调用） |
| `lib-cbg.ps1` | 旧 PowerShell 公共库：榜单解析 / 战法映射 / 版本武将校验 / 落地判断 | `scripts/plan5-core.js`；阈值类配置改读 `data/strategy-config.json` |
| `count-teams.ps1` | 统计每个号「完整 / 只缺宝 / 缺战法」队伍数（按 T 级加权） | `scripts/plan5-node.js` / `scripts/report.js` |
| `t0-stats.ps1` | 统计 T0+/T0 队伍各落地状态分布（回答「2000 价位 T0 队伍多不多」） | `scripts/strategy-eval.js` + `scripts/filter-strategy.js` 的漏斗统计 |
| `t0-hero-count.ps1` | 只按武将骨架统计每号能组几支 T0+/T0 队伍 | `scripts/land-stats.js` / `report.js` 的逐队落地 |
| `find-accounts-20260807.ps1` | 列表页快照「资产指数」初筛 v4（2026-08-07，含 9 个旧区服区间硬编码） | `scripts/list-filter.js`（L2 硬门槛）+ `scripts/prefilter.js`（预筛分排序） |
| `fetch_cbg_api.ps1` | 早期藏宝阁 API 抓取（82 个旧 serverid 硬编码，接口/区服均已失效） | `scripts/update-shishi.js` + `scripts/api-collect.js`（serverid 全部来自 `data/shishi-open.json`） |

其中 `plan5-v2.ps1` 是 `plan5-node.js` 的历史原型；`lib-cbg.ps1` 仅被 `plan5-v2.ps1` 引用，
两文件在同一目录，归档后 dot-source 相对路径仍成立。

## 运行注意（已归档脚本不再保证可直接运行）

- `plan5-v2.ps1`、`count-teams.ps1`、`t0-stats.ps1`、`t0-hero-count.ps1` 的 `-DataFile`
  默认值按 `$PSScriptRoot` 的父目录推算仓库根，归档后该默认值失效；
  如确需运行，请显式传参：`-DataFile <仓库根>\data\accounts-final.json`。
- `find-accounts-20260807.ps1` / `fetch_cbg_api.ps1` 依赖已关闭的旧区服与旧接口，仅作历史参考。
- `lib-cbg.ps1` 中 `$script:Root = Split-Path $PSScriptRoot -Parent` 归档后指向 `scripts/`，
  不再指向仓库根；只保存算法供阅读。

## 校验说明

这些 `.ps1` 仍会被 `npm test`（verify-core）与 CI 递归纳入
**UTF-8 BOM 检查**与 **PowerShell Parser 语法检查**，防止归档文件腐烂。
