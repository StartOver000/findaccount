// ============================================================
// browser-verify.js — 推荐号浏览器复核(正确性兜底)
// 用途: 对最终推荐的少数号(3-5个), 用浏览器详情页人工/半自动复核,
//       确认 API 采集的武将/战法/宝物与页面一致(防 API 数据残留错误)
// 用法:
//   node scripts/browser-verify.js [ordersn列表, 逗号分隔]
//   例: node scripts/browser-verify.js 202607170802116-1-ERARQHWPYGNR3P,202607121502116-1-1HKAWGYSJEQXFX
//   前置: 浏览器已登录(会用 .cbg-profile 打开详情页)
// 输出: 每个号的 五星武将数/关键武将版本/战法数/宝物数 → 与 API 数据对比
// ============================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.cbg-profile');
const SNS = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const FINAL_FILE = path.join(ROOT, 'data', 'accounts-final.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (SNS.length === 0) { console.log('用法: node scripts/browser-verify.js <ordersn1,ordersn2,...>'); process.exit(1); }
  // 读取 API 数据用于对比
  let final = [];
  try { final = JSON.parse(fs.readFileSync(FINAL_FILE, 'utf-8')); } catch (e) {}

  const context = await chromium.launchPersistentContext(PROFILE, { headless: false });
  const page = context.pages()[0] || await context.newPage();

  for (const sn of SNS) {
    console.log(`\n===== 复核 ${sn} =====`);
    const apiAcc = final.find(a => a.overview && a.overview.url.includes(sn));
    if (apiAcc) {
      const api5 = (apiAcc.heroes || []).filter(h => (h.marks || '').includes('5') === false && true).length;
      console.log(`  [API] 武将${apiAcc.heroCount} 战法${(apiAcc.tactics||[]).length} 宝${(apiAcc.equips||[]).length}`);
    } else {
      console.log('  [API] 该号不在 final 数据中');
    }

    // 打开详情页
    await page.goto(`https://stzb.cbg.163.com/cgi/mweb/equip/1/${sn}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(4000);

    // 提取页面顶部信息(五星数/战法数/宝物数)
    const header = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const star5 = (text.match(/(\d+)张五星武将卡/) || [])[1];
      const sTac = (text.match(/(\d+)个S级战法/) || [])[1];
      const gear = (text.match(/(\d+)个稀世宝物/) || [])[1];
      const server = (text.match(/征服赛季(X\d{4})/) || [])[1];
      return { server, star5, sTac, gear };
    });
    console.log(`  [页面] 服${header.server} 五星${header.star5} S战法${header.sTac} 稀世宝${header.gear}`);

    // 提取武将区(切到5星筛选后)
    // 尝试点击"星级(5星)"筛选
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('div,span')];
      const star5 = els.find(e => e.textContent.trim() === '星级(5星)' && e.children.length === 0);
      if (star5) star5.click();
    });
    await sleep(1500);
    // 若出现"全阵营(280)"说明未过滤, 尝试再点一次
    const heroList = await page.evaluate(() => {
      const heroes = [];
      const nodes = document.querySelectorAll('[class*="letterModule"] *, [class*="hero"] [class*="name"], [class*="card"] [class*="name"]');
      // 更简单: 收集 "阵营 版本 名字" 模式文本
      const text = document.body.innerText || '';
      const re = /(魏|蜀|吴|群|汉|晋)(极)?(SP|XP|S2|S3|N)?\s*([\u4e00-\u9fa5·＆]{2,5})/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        heroes.push({ name: m[4], marks: [m[1] + (m[2]||'') + (m[3]||'')] });
      }
      // 去重
      const seen = new Set();
      const uniq = [];
      for (const h of heroes) {
        const k = h.name + '-' + h.marks[0];
        if (!seen.has(k)) { seen.add(k); uniq.push(h); }
      }
      return uniq;
    });
    console.log(`  [页面武将] 提取到 ${heroList.length} 个(含4星) 例: ${heroList.slice(0, 5).map(h => h.name + h.marks).join(', ')}`);
  }
  await context.close();
  console.log('\n复核完成');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
