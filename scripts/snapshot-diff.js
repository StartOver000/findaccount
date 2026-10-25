#!/usr/bin/env node
// ============================================================
// snapshot-diff.js — 两次采集快照差异（新上架 / 降价 / 涨价 / 下架 / 状态变化）
//
// 用途: 找号场景下对比前后两份 accounts-*.json（或任意同结构数组），
//       快速看出本次刷新有哪些新号、涨降价、消失、状态迁移。
//
// 用法:
//   node scripts/snapshot-diff.js --prev data/tmp/a.json --cur data/tmp/b.json
//   node scripts/snapshot-diff.js --prev a.json --cur b.json --json data/tmp/diff.json --md data/tmp/diff.md
//   node scripts/snapshot-diff.js --prev a.json --cur b.json --json --md      # 写默认路径 data/tmp/snapshot-diff/
// 输出:
//   - stdout 可读摘要（默认；--quiet 关闭）
//   - --json [file] 结构化差异；--md [file] Markdown 摘要（不传 file 时写默认目录）
// 退出码: 0 成功；1 参数/文件/JSON 错误
// 说明: 账号身份键优先用 url 路径段（藏宝阁 ordersn），否则回退 server|stars|heroCount 组合键。
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const cfg = require('./lib-config.js');
const S = require('./lib-scoring.js');

const ROOT = cfg.ROOT;
const DEFAULT_OUT_DIR = path.join(ROOT, 'data', 'tmp', 'snapshot-diff');

const USAGE = [
  '用法: node scripts/snapshot-diff.js --prev <旧快照> --cur <新快照> [--json [file]] [--md [file]] [--max 20] [--quiet]',
  '',
  '  对比两份账号 JSON，输出: 新上架 / 降价 / 涨价 / 下架(消失) / 状态变化。',
  '  --prev <file>   旧快照（必填）',
  '  --cur <file>    新快照（必填）',
  '  --json [file]   输出 JSON 差异（不传 file 时写 data/tmp/snapshot-diff/diff-<时间>.json）',
  '  --md [file]     输出 Markdown 摘要（不传 file 时写 data/tmp/snapshot-diff/diff-<时间>.md）',
  '  --max <n>       每节最多列 n 条（默认 20，0=不限）',
  '  --quiet         不打印 stdout 摘要',
  '  -h/--help       显示帮助'
].join('\n');

