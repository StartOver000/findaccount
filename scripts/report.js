#!/usr/bin/env node
// ============================================================
// report.js — 单进程找号报告（替代 report.ps1 的 analyze+check+plan5 三进程链）
//
// 职责:
//   1. 读 data/accounts-final.json（或 --data 指定文件）与队伍库（data/teams.json，缺失回退 md）；
//   2. 用 scripts/lib-scoring.js 统一评估引擎（参数全部来自 data/strategy-config.json）逐号评估；
//   3. 头部补齐可复现信息：数据快照时间/来源分布/状态分布/队伍库版本/config 指纹/runId/时效告警/解析自检；
//   4. 「一分钟摘要」Top 卡片 + 候选排名 + 重点账号落地 5 队明细 + 全量附表 + 自动购买建议；
//   5. 状态过滤：sold/delisted（配置 l0_data.excludeFromRecommend）不进入推荐，只保留在附表并标注。
//
// 用法:
//   node scripts/report.js --customer 自用
//   node scripts/report.js --customer 客户 --data data/accounts-final.json --top 12 --cards 5 --detail 5
//   node scripts/report.js --customer REPORTTEST --json
// 输出: docs/找号报告-<customer>-<YYYYMMDD>.md（--out 可覆盖）
// 退出码: 0 成功；1 失败（配置/数据/队伍库/写文件异常）
// 下游: scripts/find-all.ps1 调用 `node scripts/report.js --customer <name>` 并检查退出码。
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const teamsLib = require('./lib-teams.js');
const S = require('./lib-scoring.js');
const cfg = require('./lib-config.js');
const runmeta = require('./lib-runmeta.js');

const ROOT = teamsLib.ROOT;
const DEFAULT_DATA = path.join(ROOT, 'data', 'accounts-final.json');
const DOCS_DIR = path.join(ROOT, 'docs');

const STATUS_LABEL = {
  onSale: '上架中', publicity: '公示期', sold: '已售出', delisted: '已下架', other: '其他', unknown: '未知'
};
const STATUS_ORDER = ['onSale', 'publicity', 'sold', 'delisted', 'other', 'unknown'];

const USAGE = [
  '用法: node scripts/report.js --customer <客户名> [--data <file>] [--out <file>] [--top 12] [--cards 5] [--detail 5] [--json] [--quiet]',
  '',
  '  生成 docs/找号报告-<客户名>-<YYYYMMDD>.md（单进程替代 report.ps1 的 analyze+check+plan5 链）。',
  '  --customer  客户名，默认 自用（也是 find-all.ps1 传入的参数）',
  '  --data      账号数据文件，默认 data/accounts-final.json',
  '  --out       输出 md 路径（默认 docs/找号报告-<客户>-<YYYYMMDD>.md）',
  '  --top       候选排名表行数，默认 12',
  '  --cards     一分钟摘要卡片数，默认 5',
  '  --detail    落地队伍明细账号数，默认 5',
  '  --json      以 JSON 输出运行摘要（含耗时/计数/Top1），便于自动化校验',
  '  --quiet     不输出进度日志',
  '  -h/--help   显示帮助'
].join('\n');

