// 率土之滨藏宝阁 - 候选账号批量采集脚本 (v2: 列表页点击式)
// 用法: node cbg-detail-extract.js
// 前置:
//   1. 首次运行弹出浏览器,请在浏览器里登录藏宝阁(cookie 保存在 .cbg-profile 复用)
//   2. 脚本打开列表页(白名单+价格档), 滚动加载全部卡片, 逐个点击进入详情提取
// 输出: accounts-detail.json (每轮断点保存)
//
// 每个候选采集: 概览 / 武将(5星筛选+红度) / 战法 / 宝物

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = process.argv[3] || path.join(ROOT, 'data', 'accounts-detail.json');
const PROFILE_DIR = path.join(ROOT, '.cbg-profile');
const LOGIN_WAIT_SECONDS = Number(process.env.CBG_LOGIN_WAIT_SECONDS || 120);
const CAPTCHA_WAIT_SECONDS = Number(process.env.CBG_CAPTCHA_WAIT_SECONDS || 120);

// 列表页 URL(白名单 65 服 + 价格档 + 五星≥85 + 宝物≥12)
// 用法: node cbg-detail-extract.js [LIST_URL] [OUT_FILE]
const LIST_URL = process.argv[2] || 'https://stzb.cbg.163.com/cgi/mweb/pl?search_type=role&tfid=f_kingkong&baijia_hero_logic=and&dynamic_icon_hero_id_logic=and&game_compete_serverid=44748,44749,44750,44751,44752,44753,44754,44755,44761,44762,44763,44764,44765,44766,44773,44774,44775,44776,44777,44778,44779,44788,44789,44790,44791,44792,44793,44794,44804,44805,44808,44809,44810,44811,44812,44819,44820,44821,44822,44823,44824,44834,44835,44836,44837,44838,44839,44840,44841,44854,44855,44856,44857,44858,44859,44860,44861,44862,44863,44869,44870,44871,44872,44873,44874&price_min=150000&price_max=250000&five_star_hero_count=85&duanzao_gear_cnt=12';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// 随机延迟: 降低风控触发概率
function randomSleep(min, max) { return sleep(min + Math.floor(Math.random() * (max - min))); }

// 检测并等待人工通过滑动拼图验证码(藏宝阁风控)
async function waitCaptchaPass(page) {
  const has = await page.evaluate(() => {
    const t = document.body.innerText || '';
    return (/拖动滑块|滑动拼图|安全验证|人机验证/.test(t) || !!document.querySelector('iframe[src*="captcha"], iframe[src*="verify"]'));
  });
  if (!has) return false;
  console.log('  ⚠️ 触发滑动拼图验证码, 请在浏览器中手动通过, 每5秒检查一次...');
  for (let i = 0; i < Math.ceil(CAPTCHA_WAIT_SECONDS / 5); i++) {
    await sleep(5000);
    const still = await page.evaluate(() => {
      const t = document.body.innerText || '';
      return (/拖动滑块|滑动拼图|安全验证|人机验证/.test(t) || !!document.querySelector('iframe[src*="captcha"], iframe[src*="verify"]'));
    });
    if (!still) { console.log('  ✓ 验证码已通过'); return true; }
    if (i % 6 === 0) console.log('  仍在等待验证码... (可在浏览器窗口手动滑动)');
  }
  return true;
}

async function extractOverview(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || '';
    const g = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };
    // server 必须从主商品区读(避免相似推荐区误读): 详情页顶部 .pdetailPreview 区域
    let server = null;
    const main = document.querySelector('.pdetailPreview, .list-block.border.pdetailPreview');
    if (main) {
      const m = main.textContent.match(/征服赛季(X\d+)/);
      if (m) server = m[1];
    }
    if (!server) {
      const m2 = t.match(/征服赛季(X\d+)/);
      if (m2) server = m2[1];
    }
    return {
      url: location.href,
      server,
      price: g(/¥([\d,]+)/),
      stars: g(/(\d+)张五星武将卡/),
      sTactics: g(/(\d+)个S级战法/),
      rareEquips: g(/(\d+)个稀世宝物/),
      fullRed: g(/(\d+)个满红五星武将/),
      limited: g(/(\d+)个限定武将/),
      forged: g(/(\d+)个已锻造宝物/),
      skins: g(/(\d+)个武将外观/),
      status: t.indexOf('公示期') >= 0 ? '公示期' : (t.indexOf('出售剩余时间') >= 0 ? '上架中' : '?'),
      isLogin: /手机号|验证码/.test(t) && /show_login/.test(location.href)
    };
  });
}

