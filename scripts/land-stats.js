// ============================================================
// land-stats.js — 输出每个号的完整/只缺宝/缺战法队伍清单(JSON)
// 用法: node scripts/land-stats.js [dataFile] [server] [price] [outFile]
//   例: node scripts/land-stats.js data/accounts-final.json X5798 1,900
//   不带 server/price 则输出所有号汇总
// 输出: 每个账号的 完整队/只缺宝队/缺战法队 列表
// 去重口径: 按 ordersn（overview.url 末段或 list.ordersn）；仅当旧数据缺 ordersn 时回退 server-price
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const RANK_FILE = path.join(ROOT, 'docs', '队伍强度排行榜.md');
const DATA_FILE = process.argv[2] || path.join(ROOT, 'data', 'accounts-final.json');
const FILTER_SERVER = process.argv[3] || '';
const FILTER_PRICE = process.argv[4] || '';
const core = require('./plan5-core.js');
const { initTeams, landStatusList } = core;

// 账号唯一身份：ordersn 优先（URL 末段或 list.ordersn），旧数据回退 server-price
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

function main() {
  const teams = initTeams();
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  // 输出文件(避免 PowerShell 管道 GBK 乱码)
  const OUT_FILE = process.argv[5] || path.join(ROOT, 'data', 'tmp', 'land-stats.json');
  const seen = new Set();
  const results = [];
  for (const acc of data) {
    if (!acc.overview) continue;
    const k = orderKey(acc);
    if (seen.has(k)) continue;
    seen.add(k);
    if (FILTER_SERVER && acc.list.server !== FILTER_SERVER) continue;
    if (FILTER_PRICE && acc.overview.price !== FILTER_PRICE) continue;
    const { full, onlyGear, missTac } = landStatusList(acc, teams);
    results.push({
      server: acc.list.server,
      price: acc.overview.price,
      ordersn: ordersnOf(acc),
      url: String(acc.overview.url).replace(/\?.*$/, ''),
      full,
      onlyGear,
      missTacCount: missTac.length
    });
  }
  // 写 JSON 文件(UTF-8 无 BOM)
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 1), 'utf-8');
  console.log('saved:', OUT_FILE, '(', results.length, 'accounts )');
}
main();
