# docs/ 文档索引

`docs/` 只放**规范、流程、模板与榜单**；一次性历史报告统一归档在
[`reports/legacy/`](../reports/legacy/README.md)，运行数据在 `data/`。
根目录 [`README.md`](../README.md) 是项目总览与快速开始。

## 1. 规范与数据源（改代码/改策略前必读）

| 文档 | 内容 | 维护方式 |
| --- | --- | --- |
| [选号条件与筛号流程.md](选号条件与筛号流程.md) | 固定条件（试师/预算/版本武将）、三层筛号法、人工复核清单 | 手工维护；阈值改动同步 `data/strategy-config.json` |
| [试师数据源.md](试师数据源.md) | 试师区服白名单的官方数据源、自动刷新原理、集成与校验、风险 | 手工维护 |
| [试师赛季白名单.md](试师赛季白名单.md) | 当前可筛试师区服全量清单（含批次/时间） | **自动生成，勿手改**：`npm run shishi` |
| [队伍强度排行榜.md](队伍强度排行榜.md) | 碧版 2026 第三季度队伍强度榜（T0+/T0/T1/T2-），解析产物 `data/teams.json`（plan5-core / report / 策略评分统一读取） | 榜单更新时按截图识别重写；截图素材见 `队伍强度榜分段图片/` |

## 2. 流程与模板

| 文档 | 内容 |
| --- | --- |
| [选号计划-v3-筛子法.md](选号计划-v3-筛子法.md) | 用排行榜逐级做筛子的现行思路（`scripts/filter-strategy.js` 的文档引用） |
| [选号计划-从零开始.md](选号计划-从零开始.md) | 不依赖旧数据的全新选号流程 |
| [选号执行计划.md](选号执行计划.md) | 2026-08 的选号执行计划 v1（历史执行模板，结论勿直接复用） |
| [决策矩阵模板.md](决策矩阵模板.md) | ≤5 个候选做最终排序时的六维打分模板 |
| [找号需求问卷-模板.md](找号需求问卷-模板.md) | 向客户收集预算/区服/偏好等需求 |
| [找号需求问卷.xlsx](找号需求问卷.xlsx) | 问卷可填写版（`scripts/parse-questionnaire.js` 等读取） |
| [找号问卷-自测-20260806.xlsx](找号问卷-自测-20260806.xlsx) | 问卷自测样本 |
| [找号需求问卷 - 自用.xlsx](找号需求问卷%20-%20自用.xlsx) | 自用需求问卷填写样例 |

## 3. 自动化入口（详见根 README）

- 配置单源：`data/strategy-config.json`（l0 数据时效 / l1 选品池 / l2 列表门槛与预筛分 /
  l3 评分与硬规则 / l4 人工复核）；脚本经 `scripts/lib-config.js`、`scripts/lib-config.ps1` 读取，禁止写死阈值。
- 采集合并：`npm run shishi` → `npm run find`（内部 `api-collect.js` → 备份 → `merge-api.js` → `snapshot-diff.js`）。
- 评估报告：`npm run report`（`scripts/report.js` 单进程）、`npm run find` 第 4 步 `scripts/recommend.js` 生成 `docs/最终购买建议-<日期>-自动.md`；`npm run strategy`（策略漏斗排序）。
- 下单前核对：`npm run checklist` 生成 `docs/候选核对清单-<日期>.md`（价格/采集时效 ⏳/在售状态/需自锻宝物件数）；`npm run diff` 对比上次快照（新上架/下架/调价/状态变化）。
- 离线回归：`npm test`（verify-shishi + verify-core），不联网、不采集。
- 历史脚本：`scripts/legacy/`；历史报告：`reports/legacy/`。

## 4. 约定

- 新增**一次性**报告请放 `reports/<主题>-<日期>/`，不要放进 `docs/`。
- 唯一例外：`npm run report` / `npm run find` / `npm run checklist` 的当前交付产物固定写到
  `docs/找号报告-<客户>-<日期>.md`、`docs/最终购买建议-<日期>-自动.md`、`docs/候选核对清单-<日期>.md`，
  属对客交付物；旧报告已归档到 `reports/legacy/`。
- 修改规范文档时，同步检查 `data/strategy-config.json` 与
  `.github/skills/stzb-cbg-account-evaluation/SKILL.md`，避免三处口径不一致。
- 中文文档统一 UTF-8（无 BOM 亦可，git 归一化为 LF）。
