// ============================================================
// browser-verify.js — 推荐号浏览器复核(正确性兜底)
// 用途: 对最终推荐的少数号(3-5个), 用浏览器详情页复核,
//       确认 API 采集的关键武将/战法/宝物与页面一致
// 用法:
//   node scripts/browser-verify.js [ordersn1,ordersn2,...]
//   例: node scripts/browser-verify.js 202607021602116-1-WQK5DSIQWDIN7E,202608011102116-1-M40KY8EIRUP5YF
// 前置: .cbg-profile 已登录
// 输出: 每个号的 页面顶部信息 + 关键武将版本 与 API 数据对比
// ============================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.cbg-profile');
const SNS = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const FINAL_FILE = path.join(ROOT, 'data', 'accounts-final.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 提取详情页武将(兼容两种页面布局):
//   A) 赛季分组: "魏 极 XP 曹彰" 或 "群 N 褒姒" (阵营+极?+赛季 + 名字)
//   B) 部队阵容: "甘宁 极 3" (名字 + 极 + 星级数字)
// 两种都截到"相似推荐"前
async function extractHeroes(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let limit = lines.length;
    const simIdx = lines.indexOf('相似推荐');
    if (simIdx > 0) limit = simIdx;
    const camps = ['魏', '蜀', '吴', '群', '汉', '晋'];
    const marks = ['极', 'SP', 'XP', 'S2', 'S3', 'N'];
    const nameRe = /^[\u4e00-\u9fa5·＆]{2,5}$/;
    const out = [];
    for (let i = 0; i < limit - 1; i++) {
      // 模式A: 阵营在 名字前1-3行
      for (let back = 1; back <= 3; back++) {
        if (i - back < 0) continue;
        const camp = lines[i - back];
        if (!camps.includes(camp)) continue;
        // 名字在 i, 中间是 极/赛季
        if (!nameRe.test(lines[i])) continue;
        // 检查中间行都是 标记 或 空
        let valid = true;
        const mids = [];
        for (let j = i - back + 1; j < i; j++) {
          if (!marks.includes(lines[j])) { valid = false; break; }
          mids.push(lines[j]);
        }
        if (valid) {
          out.push({ name: lines[i], marks: [camp + mids.join('')] });
          break;
        }
      }
      // 模式B: 名字在前, 后跟"极/SP/XP"等(部队阵容)
      if (nameRe.test(lines[i]) && i + 1 < limit && marks.includes(lines[i + 1])) {
        // 避免把模式A的名字重复加(模式A已覆盖)
        if (!out.some(h => h.name === lines[i] && h.marks[0] === lines[i + 1])) {
          out.push({ name: lines[i], marks: [lines[i + 1]] });
        }
      }
    }
    // 去重(同名取第一个版本即可, 但保留不同版本)
    const seen = new Set(); const uniq = [];
    for (const h of out) { const k = h.name + '-' + h.marks[0]; if (!seen.has(k)) { seen.add(k); uniq.push(h); } }
    return uniq;
  });
}

async function main() {
  if (SNS.length === 0) { console.log('用法: node scripts/browser-verify.js <ordersn1,ordersn2,...>'); process.exit(1); }
  let final = [];
  try { final = JSON.parse(fs.readFileSync(FINAL_FILE, 'utf-8')); } catch (e) {}

  const context = await chromium.launchPersistentContext(PROFILE, { headless: false });
  const page = context.pages()[0] || await context.newPage();

  // 关键武将(所有推荐相关的核心)
  const KEY_HEROES = ['曹彰', '曹操', '关羽', '赵云', '于禁', '马超', '刘备', '荀彧', '孙权', '甘宁', '马岱', '田丰', '曹纯', '张辽', '祝融', '华雄', '太史慈', '卫瓘', '吕蒙', '司马炎', '张绣', '马谡', '庞统', '程昱', '袁术', '典韦'];

  for (const sn of SNS) {
    console.log(`\n===== 复核 ${sn} =====`);
    const apiAcc = final.find(a => a.overview && a.overview.url.includes(sn));
    // 打开详情页
    await page.goto(`https://stzb.cbg.163.com/cgi/mweb/equip/1/${sn}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(4000);

    // 页面顶部信息
    const header = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        server: (text.match(/征服赛季 (X\d{4})/) || [])[1] || (text.match(/征服赛季(X\d{4})/) || [])[1],
        star5: (text.match(/(\d+)张五星武将卡/) || [])[1],
        sTac: (text.match(/(\d+)个S级战法/) || [])[1],
        gear: (text.match(/(\d+)个稀世宝物/) || [])[1],
        price: (text.match(/¥([\d,]+)/) || [])[1],
        status: (text.match(/(上架中|公示期|已下架|已售出)/) || [])[1] || '未知'
      };
    });
    console.log(`  [页面] 服${header.server} 价${header.price} 五星${header.star5} S战法${header.sTac} 稀世宝${header.gear} 状态${header.status}`);

    // 提取武将
    const heroes = await extractHeroes(page);
    console.log(`  [页面武将] 共提取 ${heroes.length} 个`);

    // 关键武将核对(页面 vs API)
    const apiHeroes = {};
    if (apiAcc) {
      for (const h of apiAcc.heroes || []) {
        const mk = Array.isArray(h.marks) ? h.marks[0] : String(h.marks || '');
        apiHeroes[h.name] = mk;
      }
    }
    for (const n of KEY_HEROES) {
      const pageHit = heroes.filter(h => h.name === n);
      const apiHit = apiAcc && apiHeroes[n];
      if (pageHit.length || apiHit) {
        const pageMarks = pageHit.map(h => h.marks[0]).join(',') || '无';
        const apiMark = apiHit || '无';
        // 页面标记与 API 标记匹配: 版本标记(极/SP/XP/S2/S3/N)一致即可
        // 页面可能只显示版本(极), API 是完整(魏极XP)
        let ok = false;
        for (const pm of pageHit) {
          const pVer = pm.marks[0].replace(/^(魏|蜀|吴|群|汉|晋)/, '');   // 去掉阵营留版本
          if (pVer && apiMark.includes(pVer)) { ok = true; break; }
          // 页面只有"极"时宽松通过
          if (pVer === '极' && apiMark.includes('极')) { ok = true; break; }
        }
        console.log(`  ${n}: 页面[${pageMarks}] vs API[${apiMark}] ${ok ? '✅' : '⚠️'}`);
      }
    }
    // API 汇总
    if (apiAcc) {
      console.log(`  [API] 武将${apiAcc.heroCount} 战法${(apiAcc.tactics||[]).length} 宝${(apiAcc.equips||[]).length}`);
    } else {
      console.log('  [API] 该号不在 final 数据中');
    }
  }
  await context.close();
  console.log('\n复核完成');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
