// ============================================================
// land-stats.js — 输出每个号的完整/只缺宝/缺战法队伍清单(JSON)
// 用法: node scripts/land-stats.js [dataFile] [server] [price]
//   例: node scripts/land-stats.js data/accounts-final.json X5798 1,900
//   不带 server/price 则输出所有号汇总
// 输出: 每个账号的 完整队/只缺宝队/缺战法队 列表
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const RANK_FILE = path.join(ROOT, 'docs', '队伍强度排行榜.md');
const DATA_FILE = process.argv[2] || path.join(ROOT, 'data', 'accounts-final.json');
const FILTER_SERVER = process.argv[3] || '';
const FILTER_PRICE = process.argv[4] || '';

const TacticMap = {
  '合纵':['合纵连横'], '避锐':['避锐治气'], '百战':['百战无怯','百战精兵'], '愈战':['愈战愈勇'],
  '垒实':['垒实迎击'], '三术':['三术奇谋'], '桃园':['桃园结义'], '正始':['正始之变'],
  '一骑':['一骑当千'], '令无':['令无空悬'], '一夫':['一夫当关'], '浑水':['浑水摸鱼'],
  '神兵':['神兵天降'], '大赏':['大赏三军'], '众谋':['众谋不懈'], '先驱':['先驱突击'],
  '击势':['击势'], '乘胜':['乘胜追击'], '疾击':['疾击其后'], '飒沓':['飒沓如星'],
  '单骑':['单骑救主'], '长兵':['长兵方阵'], '文伐':['文伐'], '战必':['战必断金'],
  '反计':['反计之策','反计'], '火烧':['火烧连营'], '河内':['河内世泽'], '久战':['久战熟谋'],
  '当阳':['当阳桥'], '攻其':['攻其不备','攻其要害'], '三军':['三军齐出','大赏三军','三军之众'],
  '兵无':['兵无常势'], '步步':['步步为营'], '除恶':['除恶务尽'], '道行':['道行险阻'],
  '风声':['风声鹤唳'], '及锋':['及锋而试'], '计险':['计险远近'], '兼弱':['兼弱攻昧'],
  '健卒':['健卒不殆'], '绝水':['绝水遏敌'], '利兵':['利兵谋胜'], '谋定':['谋定后动'],
  '磐阵':['磐阵善守'], '奇正':['奇正之势'], '全军':['全军突击'], '深谋':['深谋远虑'],
  '胜兵':['胜兵求战'], '势无':['势无虚动'], '望风':['望风而降'], '威震':['威震逍遥'],
  '无心':['无心恋战'], '形兵':['形兵之极'], '悬权':['悬权而动'], '以诱':['以诱待来'],
  '诱敌':['诱敌深入','诱敌'], '知己':['知己知彼'], '甚陷':['甚陷不惧'],
  '风仪亭':['凤仪亭'], '追击':['乘胜追击'],
  '反击之策':['反击之策'], '反间':['反间'], '合众':['合众'], '疾战':['疾战'],
  '衡轭':['衡轭'], '始计':['始计'], '空城':['空城'], '妖术':['妖术'],
  '枭雄':['枭雄'], '闪击':['闪击'], '不攻':['不攻']
};
const VersionReq = {
  '汉苟彧':'汉', '汉孙坚':'汉', '汉董':'汉', '汉吕':'汉',
  'XP姜维':'XP', 'XP孙权':'XP', 'XP周瑜':'XP',
  '弓吕':'弓', '群貂':'群', '新黄盖':'新',
  '曹操':'魏', '关羽':'蜀', '赵云':'SP', '吕吕':'群', '孙权':'吴', '董卓':'群', '姜维':'蜀'
};
const NormalizeMap = { 'XP姜维':'姜维', '汉孙坚':'孙坚', 'XP孙权':'孙权', 'XP周瑜':'周瑜', '祝融':'祝融夫人',
  '新黄盖':'黄盖', '汉苟彧':'荀彧', '泪授':'沮授', '汉董':'董卓', '几突骨':'兀突骨',
  '木鹿':'木鹿大王', '群貂':'貂蝉', '吕吕':'吕布', '弓吕':'吕布', '汉吕':'吕布', '丹英':'貂蝉', 'SP赵云':'赵云' };
