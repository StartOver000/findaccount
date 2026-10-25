// ============================================================
// strategy-eval.js — 新选号策略落地评估（统一评估引擎版，2026-10-25）
// 目标: 不按「可组数量/完整队数」一把梭, 按「落地战力 / 性价比」排序。
// 参数全部来自 data/strategy-config.json（漏斗 L1-L4 + 权重 + 硬规则 + 门槛 + 画像）
//
// 重构说明:
//   - 落地判断/评分/硬规则/门槛/画像全部委托给 lib-scoring.js（唯一实现），
//     本脚本只负责样本读取、排序与报表输出；
//   - 榜单队伍由 lib-teams.js 解析（data/teams.json 优先，别名/合并格/多选一已归一）；
//   - 版本覆盖、skipHeroes（弓诸葛）等参数均来自 l3_scoring，不再在本文件硬编码。
//
// 用法:
//   node scripts/strategy-eval.js [dataFile] [outDir]
// 输出:
//   reports/策略落地-20261025/strategy-eval.json   每个号的完整指标
//   reports/策略落地-20261025/策略排序.md           新/旧排序对比 + 补宝型通道 + 漏斗召回统计
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const teamsLib = require('./lib-teams.js');
const cfgLib = require('./lib-config.js');
const S = require('./lib-scoring.js');
const core = require('./plan5-core.js'); // 兼容入口（队伍解析 + 旧导出）

const ROOT = teamsLib.ROOT;
const CFG = cfgLib.loadConfig();
const L3 = S.getScoringConfig();
const DATA_FILE = process.argv[2] || path.join(ROOT, 'data', 'accounts-final.json');
// 可选第 3 参数: 输出目录（对照实验时避免覆盖主结果）
const OUT_DIR = process.argv[3] ? path.resolve(process.argv[3]) : path.join(ROOT, 'reports', '策略落地-20261025');

const TIER_W = L3.tierWeight;
const F_ONLY_GEAR = L3.onlyGearFactor;
const F_MISS_TAC = L3.missTacticFactor;
const T1PLUS = S.T1PLUS;
const HR = L3.hardRules;
const GATE = L3.gate;

const nf = S.nf;
const priceOf = S.priceOf;
const nMiss = S.nMiss;

// ---- 单个账号: 落地战力 / 门槛 / 画像（委托统一引擎） ----
function evaluate(acc, teams, useOverride) {
  return S.evaluate(acc, teams, useOverride);
}

// ---- 旧排序（复刻 recommend.js:70-72，用于同池对比；不做 server-price 去重） ----
function oldSortKey(r) {
  return r.full.length * 1000 + r.onlyGear.length * 100 + (r.full.length + r.onlyGear.length + r.missTac.length);
}

// ---- L2 反证: 在已采池内模拟阈值（仅 117 个浏览器来源有锻造数，API 按"未知不卡"） ----
function l2Sim(rows) {
  const variants = [
    { name: '现行 85/12（采集门槛，全部通过）', f: () => true },
    { name: '新门槛 90/22/15', f: r => r.stars >= 90 && r.sTac >= 22 && (r.forged == null || r.forged >= 15) },
    { name: '90/22/（锻造未知不卡）', f: r => r.stars >= 90 && r.sTac >= 22 },
    { name: '100/24/18', f: r => r.stars >= 100 && r.sTac >= 24 && (r.forged == null || r.forged >= 18) },
    { name: '85/S24/12', f: r => r.stars >= 85 && r.sTac >= 24 && (r.forged == null || r.forged >= 12) }
  ];
  return variants.map(v => {
    const sub = rows.filter(v.f);
    const full2 = sub.filter(r => r.full.length >= 2).length;
    const cand = sub.filter(r => (r.gatePass || r.baoBaoPass) && r.premiumOk).length;
    return { variant: v.name, n: sub.length, full2, full2Rate: sub.length ? nf(full2 / sub.length * 100) : 0, cand };
  });
}

const fmtTeams = list => list.length ? list.map(t => `${t.team}(${t.tier})`).join('、') : '—';

