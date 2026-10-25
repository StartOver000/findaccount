// ============================================================
// page-list-collect.js — 列表页 DOM 直采(终极版, 绕开API限流)
// 原理:
//   藏宝阁列表页(已登录+筛选)的 DOM 里, 每个账号卡片直接包含:
//     - 价格/服务器/五星数/S战法数/宝物数/限定武将/锻造宝物/外观
//     - 核心武将列表(约7-10个, 带完整版本标记: 魏极XP 曹彰 / 蜀SP 赵云)
//   已验证: 列表页显示的核心武将版本 与 完整详情 完全一致(曹彰魏极XP/曹操魏极3N/赵云蜀SP)
//   页面正常浏览不受 API 限流影响 → 绕开"系统繁忙"问题
// 用法:
//   node scripts/page-list-collect.js [OUT.json]
//   前置: .cbg-profile 已登录且列表页筛选已就绪(或用参数URL)
// 阈值来源: data/strategy-config.json（经 lib-config.js），不在 URL 里写死价格档/85/12
// 去重口径: ordersn 优先（卡片链接含 equip/1/<ordersn>），旧/缺链接时才回退 server-price
// ============================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const cfg = require('./lib-config.js');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.cbg-profile');
const OUT = process.argv[2] || path.join(ROOT, 'data', 'accounts-list-dom.json');

// 试师区服: 统一从 scripts/lib-shishi.js 读取（data/shishi-open.json，update-shishi.js 生成）
const { getServerIds } = require('./lib-shishi');
const SERVERIDS = getServerIds().ids;
const L1 = cfg.getL1();
const POOL_PRICE = L1.priceRange;
const FIVE_STAR_MIN = L1.bargainLine.fiveStarMin;
const FORGED_GEAR_MIN = L1.bargainLine.forgedGearMin;
const LIST_URL = `https://stzb.cbg.163.com/cgi/mweb/pl?search_type=role&tfid=f_kingkong&baijia_hero_logic=and&dynamic_icon_hero_id_logic=and&game_compete_serverid=${SERVERIDS}&price_min=${POOL_PRICE[0] * 100}&price_max=${POOL_PRICE[1] * 100}&five_star_hero_count=${FIVE_STAR_MIN}&duanzao_gear_cnt=${FORGED_GEAR_MIN}`;
cfg.logEffective('[page-list]');
console.log(`[page-list] 价格档 ¥${POOL_PRICE[0]}-${POOL_PRICE[1]} | 五星≥${FIVE_STAR_MIN} | 锻造≥${FORGED_GEAR_MIN} | config ${cfg.configFingerprint()}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 从卡片 DOM 提取数据(页面内执行)
function extractCards() {
  const cards = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent || '';
    if (t.includes('张五星武将卡')) nodes.push(walker.currentNode);
  }
  const camps = '魏蜀吴群汉晋';
  for (const n of nodes) {
    let card = n;
    for (let i = 0; i < 6; i++) { card = card.parentElement; if (!card) break; }
    if (!card) continue;
    const raw = card.textContent.replace(/\s+/g, ' ').trim();
    const price = (raw.match(/¥([\d,]+)/) || [])[1];
    const server = (raw.match(/征服赛季(X\d{4})/) || [])[1];
    const star5 = (raw.match(/(\d+)张五星武将卡/) || [])[1];
    const sTac = (raw.match(/(\d+)个S级战法/) || [])[1];
    const gear = (raw.match(/(\d+)个稀世宝物/) || [])[1];
    const limited = (raw.match(/(\d+)个限定武将/) || [])[1];
    const forged = (raw.match(/(\d+)个已锻造宝物/) || [])[1];
    const skin = (raw.match(/(\d+)个武将外观/) || [])[1];
    // 核心武将(正则: 阵营+极/SP/XP/S2/S3/N + 武将名)
    const heroes = [];
    const heroPattern = new RegExp('(魏|蜀|吴|群|汉|晋)(极)?(SP|XP|S2|S3|N)?\\s*([\\u4e00-\\u9fa5·＆]{2,5})', 'g');
    let m;
    while ((m = heroPattern.exec(raw)) !== null) {
      const mk = (m[2] || '') + (m[3] || '');
      heroes.push({ name: m[4], marks: [m[1] + mk] });
    }
    // 卡片链接(ordersn)
    const link = card.querySelector('a[href*="equip/"]');
    let ordersn = '';
    if (link) { const h = link.href; const mm = h.match(/equip\/1\/([A-Z0-9]+)/); if (mm) ordersn = mm[1]; }
    // 去重(同一张卡可能被多次找到): ordersn 优先，缺链接时回退 server-price
    const key = ordersn ? 'sn:' + ordersn : server + '-' + price;
    if (cards.some(c => c.key === key)) continue;
    cards.push({ key, server, price, star5, sTac, gear, limited, forged, skin, ordersn, heroes, sumup: `${star5}张五星武将卡 ${sTac}个S级战法 ${gear}个稀世宝物` });
  }
  return cards;
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, { headless: false });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(5000);

  // 滚动加载全部(连续 PageDown 直到不再增长)
  const all = new Map();
  let stable = 0;
  for (let i = 0; i < 80 && stable < 4; i++) {
    const cards = await page.evaluate(extractCards);
    let added = 0;
    for (const c of cards) { if (!all.has(c.key)) { all.set(c.key, c); added++; } }
    if (added === 0) stable++; else stable = 0;
    await page.keyboard.press('PageDown');
    await sleep(400);
  }
  const results = [...all.values()];
  console.log('采集到:', results.length, '个账号');

  // 保存(精简格式，含数据溯源字段)
  const capturedAt = new Date().toISOString();
  const out = results.map(r => ({
    list: { server: r.server, price: r.price ? parseInt(r.price.replace(/,/g, ''), 10) : 0, ordersn: r.ordersn, sumup: r.sumup },
    overview: { url: r.ordersn ? `https://stzb.cbg.163.com/cgi/mweb/equip/1/${r.ordersn}` : '', server: r.server, price: r.price },
    heroCount: r.heroes.length,
    heroes: r.heroes,
    listMeta: { star5: r.star5, sTac: r.sTac, gear: r.gear, limited: r.limited, forged: r.forged, skin: r.skin },
    source: 'browser',
    capturedAt,
    statusKind: cfg.classifyStatus('')
  }));
  const noOrdersn = results.filter(r => !r.ordersn).length;
  if (noOrdersn) console.warn(`[page-list] 警告: ${noOrdersn} 个卡片未提取到 ordersn，将无法按 ordersn 去重/续采`);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf-8');
  console.log('已保存:', OUT, '| ordersn 覆盖', results.length - noOrdersn, '/', results.length);
  await context.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