// ---------------- CLI ----------------
function parseArgs(argv) {
  const o = {
    customer: '自用', data: DEFAULT_DATA, out: '', top: 12, cards: 5, detail: 5,
    json: false, quiet: false, help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} 缺少参数值`);
      return v;
    };
    switch (a) {
      case '--customer': case '-c': o.customer = next(); break;
      case '--data': o.data = next(); break;
      case '--out': o.out = next(); break;
      case '--top': o.top = Math.max(1, parseInt(next(), 10) || 12); break;
      case '--cards': o.cards = Math.max(1, parseInt(next(), 10) || 5); break;
      case '--detail': o.detail = Math.max(1, parseInt(next(), 10) || 5); break;
      case '--json': o.json = true; break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`未知参数: ${a}（--help 查看用法）`);
    }
  }
  return o;
}

// ---------------- 小工具 ----------------
function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON 解析失败: ${file}: ${e.message}`);
  }
}
const pad2 = n => String(n).padStart(2, '0');
function fmtDateTime(d) {
  if (!d || isNaN(d)) return '-';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function ymdLocal(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}
function ymdOf(d) {
  return d && !isNaN(d) ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : '?';
}
function fmtIso(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : fmtDateTime(d);
}
const dayDiff = (a, b) => Math.floor((a.getTime() - b.getTime()) / 86400000);
const esc = s => String(s == null ? '' : s).replace(/\|/g, '\\|');
function priceText(p) {
  if (p == null || isNaN(p)) return '-';
  return `¥${String(Math.round(Number(p))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}
function linkOf(server, url) {
  const label = esc(server);
  return url ? `[${label}](${url})` : label;
}
function countBy(rows, fn) {
  const out = {};
  for (const r of rows) {
    const k = fn(r) || 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
function sourceOf(acc) {
  const prov = (acc && acc.provenance) || {};
  const raw = acc.source || prov.source || (acc.list && acc.list.source) || '';
  if (raw) return String(raw);
  // merge 前的旧数据没有溯源字段：浏览器详情有 forged，API 直采没有
  return (acc.overview && acc.overview.forged != null) ? 'browser' : 'api';
}
function sourceLabel(k) {
  const s = String(k || '').toLowerCase();
  if (s.includes('browser') || s.includes('detail') || s.includes('浏览器')) return '浏览器';
  if (s.includes('api')) return 'API';
  return k || '未知';
}
function statusOf(acc) {
  const raw = (acc.overview && acc.overview.status) || acc.status || '';
  const kind = acc.statusKind || cfg.classifyStatus(raw);
  return { kind: kind || 'unknown', raw: String(raw || '') };
}
function teamTierLine(teams) {
  const by = {};
  for (const t of teams) by[t.Tier] = (by[t.Tier] || 0) + 1;
  return ['T0+', 'T0', 'T1', 'T2-'].filter(k => by[k]).map(k => `${k} ${by[k]}`).join(' / ');
}
function statusLine(counts) {
  return STATUS_ORDER.filter(k => counts[k]).map(k => `${STATUS_LABEL[k] || k} ${counts[k]}`).join(' / ');
}

// ---------------- 主流程 ----------------
function main() {
  const t0 = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const log = (...a) => { if (!opts.quiet) console.log(...a); };

  // 1) 配置（fail-closed：配置缺失/不合法直接失败）
  log('[report] 读取配置 ...');
  cfg.loadConfig();
  const l0 = cfg.getL0();
  const cfgHash = cfg.configFingerprint();
  const cfgSummary = cfg.effectiveSummary();
  const exclude = new Set(
    Array.isArray(l0.excludeFromRecommend) && l0.excludeFromRecommend.length
      ? l0.excludeFromRecommend
      : ['sold', 'delisted']
  );
  const maxStaleDays = typeof l0.maxStaleDays === 'number' ? l0.maxStaleDays : 14;
  // 单条记录的采集时效标注（候选表/明细用）：超过 maxStaleDays 或缺失采集时间 → ⏳ 需人工核价
  const fmtCapture = r => {
    if (!r.capturedAt) return '? ⏳';
    return `${ymdOf(r.capturedAt)}${r.ageDays != null && r.ageDays > maxStaleDays ? ' ⏳' : ''}`;
  };

  // 2) 账号数据
  const dataAbs = path.resolve(ROOT, opts.data);
  if (!fs.existsSync(dataAbs)) throw new Error(`找不到账号数据文件: ${dataAbs}`);
  log('[report] 读取账号数据 ...');
  const accounts = readJson(dataAbs);
  if (!Array.isArray(accounts)) throw new Error('账号数据必须是 JSON 数组');
  if (!accounts.length) throw new Error('账号数据为空');
  // 快照时间优先用每条账号的采集时间（provenance.capturedAt），文件 mtime 仅兜底
  const capturedMs = accounts
    .map(a => (a && a.capturedAt ? Date.parse(a.capturedAt) : NaN))
    .filter(ms => Number.isFinite(ms));
  const captured = capturedMs.length;
  const captureMin = captured ? new Date(Math.min(...capturedMs)) : null;
  const snapshotAt = captured ? new Date(Math.max(...capturedMs)) : fs.statSync(dataAbs).mtime;
  const staleDays = dayDiff(new Date(), snapshotAt);

  // 3) 队伍库
  log('[report] 加载队伍库 ...');
  const lib = teamsLib.loadTeams();
  const teams = lib.teams || [];
  if (!teams.length) throw new Error('队伍库为空（data/teams.json 与 docs/队伍强度排行榜.md 均不可用）');
  const doc = lib.doc || {};
  const teamHash = (doc.sourceHash || '').slice(0, 8);
  const teamSourceLabel = lib.source === 'teams.json' ? 'data/teams.json' : 'docs/队伍强度排行榜.md（回退解析）';

  // 4) 评估（lib-scoring 唯一实现；versionOverrides 生效）
  log(`[report] 评估 ${accounts.length} 个账号 × ${teams.length} 支队伍 ...`);
  const rows = [];
  let invalid = 0;
  const ageAnchor = new Date();
  accounts.forEach((acc, i) => {
    if (!acc || typeof acc !== 'object' || !acc.overview || !acc.list) { invalid++; return; }
    const ev = S.evaluate(acc, teams, true);
    const st = statusOf(acc);
    const capMs = acc.capturedAt ? Date.parse(acc.capturedAt) : NaN;
    const capturedAt = Number.isFinite(capMs) ? new Date(capMs) : null;
    rows.push({
      idx: i, acc, ev, st,
      src: sourceOf(acc),
      url: String(acc.overview.url || ''),
      server: acc.list.server || ev.server,
      price: ev.price, score: ev.score,
      capturedAt,
      ageDays: capturedAt ? dayDiff(ageAnchor, capturedAt) : null
    });
  });
  if (!rows.length) throw new Error('没有可评估的账号（记录缺少 overview/list 字段）');

  const sourceCounts = countBy(rows, r => sourceLabel(r.src));
  const statusCounts = countBy(rows, r => r.st.kind);
  let gatePassCount = 0, baoBaoCount = 0;
  for (const r of rows) {
    if (r.ev.gatePass) gatePassCount++;
    else if (r.ev.baoBaoPass) baoBaoCount++;
  }
  const passed = rows.filter(r => r.ev.gatePass || r.ev.baoBaoPass);
  const passedPremiumBlocked = passed.filter(r => !r.ev.premiumOk).length;
  const eligible = passed.filter(r => r.ev.premiumOk);
  const excludedByStatus = eligible.filter(r => exclude.has(r.st.kind)).length;
  const bought = eligible.filter(r => !exclude.has(r.st.kind));

  const byScore = (a, b) =>
    (b.score - a.score) || (a.price - b.price) || String(a.server).localeCompare(String(b.server));
  const ranked = bought.slice().sort(byScore);
  const candidates = ranked.slice(0, opts.top);
  const focus = ranked.slice(0, Math.max(opts.cards, opts.detail));
  const plans = new Map();
  for (const r of focus) plans.set(r, S.planAccount(r.acc, teams, { useOverride: true }));

  log(`[report] 过门槛 ${passed.length}（溢价拦截 ${passedPremiumBlocked}）| 可推荐 ${bought.length} | 售出/下架剔除 ${excludedByStatus}`);

  // 5) 头部可复现信息 + 告警
  const now = new Date();
  const warnings = [];
  const staleRowCount = rows.filter(r => !r.capturedAt || r.ageDays == null || r.ageDays > maxStaleDays).length;
  const staleCandidates = candidates.filter(r => !r.capturedAt || r.ageDays == null || r.ageDays > maxStaleDays).length;
  if (staleDays > maxStaleDays) {
    warnings.push(`数据时效: 快照距今 ${staleDays} 天，超过阈值 ${maxStaleDays} 天。价格与在售状态可能已变化，建议先刷新采集（powershell -File scripts/find-all.ps1）；下单前务必点开链接核对。`);
  }
  if (staleRowCount) {
    warnings.push(`数据时效: ${staleRowCount}/${rows.length} 条记录采集时间超过 ${maxStaleDays} 天或缺失（候选表/明细中标 ⏳），这些号的价格与在售状态需人工核对；⚠️ 报告头部「距今」按最新一条采集时间计，不代表候选号都新。`);
  }
  if (staleCandidates) {
    warnings.push(`候选时效: 候选 Top ${candidates.length} 中有 ${staleCandidates} 个采集超过 ${maxStaleDays} 天，下单前务必逐个点开链接核价（尤其旧价格可能已变）。`);
  }
  if (invalid) warnings.push(`跳过 ${invalid} 条缺少 overview/list 的无效记录。`);
  for (const w of lib.warnings || []) warnings.push(`队伍库: ${w}`);
  if (statusCounts.unknown) warnings.push(`状态未知 ${statusCounts.unknown} 个（原始数据无 status 字段），无法自动确认在售，已保留在附表中但需人工确认。`);
  if (passedPremiumBlocked) warnings.push(`溢价拦截 ${passedPremiumBlocked} 个（价格 > ${(S.getScoringConfig().hardRules.premiumOver || {}).price || '阈值'} 元且完整/高档落地不足），不进入推荐。`);

  let runLine = '未记录（data/run-meta.json 不存在或为空）';
  try {
    const meta = runmeta.readMeta();
    const last = meta.lastRun;
    if (last) {
      const parts = [
        `runId \`${last.runId || '-'}\``,
        `stage ${last.stage || '-'}`,
        `${last.status || '-'}`,
        fmtIso(last.finishedAt || last.startedAt)
      ];
      if (last.counts && last.counts.merged != null) parts.push(`merged ${last.counts.merged}`);
      if (last.configHash) parts.push(`config ${last.configHash}`);
      runLine = parts.join(' · ');
      if (last.configHash && last.configHash !== cfgHash) {
        warnings.push(`运行元数据: 最近一次采集/合并使用 config ${last.configHash}，当前配置指纹为 ${cfgHash}（报告按当前配置口径；重新采集后两者应一致）。`);
      }
    }
  } catch (e) {
    runLine = `读取失败: ${e.message}`;
  }

  const G = S.getScoringConfig().gate;
  const gateDesc = [
    `完整T1+≥${G.minFullT1plus}`,
    `或 完整T1+≥${G.alt.minFullT1plus} 且 只缺宝T1+≥${G.alt.minOnlyGearT1plus}`,
    `或 补宝型: 只缺宝T1+≥${G.alt2_baobao.minOnlyGearT1plus} 且 真成长≥${G.alt2_baobao.minRealGrowth}`
  ].join(' ');

  const elapsedAtHeader = Date.now() - t0;
  const md = [];
  md.push(`# 藏宝阁找号报告 - ${opts.customer} - ${ymdLocal(now)}`);
  md.push('');
  const captureDesc = captured
    ? `采集 ${fmtDateTime(captureMin)} ~ ${fmtDateTime(snapshotAt)}（${captured}/${rows.length} 条带来源时间）`
    : `文件修改 ${fmtDateTime(snapshotAt)} · 无 provenance 采集时间`;
  md.push(`> **数据快照**: \`${path.relative(ROOT, dataAbs)}\` · ${captureDesc} · 距今 ${staleDays} 天（按最新采集时间） · 超阈值/缺失采集时间 **${staleRowCount}/${rows.length}** 条（⏳） · 有效账号 **${rows.length}**${invalid ? `（跳过无效 ${invalid}）` : ''}`);
  md.push(`> **数据来源**: ${Object.entries(sourceCounts).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  md.push(`> **状态分布**: ${statusLine(statusCounts) || '无'}`);
  md.push(`> **队伍库**: ${teamSourceLabel} · **${teams.length} 队**（${teamTierLine(teams)}）${teamHash ? ` · 榜单 sha1 \`${teamHash}\`` : ''}`);
  md.push(`> **评估引擎**: scripts/lib-scoring.js · 配置指纹 \`${cfgHash}\` · ${cfgSummary}`);
  md.push(`> **运行元数据**: ${runLine}`);
  md.push(`> **门槛规则**: ${gateDesc}；状态过滤: ${[...exclude].join('/') || '无'} 不进入推荐`);
  md.push(`> **生成**: \`node scripts/report.js --customer ${esc(opts.customer)}\` · ${fmtDateTime(now)} · 耗时 ${elapsedAtHeader}ms（旧 ps1 链约 7400ms）`);
  if (warnings.length) {
    md.push('');
    for (const w of warnings) md.push(`> ⚠️ ${w}`);
  }
  md.push('');
  md.push('---');
  md.push('');

  // 一、一分钟摘要
  const cardN = Math.min(opts.cards, focus.length);
  md.push(`## 一、一分钟摘要（可推荐 Top ${cardN}）`);
  if (!cardN) {
    md.push('');
    md.push('> 当前没有「通过门槛 + 状态可购买 + 未触发溢价拦截」的账号。建议放宽预算或先刷新采集后重跑。');
  }
  focus.slice(0, cardN).forEach((r, i) => {
    const ev = r.ev;
    const plan = plans.get(r) || {};
    const best = (plan.res && plan.res.best) || [];
    const medal = ['🥇', '🥈', '🥉'][i] || `#${i + 1}`;
    const statusLabel = STATUS_LABEL[r.st.kind] || r.st.kind;
    const statusWarn = (r.st.kind === 'unknown' || r.st.kind === 'other') ? '⚠️ ' : '';
    md.push('');
    md.push(`### ${medal} ${statusWarn}${priceText(ev.price)} · ${esc(r.server)} · 战力 ${ev.score} · 性价比 ${ev.valuePer1000}/千元`);
    md.push('');
    md.push(`- 状态: **${statusLabel}**${r.st.raw && r.st.raw !== statusLabel ? `（${esc(r.st.raw)}）` : ''} · 采集: **${fmtCapture(r)}** · 画像: ${ev.profile} · 链接: ${r.url || '（无）'}`);
    md.push(`- 落地: 完整 **${ev.full.length}** 队 · 只缺宝 **${ev.onlyGear.length}** 队 · 缺战法 ${ev.missTac.length} 队（缺1可救 ${ev.missTacticStats.rescued}/${ev.missTacticStats.oneMissing} · 缺2 ${ev.missTacticStats.twoMissing} · 缺3+ ${ev.missTacticStats.threePlus}）| 完整T1+ ${ev.fullT1plus} · T0/T0+只缺宝 ${ev.t0OnlyGear} · 真成长 ${ev.growth.length} | 主门槛 ${ev.gatePass ? '✅' : '—'} · 补宝门槛 ${ev.baoBaoPass ? '✅' : '—'}`);
    md.push(`- 武将/战法/宝物: ${ev.stars != null ? `${ev.stars} 张五星` : '五星?'} · S战法 ${ev.sTac != null ? ev.sTac : '?'} · 锻造 ${ev.forged != null ? ev.forged : '?'} · 武将 ${ev.heroCount != null ? ev.heroCount : '?'} 名`);
    if (best.length) {
      md.push(`- 建议 5 队: ${best.map(c => `\`${c.Team}(${c.Tier}·${c.TMiss === '' ? (c.EMiss === '' ? '完整' : '只缺宝') : (c.k === 1 ? '缺1战法(可救)' : '缺战法')})\``).join('、')}`);
    }
  });

  // 二、候选排名
  md.push('');
  md.push('---');
  md.push('');
  md.push(`## 二、候选排名（过门槛 + 状态可购买，Top ${candidates.length}）`);
  md.push('');
  md.push(`> 过门槛账号 ${passed.length} 个（主门槛 ${gatePassCount} / 补宝门槛 ${baoBaoCount}），其中溢价拦截 ${passedPremiumBlocked} 个、状态为 ${[...exclude].join('/')} 剔除 ${excludedByStatus} 个；下表为剩余可推荐账号。`);
  md.push('');
  md.push('| # | 账号 | 价格 | 采集 | 状态 | 战力 | 性价比 | 完整 | 只缺宝 | 缺战法(1/2/3+) | 完整T1+ | 画像 |');
  md.push('|---|------|------|------|------|------|--------|------|--------|--------|---------|------|');
  candidates.forEach((r, i) => {
    md.push(`| ${i + 1} | ${linkOf(r.server, r.url)} | ${priceText(r.price)} | ${fmtCapture(r)} | ${STATUS_LABEL[r.st.kind] || r.st.kind} | ${r.ev.score} | ${r.ev.valuePer1000} | ${r.ev.full.length} | ${r.ev.onlyGear.length} | ${r.ev.missTacticStats.oneMissing}/${r.ev.missTacticStats.twoMissing}/${r.ev.missTacticStats.threePlus} | ${r.ev.fullT1plus} | ${r.ev.profile} |`);
  });
  if (!candidates.length) md.push('| - | 无 | - | - | - | - | - | - | - | - | - | - |');

  // 三、重点账号落地 5 队明细
  md.push('');
  md.push('---');
  md.push('');
  md.push('## 三、重点账号落地 5 队明细（武将不重复）');
  const detailN = Math.min(opts.detail, focus.length);
  if (!detailN) md.push('\n> 无可展示账号。');
  focus.slice(0, detailN).forEach((r, i) => {
    const ev = r.ev;
    const plan = plans.get(r) || {};
    const best = (plan.res && plan.res.best) || [];
    md.push('');
    md.push(`### 3.${i + 1} ${priceText(r.price)} · ${linkOf(r.server, r.url)} · 战力 ${ev.score} · ${ev.profile} · ${STATUS_LABEL[r.st.kind] || r.st.kind} · 采集 ${fmtCapture(r)}`);
    md.push('');
    md.push(`> 完整 ${ev.full.length} / 只缺宝 ${ev.onlyGear.length} / 缺战法 ${ev.missTac.length}（缺1可救 ${ev.missTacticStats.rescued}/${ev.missTacticStats.oneMissing} · 缺2 ${ev.missTacticStats.twoMissing} · 缺3+ ${ev.missTacticStats.threePlus}）· 真成长 ${ev.growth.length} · 组合最优评分 ${plan.res ? plan.res.bestScore : '-'}`);
    md.push(`> T1+ 战法缺口: 缺1 ${ev.missT1plus.one}（可救 ${ev.missT1plus.rescued}）/ 缺2 ${ev.missT1plus.two} / 缺3+ ${ev.missT1plus.threePlus}；每本战法最多救 1 队，未救回及缺≥2 的队不进「现有可打 5 队」`);
    md.push('');
    md.push('| # | 队伍 | 档位 | 状态 | 缺战法 | 缺宝物 | 武将 |');
    md.push('|---|------|------|------|--------|--------|------|');
    best.forEach((c, j) => {
      const st = c.TMiss === '' ? (c.EMiss === '' ? '✅完整' : '🟡只缺宝') : (c.k === 1 ? '🟠缺1战法(可救)' : (c.k === 2 ? '🟠缺2战法(降档)' : '🔴缺3+战法(记0)'));
      const heroes = (c.Heroes || []).map(esc).join('、');
      md.push(`| ${j + 1} | ${esc(c.Team)} | ${c.Tier} | ${st} | ${esc(c.TMiss || '—')} | ${esc(c.EMiss || '—')} | ${heroes} |`);
    });
    if (!best.length) md.push('| - | 无可落地队伍 | - | - | - | - | - |');
  });

  // 四、全量附表
  md.push('');
  md.push('---');
  md.push('');
  md.push(`## 四、全量账号附表（按战力排序，共 ${rows.length} 个）`);
  md.push('');
  md.push(`> ✅ = 进入推荐；🚫 = 状态为 ${[...exclude].join('/')}（不进入推荐）；⛔ = 未过门槛；⚠️ = 溢价拦截。`);
  md.push('');
  md.push('| # | 账号 | 价格 | 状态 | 战力 | 完整 | 只缺宝 | 缺战法 | 完整T1+ | 门槛 | 溢价 | 推荐 |');
  md.push('|---|------|------|------|------|------|--------|--------|---------|------|------|------|');
  const allSorted = rows.slice().sort(byScore);
  allSorted.forEach((r, i) => {
    const gate = r.ev.gatePass ? '✅' : (r.ev.baoBaoPass ? '🟡补宝' : '⛔');
    const prem = r.ev.premiumOk ? '✅' : '⚠️';
    const rec = exclude.has(r.st.kind) ? '🚫' : ((r.ev.gatePass || r.ev.baoBaoPass) && r.ev.premiumOk ? '✅' : '—');
    md.push(`| ${i + 1} | ${esc(r.server)}${(!r.capturedAt || r.ageDays > maxStaleDays) ? ' ⏳' : ''} | ${priceText(r.price)} | ${STATUS_LABEL[r.st.kind] || r.st.kind} | ${r.score} | ${r.ev.full.length} | ${r.ev.onlyGear.length} | ${r.ev.missTac.length} | ${r.ev.fullT1plus} | ${gate} | ${prem} | ${rec} |`);
  });

  // 五、购买建议（自动）
  md.push('');
  md.push('---');
  md.push('');
  md.push('## 五、购买建议（自动生成）');
  md.push('');
  const top1 = ranked[0];
  const maxFull = ranked.slice().sort((a, b) => (b.ev.full.length - a.ev.full.length) || (b.score - a.score))[0];
  const maxGrowth = ranked.slice().sort((a, b) => (b.ev.growth.length - a.ev.growth.length) || (b.score - a.score))[0];
  const cheapest = ranked.slice().sort((a, b) => (a.price - b.price) || (b.score - a.score))[0];
  const suggest = (r, why) => r
    ? `- **${why}**: ${linkOf(r.server, r.url)} ${priceText(r.price)} · 战力 ${r.ev.score} · 完整 ${r.ev.full.length} / 只缺宝 ${r.ev.onlyGear.length} / 真成长 ${r.ev.growth.length}（${r.ev.profile}）`
    : `- **${why}**: 无`;
  md.push(suggest(top1, '综合最优（战力最高）'));
  if (maxFull) md.push(suggest(maxFull, '武将最全（完整队伍最多）'));
  if (maxGrowth) md.push(suggest(maxGrowth, '补宝最快（真成长最多）'));
  if (cheapest) md.push(suggest(cheapest, '预算优先（可推荐中价格最低）'));
  md.push('');
  md.push('> **决策提示**:');
  const tips = [];
  tips.push(`售出/下架账号 ${excludedByStatus} 个、溢价拦截 ${passedPremiumBlocked} 个已排除在推荐之外；状态未知 ${statusCounts.unknown || 0} 个需人工点开链接确认。`);
  if (staleDays > maxStaleDays) tips.push(`数据快照距今 ${staleDays} 天（阈值 ${maxStaleDays}），价格/在售状态可能已变化，下单前请以商品链接为准。`);
  if (staleCandidates) tips.push(`候选 Top ${candidates.length} 中有 ${staleCandidates} 个采集超过 ${maxStaleDays} 天（表中 ⏳），旧价格可能已变或已下架；下单前先刷新采集并逐个核对链接。`);
  tips.push('补宝口径: 宝物按「自锻 / 材料累计」评估可解锁队伍，不按购买价计成本；表中「只缺宝」只表示缺件，不等于需要花钱买宝。');
  tips.push('战力 = 榜单档位权重 × 落地状态系数（完整 1.0 / 只缺宝 0.8 / 缺 1 本战法 0.7 且每本战法最多救 1 队 / 缺 2 本战法降一档 ×0.6 / 缺 3+ 本记 0；只缺宝过多另有降权），未计入红度、赛季、宝物词条等细项，最终以游戏内实测为准。');
  tips.push('榜单未识别项（弓诸葛/新垣曲/刘璋、8 个战法、金鸾/隕口/戟 等宝物）按「缺失」保守计算，相关队伍落地可能被低估。');
  for (const t of tips) md.push(`> - ${t}`);
  md.push('');
  md.push('---');
  md.push('');
  md.push('> 生成器: `scripts/report.js`（单进程）· 数据与规则单一来源: `data/strategy-config.json` · 队伍库: `data/teams.json` · 评估引擎: `scripts/lib-scoring.js`');
  md.push('');

  // 6) 写文件
  const outAbs = opts.out
    ? path.resolve(ROOT, opts.out)
    : path.join(DOCS_DIR, `找号报告-${opts.customer}-${ymdLocal(now)}.md`);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const tmp = `${outAbs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, md.join('\n'), 'utf8');
  fs.renameSync(tmp, outAbs);
  const elapsedMs = Date.now() - t0;
  const relOut = path.relative(ROOT, outAbs) || outAbs;

  const summary = {
    ok: true,
    out: relOut,
    customer: opts.customer,
    elapsedMs,
    accounts: rows.length,
    invalid,
    teams: teams.length,
    teamSource: lib.source,
    teamHash: teamHash || null,
    configHash: cfgHash,
    dataSnapshot: snapshotAt.toISOString(),
    staleDays,
    staleWarn: staleDays > maxStaleDays,
    staleRows: staleRowCount,
    staleCandidates,
    gatePass: gatePassCount,
    baoBaoPass: baoBaoCount,
    premiumBlocked: passedPremiumBlocked,
    excludedByStatus,
    recommendable: bought.length,
    top1: top1
      ? { server: top1.server, price: top1.price, score: top1.score, gatePass: top1.ev.gatePass, profile: top1.ev.profile, url: top1.url }
      : null
  };

  if (opts.json) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(`✅ 报告已生成: ${relOut} (${elapsedMs}ms) | 账号 ${rows.length} | 队伍 ${teams.length} | 过门槛 ${passed.length} | 可推荐 ${bought.length} | Top1 ${top1 ? `${top1.server} ${priceText(top1.price)} 战力${top1.score}` : '无'}`);
  }
}

try {
  main();
} catch (e) {
  console.error(`[report] 失败: ${e && e.message ? e.message : e}`);
  if (process.env.REPORT_DEBUG && e && e.stack) console.error(e.stack);
  process.exitCode = 1;
}