async function ensureLogin(page) {
  for (let i = 0; i < 120; i++) {
    const o = await extractOverview(page);
    if (!o.isLogin) return true;
    console.log('  等待登录中...');
    await sleep(5000);
  }
  return false;
}

async function extractHeroes(page) {
  // 确保进入武将卡视图: 点「武将卡」tab(真实鼠标点击)
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitCaptchaPass(page);
    await page.locator('li.tab-item').filter({ hasText: '武将卡' }).first().click({ timeout: 5000 }).catch(() => {});
    await randomSleep(1000, 2000);
    const hasStar = await page.evaluate(() => {
      return !!Array.from(document.querySelectorAll('*')).find(e => /^星级\(/.test(e.textContent.trim()));
    });
    if (hasStar) break;
  }
  // 确保星级 = 5星(默认通常就是 5星)
  const starState = await page.evaluate(() => {
    const star = Array.from(document.querySelectorAll('*')).find(e => /^星级\(/.test(e.textContent.trim()));
    return star ? star.textContent.trim().split('\n')[0] : null;
  });
  if (starState && starState !== '星级(5星)') {
    await page.locator('li.tab-filter').filter({ hasText: /^星级\(/ }).first().click({ timeout: 5000 }).catch(() => {});
    await sleep(600);
    await page.locator('li.tab-filter').filter({ hasText: /^5星$/ }).first().click({ timeout: 5000 }).catch(() => {});
    await sleep(1500);
  }
  return page.evaluate(() => {
    const star = Array.from(document.querySelectorAll('*')).find(e => e.textContent.trim() === '星级(5星)');
    if (!star) return { err: 'no-5star', cards: [] };
    const module = star.parentElement;
    const kids = Array.from(module.children);
    const listEl = kids.find(c => (c.className || '').includes('letterModule')) || kids[2];
    if (!listEl) return { err: 'no-list', cards: [] };
    const cards = Array.from(listEl.children).map(c => {
      const txt = (c.textContent || '').replace(/\s+/g, ' ').trim();
      const parts = txt.split(' ');
      return { name: parts.pop(), marks: parts.join('|') };
    }).filter(h => h.name && h.name.length >= 2 && h.name.length <= 12);
    return { cards };
  });
}

// 提取战法列表(战法tab在 .tabs .item, 非 li.tab-item)
async function extractTactics(page) {
  const tab = page.locator('.tabs .item').filter({ hasText: '战法' }).first();
  await tab.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await tab.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const sc = document.querySelector('.module.skill-count');
    const listEl = sc ? sc.nextElementSibling : null;
    if (!listEl) return [];
    const skip = new Set(['指挥', '主动', '追击', '被动']);
    const out = [];
    for (const p of listEl.querySelectorAll('p')) {
      const t = (p.textContent || '').trim();
      if (t && !skip.has(t) && t.length >= 2 && t.length <= 6) out.push(t);
    }
    return Array.from(new Set(out));
  });
}

// 提取宝物列表(宝物tab在 .tabs .item; 条目 div.baowu-item.item > .wrap + .name)
async function extractEquips(page) {
  const tab = page.locator('.tabs .item').filter({ hasText: '宝物' }).first();
  await tab.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await tab.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    // 输出纯宝物名(去掉「极」强化前缀), 便于与榜单名匹配
    return Array.from(document.querySelectorAll('div.baowu-item.item')).map(e => {
      const name = (e.querySelector('.name') ? e.querySelector('.name').textContent : '').trim();
      return name;
    }).filter(Boolean);
  });
}

async function collectCards(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('.product-item, .extend-product-item'))
      .map((c, idx) => {
        const t = c.textContent || '';
        const price = (t.match(/¥([\d,]+)/) || ['', ''])[1];
        const server = (t.match(/X\d{4}/) || [''])[0];
        const stars = (t.match(/(\d+)张五星武将卡/) || ['', ''])[1];
        const st = (t.match(/(\d+)个S级战法/) || ['', ''])[1];
        const eq = (t.match(/(\d+)个稀世宝物/) || ['', ''])[1];
        const lim = (t.match(/(\d+)个限定武将/) || ['', ''])[1];
        return { idx, price: price ? price.replace(/,/g, '') : '', server, stars, st, eq, lim };
      })
      .filter(c => c.server);
  });
}

