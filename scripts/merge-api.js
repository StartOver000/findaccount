// ============================================================
// merge-api.js — 合并浏览器采集 + API 采集, 生成最终 accounts-final.json
// 浏览器数据(marks 可靠, 详情页 DOM 读的阵营/版本)为主
// API 数据(ordersn 唯一, 全)补充浏览器漏采的号(同server同价不同号)
// 补充号 marks 用: name→阵营 多数投票表(浏览器全量) + hero_id 特判表(版本武将)
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BROWSER_FILE = path.join(ROOT, 'data', 'accounts-detail-1500-2500.json');
const API_FILE = path.join(ROOT, 'data', 'accounts-api.json');
const OUT = path.join(ROOT, 'data', 'accounts-final.json');

// 版本武将 hero_id → 阵营(浏览器交叉 + 游戏常识确认)
const HERO_SPECIAL = {
  100065: '蜀', 100451: '蜀', 100026: '魏',        // 关羽: 蜀/蜀/魏
  100042: '魏', 100023: '魏', 100804: '汉',        // 曹操: 魏/魏/汉
  102001: 'SP',                                     // SP赵云(season=SP 也标注)
  100021: '蜀', 100131: '蜀',                        // 普通赵云
  100024: '魏', 100794: '汉',                        // 荀彧: 魏/汉(XP)
  100009: '群', 100480: '汉',                        // 董卓: 群/汉(S2)
  100033: '吴', 100043: '汉', 100805: '汉',         // 孙坚: 吴/汉/汉
  100016: '蜀', 100803: '汉',                        // 刘备: 蜀/汉
  100003: '汉',                                      // 吕布: 汉
  100074: '蜀', 100806: 'XP', 102012: 'SP',         // 姜维: 蜀/XP/SP
  100472: '魏'                                       // 司马懿: 魏
};

// 4星/噪声武将黑名单(API card 含4星, 浏览器采集只取5星; 4星混入会导致铁王八等队伍误判)
const BLACK4 = ['侍卫', '麦子', '陶渊明', '朱士行', '张恭', '九色鹿', '长风破浪', '新春侍女', '率土十载', '不负时代', '百家纵横', '彻里吉', '张宝', '张梁', '管亥', '潘凤', '纪灵', '波才', '孙乾', '糜竺', '简雍', '蒋干', '张松', '刘璋', '黄祖', '王匡', '韩馥', '孔融', '张邈', '刘岱', '乔瑁', '袁遗', '公孙瓒_4', '田楷', '刘虞', '公孙度', '张英', '严畯', '阚泽', '薛综', '是仪', '骆统', '全琮', '吕范', '朱治', '孙静', '程普_4', '黄盖_4', '韩当', '祖茂', '蒋钦', '周泰_4', '陈武', '董袭', '徐盛_4', '潘璋', '凌统_4', '丁奉_4'];

function campOf(h, nameCamp) {
  const sp = HERO_SPECIAL[h.hero_id];
  if (sp) return sp;
  return nameCamp[h.name] || '';
}

function main() {
  const browser = JSON.parse(fs.readFileSync(BROWSER_FILE, 'utf-8'));
  const api = JSON.parse(fs.readFileSync(API_FILE, 'utf-8'));

  // 5星武将白名单: 浏览器采集(详情页5星筛选, 可靠)的武将名 + 榜单队伍所需武将名
  const star5 = new Set();
  for (const b of browser) for (const h of b.heroes || []) star5.add(h.name);
  const rankText = fs.readFileSync(path.join(ROOT, 'docs', '队伍强度排行榜.md'), 'utf-8');
  for (const m of rankText.matchAll(/^\|\s*([^|]+?)\s*\|/gm)) {
    const n = m[1].trim();
    if (n && n !== '武将' && n !== '---' && !/^\d+$/.test(n)) star5.add(n);
  }

  // name → 阵营 多数投票(浏览器全量, 唯一映射才用)
  const vote = {};
  for (const b of browser) {
    for (const h of b.heroes || []) {
      const mk = Array.isArray(h.marks) ? h.marks.join('/') : String(h.marks || '');
      const camp = mk.match(/^(魏|蜀|吴|群|汉|SP)/);
      if (!camp) continue;
      if (!vote[h.name]) vote[h.name] = {};
      vote[h.name][camp[1]] = (vote[h.name][camp[1]] || 0) + 1;
    }
  }
  const nameCamp = {};
  for (const n of Object.keys(vote)) {
    const camps = Object.entries(vote[n]).sort((a, b) => b[1] - a[1]);
    nameCamp[n] = camps[0][0]; // 多数阵营
  }

  // 浏览器 ordersn 集合
  const browserSns = new Set(browser.map(b => {
    const u = b.overview && b.overview.url ? b.overview.url : '';
    return u.split('/').pop().split('?')[0];
  }).filter(x => x && x.length > 10));

  // API 补: 浏览器没有的 ordersn
  const added = [];
  for (const a of api) {
    if (browserSns.has(a.list.ordersn)) continue;
    // 只保留5星武将(4星/噪声会致铁王八等队伍误判), 用 star5 白名单过滤
    const heroes = (a.heroes || []).filter(h => star5.has(h.name)).map(h => ({
      name: h.name,
      marks: [campOf(h, nameCamp) + (h.awake ? '极' : '') + (h.season === 'SP' ? 'SP' : (h.season || 'N'))]
    }));
    // price: list.price 用无逗号整数(与浏览器采集一致), overview.price 用带逗号显示格式
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

  // 合并并按 ordersn(overview.url 商品ID)去重, 浏览器数据优先(在前面)
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
  console.log('浏览器:', browser.length, '条 | API补充:', added.length, '条 | 去重后:', merged.length, '条');
  console.log('已保存:', OUT);
}

main();
