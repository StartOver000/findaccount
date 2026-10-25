#!/usr/bin/env node
'use strict';
/**
 * candidate-checklist.js — 候选核对清单（下单前人工核对用）
 *
 * 输入: data/accounts-final.json + data/teams.json + data/strategy-config.json
 * 输出: docs/候选核对清单-YYYYMMDD.md（可用 --out 覆盖）
 *
 * 设计口径（2026-10-25）:
 *   - 候选 = 通过主门槛/补宝门槛 + 状态可购买 + 未触发溢价拦截，按战力降序
 *   - 宝物按「自行锻造 / 材料累计」计：清单里只列缺件数量，不按购买价计成本
 *   - 每条记录标注真实采集时间；超过 l0_data.maxStaleDays 标 ⏳ 提醒下单前核价
 *   - 战法缺口仅列「已按曲线救回」的缺 1 本队伍，缺≥2 本不进现有可打阵容
 *
 * 用法:
 *   node scripts/candidate-checklist.js [--data <file>] [--out <file>] [--top 12] [--json]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const cfg = require('./lib-config.js');
const teamsLib = require('./lib-teams.js');
const S = require('./lib-scoring.js');

const USAGE = [
  '用法: node scripts/candidate-checklist.js [--data <file>] [--out <file>] [--top 12] [--json]',
  '',
  '  --data  账号数据，默认 data/accounts-final.json',
  '  --out   输出 Markdown，默认 docs/候选核对清单-YYYYMMDD.md',
  '  --top   候选行数，默认 12',
  '  --json  仅输出 JSON 摘要（不写 Markdown）',
  ''
].join('\n');

function parseArgs(argv) {
  const o = { data: 'data/accounts-final.json', out: '', top: 12, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--help': case '-h': console.log(USAGE); process.exit(0); break;
      case '--data': o.data = next() || o.data; break;
      case '--out': o.out = next() || ''; break;
      case '--top': o.top = Math.max(1, parseInt(next(), 10) || 12); break;
      case '--json': o.json = true; break;
      default: throw new Error(`未知参数: ${a}（--help 查看用法）`);
    }
  }
  return o;
}

const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const ymdDash = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayDiff = (a, b) => Math.floor((a.getTime() - b.getTime()) / 86400000);
const priceText = p => (p == null || isNaN(p) ? '-' : `¥${Math.round(Number(p)).toLocaleString('en-US')}`);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { throw new Error(`JSON 解析失败: ${p}: ${e.message}`); }
}
function statusOf(acc) {
  const raw = (acc.overview && acc.overview.status) || acc.status || '';
  const kind = acc.statusKind || cfg.classifyStatus(raw);
  return { kind: kind || 'unknown', raw: String(raw || '') };
}
function sourceOf(acc) {
  const prov = (acc && acc.provenance) || {};
  const raw = acc.source || prov.source || (acc.list && acc.list.source) || '';
  if (raw) return String(raw);
  return (acc.overview && acc.overview.forged != null) ? 'browser' : 'api';
}
function splitNames(s) {
  return String(s || '').split(/[\/、,，]/).map(x => x.trim()).filter(Boolean);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  cfg.loadConfig();
  const l0 = cfg.getL0();
  const maxStaleDays = typeof l0.maxStaleDays === 'number' ? l0.maxStaleDays : 14;
  const exclude = new Set(Array.isArray(l0.excludeFromRecommend) && l0.excludeFromRecommend.length
    ? l0.excludeFromRecommend : ['sold', 'delisted']);

  const dataAbs = path.resolve(ROOT, opts.data);
  if (!fs.existsSync(dataAbs)) throw new Error(`找不到账号数据文件: ${dataAbs}`);
  const accounts = readJson(dataAbs);
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('账号数据必须是 JSON 数组且非空');

  const lib = teamsLib.loadTeams();
  const teams = lib.teams || [];
  if (!teams.length) throw new Error('队伍库为空（data/teams.json 与 docs/队伍强度排行榜.md 均不可用）');
  const doc = lib.doc || {};
  const teamHash = (doc.sourceHash || '').slice(0, 8);

  const now = new Date();
  const rows = [];
  for (const acc of accounts) {
    if (!acc || typeof acc !== 'object' || !acc.overview || !acc.list) continue;
    const ev = S.evaluate(acc, teams, true);
    const st = statusOf(acc);
    const capMs = acc.capturedAt ? Date.parse(acc.capturedAt) : NaN;
    const capturedAt = Number.isFinite(capMs) ? new Date(capMs) : null;
    rows.push({
      acc, ev, st,
      server: acc.list.server || ev.server,
      price: ev.price, score: ev.score,
      url: String(acc.overview.url || ''),
      ordersn: String(acc.ordersn || acc.list.ordersn || ''),
      capturedAt,
      ageDays: capturedAt ? dayDiff(now, capturedAt) : null,
      src: sourceOf(acc)
    });
  }
  const passed = rows.filter(r => r.ev.gatePass || r.ev.baoBaoPass);
  const eligible = passed.filter(r => r.ev.premiumOk && !exclude.has(r.st.kind));
  eligible.sort((a, b) => (b.score - a.score) || (a.price - b.price) || String(a.server).localeCompare(String(b.server)));
  const candidates = eligible.slice(0, opts.top);

  const fmtCapture = r => (r.capturedAt
    ? `${ymdDash(r.capturedAt)}${r.ageDays != null && r.ageDays > maxStaleDays ? ' ⏳' : ''}`
    : '? ⏳');

  // 汇总每号缺口（宝物按自锻口径列件数；战法列出已救回的缺 1 本队）
  const details = candidates.map(r => {
    const gearCount = {};
    let gearTotal = 0;
    for (const t of r.ev.onlyGear) {
      for (const name of splitNames(t.EMiss)) { gearCount[name] = (gearCount[name] || 0) + 1; gearTotal++; }
    }
    const tacCount = {};
    for (const t of r.ev.missTac) {
      if (t.k !== 1 || !t.rescued) continue;
      for (const name of splitNames(t.TMiss)) { tacCount[name] = (tacCount[name] || 0) + 1; }
    }
    const gearList = Object.entries(gearCount).sort((a, b) => b[1] - a[1]);
    const tacList = Object.entries(tacCount).sort((a, b) => b[1] - a[1]);
    return { r, gearList, gearTotal, tacList };
  });

  const staleCandidates = candidates.filter(r => !r.capturedAt || r.ageDays == null || r.ageDays > maxStaleDays).length;
  const staleRows = rows.filter(r => !r.capturedAt || r.ageDays == null || r.ageDays > maxStaleDays).length;

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      accounts: rows.length,
      candidates: candidates.length,
      passed: passed.length,
      staleRows,
      staleCandidates,
      data: path.relative(ROOT, dataAbs),
      teamHash: teamHash || null,
      configHash: cfg.configFingerprint(),
      top: details.slice(0, opts.top).map(d => ({
        server: d.r.server, price: d.r.price, score: d.r.score,
        capturedAt: d.r.capturedAt ? d.r.capturedAt.toISOString() : null,
        stale: d.r.ageDays == null || d.r.ageDays > maxStaleDays,
        full: d.r.ev.full.length, onlyGear: d.r.ev.onlyGear.length,
        fullT1plus: d.r.ev.fullT1plus, profile: d.r.ev.profile,
        gearNeeded: d.gearList.map(([name, n]) => `${name}×${n}`),
        gearTotal: d.gearTotal,
        tacticRescued: d.tacList.map(([name, n]) => `${name}×${n}`),
        url: d.r.url, ordersn: d.r.ordersn
      }))
    }));
    return;
  }

  const md = [];
  md.push(`# 候选核对清单 - ${ymdDash(now)}`);
  md.push('');
  md.push(`> **用途**: 下单前逐条核对「价格 / 在售状态 / 区服」；宝物按**自行锻造、材料累计**处理，不按购买价计成本。`);
  md.push(`> **数据**: \`${path.relative(ROOT, dataAbs)}\` · 共 ${rows.length} 个账号 · 超阈值/缺失采集时间 ${staleRows} 条（⏳）`);
  md.push(`> **候选**: 过门槛 ${passed.length} → 状态可购买且未触发溢价 ${eligible.length} → 清单 Top ${candidates.length}（其中 ⏳ 过期 ${staleCandidates} 个）`);
  md.push(`> **口径**: 队伍库 ${teams.length} 队${teamHash ? `（sha1 \`${teamHash}\`）` : ''} · 配置指纹 \`${cfg.configFingerprint()}\` · 战力=档位权重×落地系数（完整 1.0 / 只缺宝 0.8 / 缺1本×0.7 每本最多救1队 / 缺2本降档×0.6 / 缺3+记0）`);
  md.push('');

  md.push('## 一、候选总表');
  md.push('');
  md.push('| # | 账号 | 价格 | 采集 | 战力 | 完整 | 完整T1+ | 只缺宝 | 缺1(救) | 真成长 | 画像 | 链接 |');
  md.push('|---|------|------|------|------|------|---------|--------|---------|--------|------|------|');
  details.forEach((d, i) => {
    const r = d.r;
    md.push(`| ${i + 1} | ${r.server} | ${priceText(r.price)} | ${fmtCapture(r)} | ${r.score} | ${r.ev.full.length} | ${r.ev.fullT1plus} | ${r.ev.onlyGear.length} | ${r.ev.missTacticStats.oneMissing}(${r.ev.missTacticStats.rescued}) | ${r.ev.growth.length} | ${r.ev.profile} | ${r.url ? `[打开](${r.url})` : '—'} |`);
  });
  if (!details.length) md.push('| - | 无候选 | - | - | - | - | - | - | - | - | - | - |');

  md.push('');
  md.push('## 二、逐号核对');
  details.forEach((d, i) => {
    const r = d.r;
    md.push('');
    md.push(`### ${i + 1}. ${r.server} · ${priceText(r.price)} · 战力 ${r.score} · ${r.ev.profile}`);
    md.push('');
    md.push(`- 采集时间: **${fmtCapture(r)}**${r.ageDays != null ? `（${r.ageDays} 天前）` : ''} · 状态: **${r.st.kind}**${r.st.raw && r.st.raw !== r.st.kind ? `（${r.st.raw}）` : ''} · 来源: ${r.src}`);
    md.push(`- 商品链接: ${r.url || '（无）'}${r.ordersn ? ` · ordersn \`${r.ordersn}\`` : ''}`);
    md.push(`- 落地: 完整 **${r.ev.full.length}** 队（完整T1+ ${r.ev.fullT1plus}）· 只缺宝 **${r.ev.onlyGear.length}** 队 · 缺战法 ${r.ev.missTac.length} 队（缺1 ${r.ev.missTacticStats.oneMissing}，已救 ${r.ev.missTacticStats.rescued}；缺2 ${r.ev.missTacticStats.twoMissing}；缺3+ ${r.ev.missTacticStats.threePlus}）· 真成长 ${r.ev.growth.length}`);
    md.push(`- 自锻宝物缺口: ${d.gearTotal ? `共 ${d.gearTotal} 件 —— ${d.gearList.map(([n, c]) => `${n}×${c}`).join('、')}` : '无（只缺宝 0 队）'}`);
    md.push(`- 补战法（已计入战力）: ${d.tacList.length ? d.tacList.map(([n, c]) => `${n}×${c}`).join('、') : '无'}`);
    md.push(`- 核对: [ ] 价格一致 [ ] 仍在售/公示 [ ] 区服是本批试师 [ ] 宝物件数可自锻 [ ] 备注：__________`);
  });

  md.push('');
  md.push('## 三、使用说明');
  md.push('');
  md.push('- 本清单只用于**核对**，最终排序仍以 `docs/找号报告-*.md` 与 `docs/最终购买建议-*.md` 为准；');
  md.push('- 卡片标 ⏳ 的记录已超过 `l0_data.maxStaleDays`（当前 ' + maxStaleDays + ' 天），价格/在售状态可能已变化，下单前请刷新采集或直接点开链接确认；');
  md.push('- 宝物缺口按队伍需求逐件累计（同一件宝可能在不同方案中复用），实际自锻时按你最终选的 5 队方案准备即可；');
  md.push('- 缺 2 本及以上战法的队伍不计入现有可打阵容，仅作「将来抽到对应战法」的参考。');
  md.push('');

  const outAbs = opts.out ? path.resolve(ROOT, opts.out) : path.join(ROOT, 'docs', `候选核对清单-${ymd(now)}.md`);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const tmp = `${outAbs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, md.join('\n'), 'utf8');
  fs.renameSync(tmp, outAbs);

  console.log(`✅ 候选核对清单已生成: ${path.relative(ROOT, outAbs)} | 账号 ${rows.length} | 候选 ${candidates.length} | 过期候选 ${staleCandidates}`);
}

try { main(); } catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
