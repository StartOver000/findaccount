// ============================================================
// merge-api.js — 合并数据生成 accounts-final.json(v2: 不再依赖浏览器数据)
// 主数据: API直采(data/accounts-api.json, ordersn唯一, 几分钟, 实时在售)
// 静态表: data/name-camp.json(武将→阵营, 唯一映射) + data/star5-names.json(5星白名单)
//          + 内置 hero_id 特判表(版本武将: 关羽蜀/魏, 曹操魏/汉, 赵云SP 等)
// 可选增强: 浏览器采集(当前批次 detail 主文件)存在时优先用其 marks(更准)并补充API漏的号
//           注意: 只读「最大的」accounts-detail-*.json(当前批次), 旧价格段历史文件是中间产物
//                 可能已下架, 不混入, 避免污染排名
// 用法: node scripts/merge-api.js
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const API_FILE = path.join(ROOT, 'data', 'accounts-api.json');
const OUT = path.join(ROOT, 'data', 'accounts-final.json');
const NAMECAMP_FILE = path.join(ROOT, 'data', 'name-camp.json');
const STAR5_FILE = path.join(ROOT, 'data', 'star5-names.json');

// 版本武将 hero_id → 阵营(浏览器交叉 + 游戏常识确认)
const HERO_SPECIAL = {
  100065: '蜀', 100451: '蜀', 100026: '魏',        // 关羽: 蜀/蜀/魏
  100042: '魏', 100023: '魏', 100804: '汉',        // 曹操: 魏/魏/汉
  102001: 'SP',                                     // SP赵云
  100021: '蜀', 100131: '蜀',                        // 普通赵云
  100024: '魏', 100794: '汉',                        // 荀彧: 魏/汉
  100009: '群', 100480: '汉',                        // 董卓: 群/汉(S2)
  100033: '吴', 100043: '汉', 100805: '汉',         // 孙坚: 吴/汉/汉
  100016: '蜀', 100803: '汉',                        // 刘备: 蜀/汉
  100003: '汉',                                      // 吕布: 汉
  100074: '蜀', 100806: 'XP', 102012: 'SP',         // 姜维: 蜀/XP/SP
  100472: '魏'                                       // 司马懿: 魏
};

function main() {
  const api = JSON.parse(fs.readFileSync(API_FILE, 'utf-8'));
  const nameCamp = JSON.parse(fs.readFileSync(NAMECAMP_FILE, 'utf-8'));
  const star5 = new Set(JSON.parse(fs.readFileSync(STAR5_FILE, 'utf-8')));

  // 可选: 浏览器采集(增强用, 缺失不影响) — 只读最大的 detail 文件(当前批次)
  let browser = [];
  const dataDir = path.join(ROOT, 'data');
  const detailFiles = fs.readdirSync(dataDir).filter(f => /^accounts-detail-.*\.json$/.test(f));
  if (detailFiles.length) {
    detailFiles.sort((a, b) => fs.statSync(path.join(dataDir, b)).size - fs.statSync(path.join(dataDir, a)).size);
    const mainFile = path.join(dataDir, detailFiles[0]);
    try { browser = JSON.parse(fs.readFileSync(mainFile, 'utf-8')); } catch (e) {}
    console.log('browser-enhance:', detailFiles[0], '(', browser.length, ')');
  }
  const browserSns = new Set(browser.map(b => {
    const u = b.overview && b.overview.url ? b.overview.url : '';
    return u.split('/').pop().split('?')[0];
  }).filter(x => x && x.length > 10));

  function campOf(h) {
    const sp = HERO_SPECIAL[h.hero_id];
    if (sp) return sp;
    return nameCamp[h.name] || '';
  }

  // API 生成(浏览器没有的号才生成; 浏览器有则优先用浏览器marks)
  const added = [];
  for (const a of api) {
    if (browserSns.has(a.list.ordersn)) continue;
    const heroes = (a.heroes || []).filter(h => star5.has(h.name)).map(h => ({
      name: h.name,
      marks: [campOf(h) + (h.awake ? '极' : '') + (h.season === 'SP' ? 'SP' : (h.season || 'N'))]
    }));
    const yuanInt = String(Math.round((a.list.price || 0) / 100));
    const yuan = yuanInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    added.push({
      list: { server: a.list.server, price: yuanInt, ordersn: a.list.ordersn, sumup: a.list.sumup },
      overview: { url: a.overview.url, server: a.list.server, price: yuan, fullRed: 0, status: '' },
      heroCount: heroes.length,
      heroes,
      tactics: a.tactics || [],
      equips: a.equips || []
    });
  }

  // 合并并按 ordersn 去重(浏览器数据在前, 优先)
  const seenSn = new Set();
  const merged = [];
  for (const r of browser.concat(added)) {
    const u = r.overview && r.overview.url ? r.overview.url : '';
    const sn = u.split('/').pop().split('?')[0];
    if (!sn || sn.length < 15) { merged.push(r); continue; }
    if (seenSn.has(sn)) continue;
    seenSn.add(sn);
    merged.push(r);
  }

  fs.writeFileSync(OUT, JSON.stringify(merged, null, 1), 'utf-8');
  console.log('API:', api.length, '| browser:', browser.length, '| api-added:', added.length, '| merged:', merged.length);
  console.log('saved:', OUT);
}

main();