// ---------------- CLI ----------------
function parseArgs(argv) {
  const o = { prev: '', cur: '', json: null, md: null, max: 20, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} 缺少参数值`);
      return v;
    };
    switch (a) {
      case '--prev': o.prev = next(); break;
      case '--cur': o.cur = next(); break;
      case '--json': o.json = (argv[i + 1] && !argv[i + 1].startsWith('-')) ? next() : ''; break;
      case '--md': o.md = (argv[i + 1] && !argv[i + 1].startsWith('-')) ? next() : ''; break;
      case '--max': o.max = Math.max(0, parseInt(next(), 10) || 0); break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`未知参数: ${a}（--help 查看用法）`);
    }
  }
  return o;
}

// ---------------- 工具 ----------------
function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON 解析失败: ${file}: ${e.message}`);
  }
}
const pad2 = n => String(n).padStart(2, '0');
function stamp(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
function fmtPrice(p) {
  if (p == null || isNaN(p)) return '-';
  return `¥${String(Math.round(Number(p))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}
function safeStatus(acc) {
  const raw = (acc.overview && acc.overview.status) || acc.status || '';
  const kind = acc.statusKind || cfg.classifyStatus(raw);
  return { kind: kind || 'unknown', raw: String(raw || '') };
}
// 账号身份键：藏宝阁 url 路径末段（ordersn，如 202607311302116-1-L13BJGQHU8HNJQ）
function keyOf(acc) {
  const url = String((acc.overview && acc.overview.url) || '');
  const seg = url.split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || '';
  if (/^\d{8,}-\d+-/.test(seg)) return `ordersn:${seg}`;
  const list = acc.list || {};
  const ov = acc.overview || {};
  const alt = [list.server || ov.server || '?', list.stars || ov.stars || '?', acc.heroCount || ov.heroCount || '?', acc.overview && acc.overview.url ? 'u' : 'n'].join('|');
  return `fallback:${alt}`;
}
function serverOf(acc) {
  return (acc.list && acc.list.server) || (acc.overview && acc.overview.server) || '?';
}
function urlOf(acc) {
  return String((acc.overview && acc.overview.url) || '');
}
function starsOf(acc) {
  const v = (acc.list && acc.list.stars) || (acc.overview && acc.overview.stars);
  return v != null ? parseInt(v, 10) : null;
}
function indexAccounts(accounts, label, warnings) {
  const map = new Map();
  let skipped = 0;
  for (const acc of accounts) {
    if (!acc || typeof acc !== 'object') { skipped++; continue; }
    const k = keyOf(acc);
    if (map.has(k)) {
      warnings.push(`${label}: 身份键重复 ${k}（${serverOf(acc)}）——后一条覆盖前一条`);
      skipped++;
      continue;
    }
    map.set(k, acc);
  }
  return { map, skipped };
}
function entryOf(acc) {
  const st = safeStatus(acc);
  return {
    key: keyOf(acc),
    server: serverOf(acc),
    price: S.priceOf(acc),
    stars: starsOf(acc),
    status: st.raw,
    statusKind: st.kind,
    url: urlOf(acc)
  };
}

// ---------------- 差异计算 ----------------
function diffAccounts(prevList, curList, prevLabel, curLabel) {
  const warnings = [];
  const prev = indexAccounts(prevList, prevLabel, warnings);
  const cur = indexAccounts(curList, curLabel, warnings);
  const out = {
    generatedAt: new Date().toISOString(),
    prev: { file: prevLabel, accounts: prev.map.size },
    cur: { file: curLabel, accounts: cur.map.size },
    newListings: [], removed: [], priceUp: [], priceDown: [], statusChanged: [], unchanged: 0
  };
  for (const [k, acc] of cur.map) {
    const old = prev.map.get(k);
    if (!old) { out.newListings.push(entryOf(acc)); continue; }
    const a = entryOf(old);
    const b = entryOf(acc);
    if (a.price != null && b.price != null && a.price !== b.price) {
      const rec = {
        key: k, server: b.server, stars: b.stars,
        prevPrice: a.price, curPrice: b.price,
        delta: b.price - a.price,
        deltaPct: a.price > 0 ? Number((((b.price - a.price) / a.price) * 100).toFixed(1)) : null,
        status: b.status, statusKind: b.statusKind, url: b.url
      };
      (b.price > a.price ? out.priceUp : out.priceDown).push(rec);
    }
    if (a.statusKind !== b.statusKind || a.status !== b.status) {
      out.statusChanged.push({
        key: k, server: b.server, price: b.price, stars: b.stars,
        prevStatus: a.status, prevStatusKind: a.statusKind,
        curStatus: b.status, curStatusKind: b.statusKind,
        url: b.url
      });
    }
    if (a.statusKind === b.statusKind && a.status === b.status && a.price === b.price) out.unchanged++;
  }
  for (const [k, acc] of prev.map) {
    if (!cur.map.has(k)) out.removed.push(entryOf(acc));
  }
  // 消失明细：能判断是「已售出/已下架」的单独标注
  for (const r of out.removed) {
    if (r.statusKind === 'sold' || r.statusKind === 'delisted') r.reason = '状态为 ' + r.statusKind;
    else r.reason = '快照中消失（视为下架/售出/移出价格区间）';
  }
  out.counts = {
    prev: prev.map.size,
    cur: cur.map.size,
    newListing: out.newListings.length,
    removed: out.removed.length,
    priceUp: out.priceUp.length,
    priceDown: out.priceDown.length,
    statusChanged: out.statusChanged.length,
    unchanged: out.unchanged
  };
  out.skipped = { prev: prev.skipped, cur: cur.skipped };
  out.warnings = warnings;
  return out;
}

// ---------------- 可读摘要 ----------------
function sectionLines(title, items, max, render) {
  const lines = [`## ${title}（${items.length}）`];
  if (!items.length) { lines.push('- 无'); return lines; }
  const shown = max > 0 ? items.slice(0, max) : items;
  for (const it of shown) lines.push(render(it));
  if (shown.length < items.length) lines.push(`- …另有 ${items.length - shown.length} 条`);
  return lines;
}
function renderMarkdown(d) {
  const lines = [];
  lines.push(`# 快照差异 - ${d.prev.file} → ${d.cur.file}`);
  lines.push('');
  lines.push(`> 生成: ${d.generatedAt} · 旧快照 ${d.counts.prev} 个账号 · 新快照 ${d.counts.cur} 个账号`);
  lines.push(`> 变化: 新上架 **${d.counts.newListing}** · 下架/消失 **${d.counts.removed}** · 涨价 **${d.counts.priceUp}** · 降价 **${d.counts.priceDown}** · 状态变化 **${d.counts.statusChanged}** · 未变 ${d.counts.unchanged}`);
  if (d.warnings.length) {
    lines.push('');
    for (const w of d.warnings) lines.push(`> ⚠️ ${w}`);
  }
  const max = 20; // markdown 摘要固定上限
  lines.push('');
  lines.push(...sectionLines('新上架', d.newListings, max, it => `- ${it.server} · ${fmtPrice(it.price)} · 五星 ${it.stars != null ? it.stars : '?'} · ${it.status || '状态未知'} · ${it.url || ''}`));
  lines.push('');
  lines.push(...sectionLines('下架/消失', d.removed, max, it => `- ${it.server} · ${fmtPrice(it.price)} · 五星 ${it.stars != null ? it.stars : '?'} · ${it.status || '状态未知'} · ${it.reason}`));
  lines.push('');
  lines.push(...sectionLines('降价', d.priceDown, max, it => `- ${it.server} · ${fmtPrice(it.prevPrice)} → **${fmtPrice(it.curPrice)}** (${it.delta} / ${it.deltaPct}%) · ${it.url || ''}`));
  lines.push('');
  lines.push(...sectionLines('涨价', d.priceUp, max, it => `- ${it.server} · ${fmtPrice(it.prevPrice)} → **${fmtPrice(it.curPrice)}** (+${it.delta} / +${it.deltaPct}%) · ${it.url || ''}`));
  lines.push('');
  lines.push(...sectionLines('状态变化', d.statusChanged, max, it => `- ${it.server} · ${fmtPrice(it.price)} · ${statusText(it.prevStatus, it.prevStatusKind)} → ${statusText(it.curStatus, it.curStatusKind)} · ${it.url || ''}`));
  return lines.join('\n') + '\n';
}
function statusText(raw, kind) {
  return raw ? `“${raw}”(${kind})` : `无状态(${kind})`;
}
function printSummary(d, max) {
  console.log(`快照差异: ${d.prev.file} → ${d.cur.file}`);
  console.log(`  账号数: ${d.counts.prev} → ${d.counts.cur}`);
  console.log(`  新上架 ${d.counts.newListing} | 下架/消失 ${d.counts.removed} | 涨价 ${d.counts.priceUp} | 降价 ${d.counts.priceDown} | 状态变化 ${d.counts.statusChanged} | 未变 ${d.counts.unchanged}`);
  const cap = max > 0 ? max : Infinity;
  const brief = (title, items, render) => {
    if (!items.length) return;
    console.log(`\n[${title}] ${items.length}`);
    for (const it of items.slice(0, cap)) console.log('  ' + render(it));
    if (items.length > cap) console.log(`  …另有 ${items.length - cap} 条`);
  };
  brief('新上架', d.newListings, it => `${it.server} ${fmtPrice(it.price)} 五星${it.stars != null ? it.stars : '?'} ${it.status || '状态未知'}`);
  brief('下架/消失', d.removed, it => `${it.server} ${fmtPrice(it.price)} ${it.reason}`);
  brief('降价', d.priceDown, it => `${it.server} ${fmtPrice(it.prevPrice)} → ${fmtPrice(it.curPrice)} (${it.deltaPct}%)`);
  brief('涨价', d.priceUp, it => `${it.server} ${fmtPrice(it.prevPrice)} → ${fmtPrice(it.curPrice)} (+${it.deltaPct}%)`);
  brief('状态变化', d.statusChanged, it => `${it.server} ${statusText(it.prevStatus, it.prevStatusKind)} → ${statusText(it.curStatus, it.curStatusKind)}`);
  if (d.warnings.length) {
    console.log('\n告警:');
    for (const w of d.warnings) console.log('  ⚠️ ' + w);
  }
}

// ---------------- 主流程 ----------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  if (!opts.prev || !opts.cur) throw new Error('缺少 --prev 或 --cur（--help 查看用法）');

  cfg.loadConfig(); // 状态分类读同一份配置（fail-closed）
  const prevAbs = path.resolve(ROOT, opts.prev);
  const curAbs = path.resolve(ROOT, opts.cur);
  for (const f of [prevAbs, curAbs]) if (!fs.existsSync(f)) throw new Error(`找不到快照文件: ${f}`);
  const prevList = readJson(prevAbs);
  const curList = readJson(curAbs);
  if (!Array.isArray(prevList)) throw new Error(`快照不是数组: ${prevAbs}`);
  if (!Array.isArray(curList)) throw new Error(`快照不是数组: ${curAbs}`);

  const diff = diffAccounts(prevList, curList, path.relative(ROOT, prevAbs), path.relative(ROOT, curAbs));
  let saved = { json: null, md: null };
  const now = new Date();
  const defBase = path.join(DEFAULT_OUT_DIR, `diff-${stamp(now)}`);
  if (opts.json !== null) {
    const out = path.resolve(ROOT, opts.json || `${defBase}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(diff, null, 2) + '\n', 'utf8');
    saved.json = path.relative(ROOT, out);
  }
  if (opts.md !== null) {
    const out = path.resolve(ROOT, opts.md || `${defBase}.md`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderMarkdown(diff), 'utf8');
    saved.md = path.relative(ROOT, out);
  }
  if (!opts.quiet) {
    printSummary(diff, opts.max);
    if (saved.json) console.log(`\nJSON 已保存: ${saved.json}`);
    if (saved.md) console.log(`Markdown 已保存: ${saved.md}`);
  }
  if (!opts.quiet && !saved.json && !saved.md) {
    console.log('\n提示: 加 --json/--md 可保存差异文件（默认 data/tmp/snapshot-diff/）');
  }
  return diff;
}

try {
  main();
} catch (e) {
  console.error(`[snapshot-diff] 失败: ${e && e.message ? e.message : e}`);
  if (process.env.DIFF_DEBUG && e && e.stack) console.error(e.stack);
  process.exitCode = 1;
}