const normHero = n => NormalizeMap[String(n).trim()] || String(n).trim();
function tacticHit(short, accTac) {
  if (TacticMap[short]) { for (const f of TacticMap[short]) if (accTac[f]) return true; }
  else if (accTac[short]) return true;
  return false;
}
function initTeams() {
  const lines = fs.readFileSync(RANK_FILE, 'utf-8').split(/\r?\n/);
  const summary = {};
  for (const sl of lines) {
    const m = sl.match(/^\|\s*(T0\+|T0-|T0|T1|T2-)\s*\|\s*(.+?)\s*\|\s*$/);
    if (m) summary[m[1]] = m[2].split('、').map(x => x.trim()).filter(Boolean);
  }
  const teams = [];
  let tier = '', cur = null, heroes = [], t1list = [], t2list = [], eql = [], curTier = '';
  for (const line of lines) {
    const tm = line.match(/^##\s+(T0\+|T0-|T0|T1|T2-)\s*$/);
    if (tm) { tier = tm[1]; continue; }
    if (/^##\s+/.test(line)) { tier = ''; cur = null; heroes = []; t1list = []; t2list = []; eql = []; continue; }
    const hm = line.match(/^###\s+(.+)$/);
    if (hm) {
      let raw = hm[1].trim(); let pt = tier;
      if (raw.includes('已降级')) pt = 'T2-';
      raw = raw.split('：').pop().trim().replace(/^\d+[.、]\s*/, '').trim().replace(/（.+?）/g, '').trim();
      if (raw && ((!summary[pt]) || (summary[pt] && summary[pt].includes(raw)))) {
        cur = raw; curTier = pt; heroes = []; t1list = []; t2list = []; eql = [];
      }
      continue;
    }
    if (cur) {
      const fm = line.match(/^\|\s*([^|]+?)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/);
      if (fm) {
        const h = fm[1].trim();
        if (h === '武将' || h === '---') continue;
        t1list.push(fm[2].trim()); t2list.push(fm[3].trim()); eql.push(fm[4].trim());
        heroes.push(h);
        if (heroes.length === 3) {
          teams.push({ Tier: curTier, Team: cur, Heroes: [...heroes], T1: t1list.join('/'), T2: t2list.join('/'), Equip: eql.join('/') });
          heroes = []; t1list = []; t2list = []; eql = [];
        }
      }
    }
  }
  return teams;
}
function teamStatus(team, heroMarks, accTac, accEq) {
  for (const h of team.Heroes) {
    const nh = normHero(h);
    const marks = heroMarks[nh];
    if (!marks) return null;
    const req = VersionReq[h];
    if (req) { let ok = false; for (const mk of marks) if (mk.includes(req)) { ok = true; break; } if (!ok) return null; }
  }
  const needTs = [], needEs = [];
  for (const part of [team.T1, team.T2]) for (const x of part.split('/')) { const t = x.trim(); if (t) needTs.push(t); }
  for (const e of team.Equip.split('/')) { const t = e.trim(); if (t) needEs.push(t); }
  const tMiss = [...new Set(needTs)].filter(t => !tacticHit(t, accTac));
  const eMiss = [...new Set(needEs)].filter(e => !accEq[e]);
  return { team: team.Team, tier: team.Tier, tMiss, eMiss };
}

function main() {
  const teams = initTeams();
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const seen = new Set();
  for (const acc of data) {
    if (!acc.overview) continue;
    const k = `${acc.list.server}-${acc.overview.price}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (FILTER_SERVER && acc.list.server !== FILTER_SERVER) continue;
    if (FILTER_PRICE && acc.overview.price !== FILTER_PRICE) continue;
    const heroMarks = {};
    for (const h of acc.heroes || []) {
      const mk = Array.isArray(h.marks) ? h.marks : [String(h.marks || '')];
      (heroMarks[h.name] = heroMarks[h.name] || []).push(...mk);
    }
    const accTac = {}, accEq = {};
    for (const t of acc.tactics || []) accTac[t] = true;
    for (const e of acc.equips || []) accEq[e] = true;
    const full = [], onlyGear = [], missTac = [];
    for (const team of teams) {
      if (team.Heroes.includes('弓诸葛') || team.Heroes.includes('司马懿')) continue;
      const st = teamStatus(team, heroMarks, accTac, accEq);
      if (!st) continue;
      const o = { team: st.team, tier: st.tier, tMiss: st.tMiss.join('/'), eMiss: st.eMiss.join('/') };
      if (st.tMiss.length === 0 && st.eMiss.length === 0) full.push(o);
      else if (st.tMiss.length === 0) onlyGear.push(o);
      else missTac.push(o);
    }
    console.log(JSON.stringify({ server: acc.list.server, price: acc.overview.price, full, onlyGear, missTacCount: missTac.length }));
  }
}
main();
