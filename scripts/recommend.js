// ============================================================
// recommend.js — 一键生成最终购买建议(自动, 减少手动分析)
// 流程:
//   1. 读 accounts-final.json + 跑 land-stats(完整/只缺宝/缺战法)
//   2. 综合排序: 完整队数优先 → 只缺宝 → 可组 → 评分 → 价格
//   3. 生成 docs/最终购买建议-{日期}.md
// 用法:
//   node scripts/recommend.js [dataFile] [priceMin] [priceMax]
//   例: node scripts/recommend.js data/accounts-final.json 1500 2000
// 前置: 先跑 find-all.ps1 或已有 accounts-final.json
// ============================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = process.argv[2] || path.join(ROOT, 'data', 'accounts-final.json');
const PRICE_MIN = parseInt(process.argv[3] || '1500', 10);
const PRICE_MAX = parseInt(process.argv[4] || '2000', 10);

// ---- 1. 跑 land-stats 输出 JSON ----
const STATS_FILE = path.join(ROOT, 'data', 'tmp', 'land-stats.json');
try {
  execSync(`node scripts/land-stats.js "${DATA_FILE}" "" "" "${STATS_FILE}"`, { cwd: ROOT, shell: 'cmd', stdio: 'pipe' });
} catch (e) { console.error('land-stats 失败:', e.message); process.exit(1); }
const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));

// ---- 2. 读 final + 分数 ----
const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
const byKey = {};
for (const acc of data) {
  if (!acc.overview) continue;
  const k = `${acc.list.server}-${acc.overview.price}`;
  if (!byKey[k]) byKey[k] = acc;
}
// 读 analyze 分数
const analyzeFile = path.join(ROOT, 'data', 'tmp', 'analyze-latest.txt');
const scores = {};
try {
  const txt = fs.readFileSync(analyzeFile, 'utf-8');
  const re = /(X\d{4}) ￥([\d,]+)\s+[\d,]+\s+(\d+)\s/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    scores[`${m[1]}-${m[2].replace(/,/g, '')}`] = +m[3];
  }
} catch (e) {}

// ---- 3. 综合排序 ----
const rows = [];
for (const s of stats) {
  const price = parseInt(s.price.replace(/,/g, ''), 10);
  if (price < PRICE_MIN || price > PRICE_MAX) continue;
  const acc = byKey[`${s.server}-${s.price}`];
  rows.push({
    server: s.server, price, url: s.url,
    full: s.full.length, onlyGear: s.onlyGear.length,
    candCount: s.full.length + s.onlyGear.length + s.missTacCount,
    score: scores[`${s.server}-${String(price)}`] || 0,
    fullTeams: s.full.map(x => `${x.team}(${x.tier})`).join('、'),
    onlyGearTeams: s.onlyGear.map(x => `${x.team}(${x.tier})缺${x.eMiss}`).join('、'),
    heroCount: acc ? acc.heroCount : 0,
    tacCount: acc ? (acc.tactics || []).length : 0,
    gearCount: acc ? (acc.equips || []).length : 0
  });
}
rows.sort((a, b) =>
  (b.full * 1000 + b.onlyGear * 100 + b.candCount) - (a.full * 1000 + a.onlyGear * 100 + a.candCount)
);

// ---- 4. 生成 Markdown ----
const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const sb = [];
sb.push(`# 最终购买建议 - ${date}(自动生成)`);
sb.push('');
sb.push(`> 基于 **${stats.length} 个账号**(${PRICE_MIN}-${PRICE_MAX} 档)自动评估`);
sb.push('> 排序: 完整队数 → 只缺宝队数 → 可组总数 → 武将分');
sb.push('> 版本硬校验: 曹操=魏 / 关羽=蜀 / 赵云=SP / 汉荀彧=汉 等');
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
  sb.push(`- 武将 ${r.heroCount} / 战法 ${r.tacCount} / 宝 ${r.gearCount}`);
  if (r.fullTeams) sb.push(`- ✅ 完整队: ${r.fullTeams}`);
  if (r.onlyGearTeams) sb.push(`- 🟡 只缺宝: ${r.onlyGearTeams}`);
  sb.push('');
}
sb.push('---');
sb.push('');
sb.push('> 下单前建议对 Top 3 候选浏览器复核(确认版本武将)');
const OUT = path.join(ROOT, 'docs', `最终购买建议-${date}-自动.md`);
fs.writeFileSync(OUT, sb.join('\n'), 'utf-8');
console.log('已生成:', OUT);
console.log('Top 3:', rows.slice(0, 3).map(r => `${r.server} ¥${r.price}(完整${r.full} 只缺宝${r.onlyGear})`).join(' | '));
