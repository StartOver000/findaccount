// ============================================================
// recommend.js — 一键生成最终购买建议(自动, 减少手动分析)
// 流程:
//   1. 读 accounts-final.json，进程内用 plan5-core.landStatusList 算完整/只缺宝/缺战法
//      （不再 execSync 子进程；land-stats.js 仍保留给其它消费方/文档引用）
//   2. 过滤 l0_data.excludeFromRecommend 状态（默认 sold/delisted），按 ordersn 去重
//   3. 综合排序: 完整队数优先 → 只缺宝 → 可组 → 评分 → 价格
//   4. 生成 docs/最终购买建议-{日期}.md
// 用法:
//   node scripts/recommend.js [dataFile] [priceMin] [priceMax] [--out <file>]
//   例: node scripts/recommend.js data/accounts-final.json 1500 2000
//   前置: 先跑 find-all.ps1 或已有 accounts-final.json
// ============================================================
const fs = require('fs');
const path = require('path');
const core = require('./plan5-core.js');
const cfg = require('./lib-config.js');
const runmeta = require('./lib-runmeta.js');
const ROOT = path.resolve(__dirname, '..');

// ---- 参数解析: 位置参数 [dataFile] [priceMin] [priceMax]，另支持 --out <file> ----
const positional = [];
let OUT_ARG = '';
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--out') { OUT_ARG = process.argv[++i] || ''; continue; }
  if (a.startsWith('--out=')) { OUT_ARG = a.slice('--out='.length); continue; }
  if (a === '--help' || a === '-h') {
    console.log('usage: node scripts/recommend.js [dataFile] [priceMin] [priceMax] [--out <file>]');
    process.exit(0);
  }
  if (a.startsWith('-')) { console.error(`[recommend] 未知参数: ${a}`); process.exit(1); }
  positional.push(a);
}
const DATA_FILE = positional[0] || path.join(ROOT, 'data', 'accounts-final.json');
const PRICE_MIN = parseInt(positional[1] || '1500', 10);
const PRICE_MAX = parseInt(positional[2] || '2000', 10);

const L0 = cfg.getL0();
const EXCLUDE = new Set(Array.isArray(L0.excludeFromRecommend) ? L0.excludeFromRecommend : []);
const run = runmeta.beginRun('recommend', { data: DATA_FILE, priceMin: PRICE_MIN, priceMax: PRICE_MAX, out: OUT_ARG || null, exclude: [...EXCLUDE] });
cfg.logEffective('[recommend]');

const teams = core.initTeams();

// --- 账号唯一身份: ordersn 优先，旧数据回退 server-price ---
function ordersnOf(acc) {
  if (acc.list && acc.list.ordersn) return String(acc.list.ordersn);
  const tail = String((acc.overview && acc.overview.url) || '').split('?')[0].replace(/\/+$/, '').split('/').pop();
  return /^\d{8,}-/.test(tail) ? tail : '';
}
function orderKey(acc) {
  const sn = ordersnOf(acc);
  if (sn) return 'sn:' + sn;
  return `sp:${acc.list && acc.list.server}-${acc.overview && acc.overview.price}`;
}
// 状态归一化: 优先已有 statusKind，否则现场分类
function statusKindOf(acc) {
  if (acc.statusKind) return acc.statusKind;
  const ov = acc.overview || {};
  return cfg.classifyStatus(ov.status);
}

// ---- 1. 读数据 + 读 analyze 分数 ----
let data = [];
try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
catch (e) { console.error('[recommend] 读取数据失败:', e.message); runmeta.failRun(run, e); process.exit(1); }
if (!Array.isArray(data)) { console.error('[recommend] 数据格式错误: 期望数组'); runmeta.failRun(run, new Error('data is not array')); process.exit(1); }

const scores = {};
try {
  const txt = fs.readFileSync(path.join(ROOT, 'data', 'tmp', 'analyze-latest.txt'), 'utf-8');
  const re = /(X\d{4}) ￥([\d,]+)\s+[\d,]+\s+(\d+)\s/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    scores[`${m[1]}-${m[2].replace(/,/g, '')}`] = +m[3];
  }
} catch (e) { /* 分数文件缺失时 score=0，不阻断（旧行为） */ }

// ---- 2. 逐账号算落地 + 过滤 ----
const rows = [];
const seen = new Set();
let dupCount = 0;
let excludedCount = 0;
let noOverview = 0;
const sourceCounts = {};
const statusCounts = {};
for (const acc of data) {
  if (!acc.overview || !acc.list) { noOverview++; continue; }
  const k = orderKey(acc);
  if (seen.has(k)) { dupCount++; continue; }
  seen.add(k);
  const price = parseInt(String(acc.overview.price).replace(/,/g, ''), 10);
  if (!Number.isFinite(price) || price < PRICE_MIN || price > PRICE_MAX) continue;
  const statusKind = statusKindOf(acc);
  statusCounts[statusKind] = (statusCounts[statusKind] || 0) + 1;
  if (EXCLUDE.has(statusKind)) { excludedCount++; continue; }
  const source = acc.source || 'unknown';
  sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  const { full, onlyGear, missTac } = core.landStatusList(acc, teams);
  const server = acc.list.server;
  const priceNoComma = String(price);
  rows.push({
    server, price, url: String(acc.overview.url || '').replace(/\?.*$/, ''),
    ordersn: ordersnOf(acc), statusKind,
    full: full.length, onlyGear: onlyGear.length,
    candCount: full.length + onlyGear.length + missTac.length,
    score: scores[`${server}-${priceNoComma}`] || 0,
    fullTeams: full.map(x => `${x.team}(${x.tier})`).join('、'),
    onlyGearTeams: onlyGear.map(x => `${x.team}(${x.tier})缺${x.eMiss}`).join('、'),
    heroCount: acc.heroCount || (acc.heroes || []).length,
    tacCount: (acc.tactics || []).length,
    gearCount: (acc.equips || []).length,
    acc
  });
}
rows.sort((a, b) =>
  (b.full * 1000 + b.onlyGear * 100 + b.candCount) - (a.full * 1000 + a.onlyGear * 100 + a.candCount)
);