async function scrollLoadAll(page) {
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 900);
    await sleep(350);
    const n = await page.evaluate(() => document.querySelectorAll('.product-item, .extend-product-item').length);
    if (n === prev && i > 3) break;
    prev = n;
  }
  return prev;
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
  const page = context.pages()[0] || await context.newPage();

  let results = [];
  if (fs.existsSync(OUT_FILE)) {
    try { results = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8')); } catch (e) { results = []; }
  }
  const doneKeys = new Set(results.map(r => r.overview && (r.overview.url || (r.overview.server + '-' + r.overview.price))).filter(Boolean));

  // 等待列表卡片出现(未登录时卡片为0, 会在此等待用户登录)
  async function waitForCards() {
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    let cards = [];
    for (let w = 0; w < Math.ceil(LOGIN_WAIT_SECONDS / 5); w++) {
      await sleep(3000);
      await scrollLoadAll(page);
      cards = await collectCards(page);
      if (cards.length > 0) return cards;
      if (w % 4 === 0) {
        console.log(`  等待列表加载... 请在浏览器窗口登录 (已等 ${w * 5}s)`);
      }
      await sleep(2000);
    }
    return cards;
  }

  let rounds = 0;
  while (rounds < 60) {
    console.log(`\n===== 第 ${rounds + 1} 轮: 打开列表页 =====`);
    const cards = await waitForCards();
    if (cards.length === 0) { console.error('列表持续为空(可能未登录), 停止'); break; }
    console.log('列表卡片数:', cards.length, '已完成:', doneKeys.size);

    // 找第一个未处理的卡片
    const pending = cards.find(c => !doneKeys.has(c.server + '-' + c.price));
    if (!pending) { console.log('全部处理完成'); break; }

    console.log(`处理: ${pending.server} ¥${pending.price} ...`);
    try {
      // 点击卡片: 真实鼠标点击(evaluate .click() 对 CBG 无效, 必须用 locator.click)
      const cardLoc = page.locator('.product-item, .extend-product-item').nth(pending.idx);
      await cardLoc.click({ timeout: 8000 }).catch(() => {});
      await randomSleep(2000, 4000);
      // 检测验证码(风控)
      await waitCaptchaPass(page);
      // 等待进入详情页(出现 tab-item 即视为进入)
      let inDetail = false;
      for (let w = 0; w < 10; w++) {
        await sleep(1000);
        inDetail = await page.evaluate(() => document.querySelectorAll('.product-content, ul.card-tab, li.tab-item').length > 0);
        if (inDetail) break;
      }
      if (!inDetail) {
        // 重试: 坐标点击
        const box = await cardLoc.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await sleep(4000);
        }
      }

      // 若点进详情后是登录页, 等待
      let loginWait = 0;
      let ov = await extractOverview(page);
      while (ov.isLogin && loginWait < 120) {
        console.log('  等待登录...');
        await sleep(5000);
        loginWait++;
        ov = await extractOverview(page);
      }

      const overview = ov;
      const heroes = await extractHeroes(page);
      const tactics = await extractTactics(page);
      const equips = await extractEquips(page);

      const rec = {
        list: { price: pending.price, server: pending.server, stars: pending.stars, st: pending.st, eq: pending.eq, lim: pending.lim },
        overview,
        heroCount: heroes.cards ? heroes.cards.length : 0,
        heroes: heroes.cards || [],
        tactics,
        equips
      };
      results.push(rec);
      fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 1), 'utf-8');
      const sv = overview.server || pending.server;
      const pr = overview.price || pending.price;
      // 统一 key: 服务器-价格, 避免重复处理同一张卡
      doneKeys.add(sv + '-' + pr);
      doneKeys.add(pending.server + '-' + pending.price);
      console.log(`  ✓ ${sv} ¥${overview.price} ${overview.stars}★ ${overview.sTactics}S ${overview.rareEquips}宝 满红${overview.fullRed} 限${overview.limited} 锻${overview.forged} | 武将${heroes.cards ? heroes.cards.length : 0} 战法${tactics.length} 宝${equips.length}`);
    } catch (e) {
      console.error('  ERROR:', e.message);
      doneKeys.add(pending.server + '-' + pending.price);
    }
    rounds++;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 1), 'utf-8');
  console.log('\n完成, 已保存', OUT_FILE, '共', results.length, '条');
  await context.close();
}

main().catch(e => { console.error(e); process.exit(1); });