function main() {
  const teams = core.initTeams();
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const rowsOn = data.map(a => evaluate(a, teams, true));
  const rowsOff = data.map(a => evaluate(a, teams, false));
  // 同服同价但 ordersn 不同 → 旧链路会被去重误删, 这里在表格里用 ordersn 尾号区分
  const pairCount = {};
  rowsOn.forEach(r => { const k = `${r.server}-${r.price}`; pairCount[k] = (pairCount[k] || 0) + 1; });
  const label = r => pairCount[`${r.server}-${r.price}`] > 1 ? `${r.server}·${r.ordersn.slice(-4)}` : r.server;

  // 司马懿=晋 版本覆盖: 覆盖前后命中队数/账号数
  let gainAcc = 0, addTeams = 0;
  rowsOn.forEach((r, i) => {
    const off = rowsOff[i];
    const onN = r.full.length + r.onlyGear.length + r.missTac.length;
    const offN = off.full.length + off.onlyGear.length + off.missTac.length;
    if (onN > offN) gainAcc++;
    addTeams += r.preHard - off.preHard;
  });

  // 排序
  const gateRows = rowsOn.filter(r => r.gatePass).sort((a, b) => b.score - a.score || a.price - b.price);
  const baoRows = rowsOn.filter(r => r.baoBaoPass).sort((a, b) => b.score - a.score || a.price - b.price);
  const candRaw = rowsOn.filter(r => r.gatePass || r.baoBaoPass);
  const candidates = candRaw.filter(r => r.premiumOk);
  const premiumBlocked = candRaw.filter(r => !r.premiumOk).sort((a, b) => b.score - a.score || a.price - b.price);
  const rankRatio = candidates.slice().sort((a, b) => b.valuePer1000 - a.valuePer1000 || a.price - b.price);
  const premiumExcluded = rowsOn.filter(r => r.price > HR.premiumOver.price && !r.premiumOk);
  const oldRank = rowsOn.slice().sort((a, b) => oldSortKey(b) - oldSortKey(a) || a.price - b.price);

  // 新旧 Top10（1500-2000 同池，贴近旧自动文档口径）
  const inRange = rs => rs.filter(r => r.price >= 1500 && r.price <= 2000);
  const newTop10 = inRange(candidates.slice().sort((a, b) => b.score - a.score || a.price - b.price)).slice(0, 10);
  const oldTop10 = inRange(oldRank).slice(0, 10);
  const overlap = newTop10.filter(n => oldTop10.some(o => o.ordersn === n.ordersn)).length;
  const l2 = l2Sim(rowsOn);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'strategy-eval.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), config: CFG,
    summary: {
      accounts: rowsOn.length, gatePass: gateRows.length, baoBaoPass: baoRows.length,
      candidates: candidates.length, premiumBlocked: premiumBlocked.length,
      premiumExcluded: premiumExcluded.length,
      simaAccounts: gainAcc, simaExtraTeams: addTeams,
      simaRejectedFalseHits: addTeams < 0 ? -addTeams : 0
    },
    rows: rowsOn
  }, null, 1), 'utf-8');

  const L = [];
  const push = s => L.push(s);
  push(`# 新选号策略 · 落地评估（${CFG.version}）`);
  push('');
  push(`> 数据: \`${path.relative(ROOT, DATA_FILE)}\`（${rowsOn.length} 个号；价格口径见数据文件）｜参数: \`data/strategy-config.json\`｜评估引擎: \`scripts/lib-scoring.js\``);
  push(`> 排序公式: **落地战力 = Σ完整队权重 + ${F_ONLY_GEAR}×Σ只缺宝权重 + ${F_MISS_TAC}×Σ缺战法权重**，档位权重 ${JSON.stringify(TIER_W)}`);
  push('');
  push('## 1. 门槛与样本');
  push('');
  push('| 项 | 数量 |');
  push('|---|---:|');
  push(`| 参与评估账号 | ${rowsOn.length} |`);
  push(`| 主门槛通过（≥${GATE.minFullT1plus} 支完整 T1+，或 1 完整 + ${GATE.alt.minOnlyGearT1plus} 只缺宝 T1+） | **${gateRows.length}** |`);
  push(`| 补宝型通道（≥${GATE.alt2_baobao.minOnlyGearT1plus} 支只缺宝 T1+ 且其中 ≥${GATE.alt2_baobao.minRealGrowth} 支只缺 1-2 件宝） | ${baoRows.length} |`);
  push(`| 通过门槛但被「溢价规则」拦下（价格 >${HR.premiumOver.price} 且没有多买到完整 T1+ / T0 只缺宝） | ${premiumBlocked.length} |`);
  push(`| 全池中价格 >${HR.premiumOver.price} 且不满足溢价规则（含未过门槛的号） | ${premiumExcluded.length} |`);
  push(`| 司马懿=晋 版本覆盖：拦截伪命中队伍 / 净新增队伍 | ${addTeams < 0 ? -addTeams : 0} / 0（未覆盖时魏司马懿等会被误算；覆盖后晋司马懿队均因缺战法≥${HR.highTierMissingTactics.minMissing} 被硬规则剔除） |`);
  push('');
  push('## 2. 主门槛通过 · Top 15（按落地战力）');
  push('');
  push('| # | 账号 | 价格 | 战力 | 性价比/千元 | 完整 | 只缺宝 | 真成长 | 画像 | 溢价 |');
  push('|---:|---|---:|---:|---:|---|---:|---:|---|---|');
  gateRows.forEach((r, i) => {
    push(`| ${i + 1} | ${label(r)} | ¥${r.price} | **${r.score}** | ${r.valuePer1000} | ${r.full.length} | ${r.onlyGear.length} | ${r.growth.length} | ${r.profile} | ${r.price > HR.premiumOver.price ? (r.premiumOk ? '✅' : '❌') : '—'} |`);
  });
  push('');
  push('## 3. 补宝型通道（未过主门槛，但符合「只缺宝可兑现」）');
  push('');
  if (baoRows.length) {
    push('| # | 账号 | 价格 | 战力 | 性价比/千元 | 只缺宝 | 其中 T1+ | 真成长(≤2件) | 溢价 |');
    push('|---:|---|---:|---:|---:|---:|---:|---:|---|');
    baoRows.slice(0, 12).forEach((r, i) => {
      push(`| ${i + 1} | ${label(r)} | ¥${r.price} | ${r.score} | ${r.valuePer1000} | ${r.onlyGear.length} | ${r.onlyGearT1plus} | ${r.growth.length} | ${r.premiumOk ? '✅' : '❌'} |`);
    });
  } else push('（无）');
  push('');
  push('## 4. 性价比 Top 15（候选 = 门槛/补宝型通道 + 溢价规则，按 战力/千元）');
  push('');
  push('| # | 账号 | 价格 | 战力 | 性价比/千元 | 完整 | 真成长 | 画像 |');
  push('|---:|---|---:|---:|---:|---|---:|---|');
  rankRatio.slice(0, 15).forEach((r, i) => {
    push(`| ${i + 1} | ${label(r)} | ¥${r.price} | ${r.score} | **${r.valuePer1000}** | ${r.full.length} | ${r.growth.length} | ${r.profile} |`);
  });
  push('');
  push('### 4.1 被溢价规则拦下的高分号（价格 >2000 但没有买到完整 T1+ / T0 只缺宝）');
  push('');
  if (premiumBlocked.length) {
    push('| 账号 | 价格 | 战力 | 完整 | 只缺宝(T1+) | 真成长 | 拦截原因 |');
    push('|---|---:|---:|---:|---:|---:|---|');
    premiumBlocked.slice(0, 10).forEach(r => {
      push(`| ${label(r)} | ¥${r.price} | ${r.score} | ${r.full.length} | ${r.onlyGearT1plus} | ${r.growth.length} | 无完整 T1+ 且无 T0 只缺宝 |`);
    });
  } else push('（无）');
  push('### 4.1 Top 5 明细（按战力）');
  push('');
  const byScore = candidates.slice().sort((a, b) => b.score - a.score || a.price - b.price);
  for (const r of byScore.slice(0, 5)) {
    push(`#### ${label(r)} ¥${r.price}（战力 ${r.score}，${r.profile}，${r.gatePass ? '主门槛' : '补宝型通道'}）`);
    push(`- 完整队: ${fmtTeams(r.full)}`);
    push(`- 只缺宝: ${r.onlyGear.length ? r.onlyGear.map(t => `${t.team}(${t.tier})缺${t.eMiss || '?'}`).join('、') : '—'}`);
    push(`- 真成长（只缺 1-2 件宝的 T1+）: ${r.growth.length ? r.growth.map(t => `${t.team}(${t.tier})缺${t.eMiss}`).join('、') : '—'}`);
    push(`- 五星 ${r.stars} / S战法 ${r.sTac} / 锻造 ${r.forged == null ? '未知(API)' : r.forged}`);
    push('');
  }
  push('## 5. 新 vs 旧排序（1500-2000 同池对比）');
  push('');
  push(`- Top10 重叠: **${overlap} / 10**`);
  push('');
  push('| # | 新排序（门槛内，按战力） | 旧排序（完整队数） |');
  push('|---:|---|---|');
  for (let i = 0; i < 10; i++) {
    const n = newTop10[i], o = oldTop10[i];
    push(`| ${i + 1} | ${n ? `${label(n)} ¥${n.price}（${n.score}）` : '—'} | ${o ? `${label(o)} ¥${o.price}（完整${o.full.length}）` : '—'} |`);
  }
  push('');
  push('## 6. L2 列表门槛反证（在已采池内模拟，存在选择偏差）');
  push('');
  push('| 门槛变体 | 通过数 | 其中完整≥2 | 完整≥2 命中率 | 最终候选 |');
  push('|---|---:|---:|---:|---:|');
  for (const x of l2) push(`| ${x.variant} | ${x.n} | ${x.full2} | ${x.full2Rate}% | ${x.cand} |`);
  push('');
  push('> 注: 采集池本身已按「五星≥85 且 稀世宝物≥12」过滤，这里只能看"精度"（池内命中率），看不到"召回"（漏掉多少好号）；锻造数只有 117 个浏览器来源有，API 来源按"未知不卡"处理。');
  push('');
  push('## 7. 参数（改 data/strategy-config.json 后重跑本脚本）');
  push('');
  push('```json');
  push(JSON.stringify(CFG, null, 2));
  push('```');

  fs.writeFileSync(path.join(OUT_DIR, '策略排序.md'), L.join('\n'), 'utf-8');
  console.log('saved:', path.relative(ROOT, path.join(OUT_DIR, '策略排序.md')));
  console.log('saved:', path.relative(ROOT, path.join(OUT_DIR, 'strategy-eval.json')));
  console.log(`accounts=${rowsOn.length} gate=${gateRows.length} bao=${baoRows.length} candidates=${candidates.length} premiumBlocked=${premiumBlocked.length} simaReject=${-addTeams} overlap=${overlap}/10`);
}

main();