// 数据快照时间(取所有账号 capturedAt 最大/最小值)
const caps = data.map(a => a && a.capturedAt).filter(s => s && !isNaN(Date.parse(s))).sort();
const snapLine = caps.length
  ? `> 数据快照: ${caps[0].slice(0, 10)} ~ ${caps[caps.length - 1].slice(0, 10)} | 来源分布: ${Object.entries(sourceCounts).map(([k, v]) => `${k} ${v}`).join(' / ') || '-'} | 状态分布: ${Object.entries(statusCounts).map(([k, v]) => `${k} ${v}`).join(' / ') || '-'}`
  : '> 数据快照: 旧数据无 capturedAt 字段 | 来源分布: unknown';

// ---- 3. 生成 Markdown ----
const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const sb = [];
sb.push(`# 最终购买建议 - ${date}(自动生成)`);
sb.push('');
sb.push(`> 基于 **${rows.length} 个账号**(${PRICE_MIN}-${PRICE_MAX} 档)自动评估`);
sb.push(`> 已排除 **${excludedCount} 个**非可购状态账号(l0_data.excludeFromRecommend=${[...EXCLUDE].join(',') || '空'})${dupCount ? `，合并重复 ordersn ${dupCount} 条` : ''}`);
sb.push(snapLine);
sb.push(`> config 指纹: ${cfg.configFingerprint()} | 排序: 完整队数 → 只缺宝队数 → 可组总数 → 武将分`);
sb.push('> 版本硬校验: 曹操=魏 / 关羽=蜀 / 赵云=SP / 汉荀彧=汉 等');
if (rows.length === 0) sb.push('> ⚠️ 无满足条件的账号：请检查数据/价格档/状态过滤。');
sb.push('');
sb.push('---');
sb.push('');
sb.push('## 🎯 Top 10 推荐(到手强度)');
sb.push('');
sb.push('| # | 账号 | 价格 | 完整队 | 只缺宝 | 可组 | 武将分 | 完整队列表 |');
sb.push('|---|------|------|--------|--------|------|--------|-----------|');
rows.slice(0, 10).forEach((r, i) => {
  sb.push(`| ${i + 1} | ${r.server} | ¥${r.price} | **${r.full}** | ${r.onlyGear} | ${r.candCount} | ${r.score} | ${r.fullTeams || '-'} |`);
});
sb.push('');
sb.push('---');
sb.push('');
sb.push('## 详细落地(Top 20)');
sb.push('');
for (const r of rows.slice(0, 20)) {
  sb.push(`### ${r.server} ¥${r.price}(完整${r.full} 只缺宝${r.onlyGear} 可组${r.candCount} 分${r.score})`);
  sb.push('');
  sb.push(`- 🔗 ${r.url}`);
  sb.push(`- 武将 ${r.heroCount} / 战法 ${r.tacCount} / 宝 ${r.gearCount} | ordersn ${r.ordersn || '-'} | 状态 ${r.statusKind}`);
  if (r.fullTeams) sb.push(`- ✅ 完整队: ${r.fullTeams}`);
  if (r.onlyGearTeams) sb.push(`- 🟡 只缺宝: ${r.onlyGearTeams}`);
  // ---- 5 队规划表(每队标注缺口) ----
  const acc = r.acc;
  if (acc) {
    const plan = core.planAccount(acc, teams);
    if (plan && plan.res && plan.res.best && plan.res.best.length) {
      sb.push('');
      sb.push('**5 队规划**(最优组合, 武将不重复):');
      sb.push('');
      sb.push('| # | 队伍(档位) | 武将 | 落地 | 缺战法 | 缺宝物 |');
      sb.push('|---|-----------|------|------|--------|--------|');
      plan.res.best.forEach((b, i) => {
        const land = (b.TMiss === '' && b.EMiss === '') ? '✅完整'
          : (b.TMiss === '') ? '🟡只缺宝'
          : (b.EMiss === '') ? '🔴缺战法'
          : '🔴缺战法+宝';
        const tMiss = b.TMiss ? b.TMiss.replace(/\//g, '、') : '—';
        const eMiss = b.EMiss ? b.EMiss.replace(/\//g, '、') : (b.TMiss === '' ? '齐' : '—');
        sb.push(`| ${i + 1} | ${b.Team}(${b.Tier}) | ${b.Heroes.join('、')} | ${land} | ${tMiss} | ${eMiss} |`);
      });
    }
  }
  sb.push('');
}
sb.push('---');
sb.push('');
sb.push('> 下单前建议对 Top 3 候选浏览器复核(确认版本武将)');
const OUT = OUT_ARG ? path.resolve(OUT_ARG) : path.join(ROOT, 'docs', `最终购买建议-${date}-自动.md`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, sb.join('\n'), 'utf-8');
const counts = {
  accounts: data.length, rows: rows.length, excludedByStatus: excludedCount,
  dupOrdersn: dupCount, noOverview,
  sources: sourceCounts, statusKinds: statusCounts
};
runmeta.finishRun(run, counts);
console.log('已生成:', OUT);
console.log(`基于 ${rows.length} 个账号(排除 ${excludedCount} 个非可购状态${dupCount ? `，重复 ordersn ${dupCount}` : ''})`);
console.log('Top 3:', rows.slice(0, 3).map(r => `${r.server} ¥${r.price}(完整${r.full} 只缺宝${r.onlyGear})`).join(' | ') || '-');
