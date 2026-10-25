// 率土之滨藏宝阁 - 候选账号批量采集脚本 (v2: 列表页点击式)
// 用法: node cbg-detail-extract.js [LIST_URL] [OUT_FILE]
// 前置:
//   1. 首次运行弹出浏览器,请在浏览器里登录藏宝阁(cookie 保存在 .cbg-profile 复用)
//   2. 脚本打开列表页(白名单+价格档), 滚动加载全部卡片, 逐个点击进入详情提取
// 输出: accounts-detail.json (每轮断点保存)
//
// 每个候选采集: 概览 / 武将(5星筛选+红度) / 战法 / 宝物
// 断点续采主键: ordersn（overview.url 末段或卡片链接提取）；旧数据缺 ordersn 时才回退 server-price
// 阈值来源: data/strategy-config.json（经 lib-config.js），不在 URL 里写死 1500-2500/85/12

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const cfg = require('./lib-config.js');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = process.argv[3] || path.join(ROOT, 'data', 'accounts-detail.json');
const PROFILE_DIR = path.join(ROOT, '.cbg-profile');
const LOGIN_WAIT_SECONDS = Number(process.env.CBG_LOGIN_WAIT_SECONDS || 120);
const CAPTCHA_WAIT_SECONDS = Number(process.env.CBG_CAPTCHA_WAIT_SECONDS || 120);

// 列表页 URL(当前开放试师区服 + 价格档 + 五星/锻造门槛)，参数全部来自策略配置单源:
//   price_min/price_max = l1_pool.priceRange（元 → 分）
//   five_star_hero_count = l1_pool.bargainLine.fiveStarMin
//   duanzao_gear_cnt = l1_pool.bargainLine.forgedGearMin（捡漏线，与原默认 12 一致）
// 试师区服: 统一从 scripts/lib-shishi.js 读取（data/shishi-open.json，update-shishi.js 生成）
const { getServerIds } = require('./lib-shishi');
const SERVERIDS = getServerIds().ids;
const L1 = cfg.getL1();
const L2 = cfg.getL2();
const POOL_PRICE = L1.priceRange;
const FIVE_STAR_MIN = L1.bargainLine.fiveStarMin;
const FORGED_GEAR_MIN = L1.bargainLine.forgedGearMin;
for (const [name, v] of [['l1_pool.priceRange', POOL_PRICE], ['l1_pool.bargainLine.fiveStarMin', FIVE_STAR_MIN], ['l1_pool.bargainLine.forgedGearMin', FORGED_GEAR_MIN]]) {
  if (typeof v !== 'number' && !(Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number'))) {
    console.error(`[cbg-detail] 配置 ${name} 缺失或格式错误: ${JSON.stringify(v)}`);
    process.exit(1);
  }
}
const LIST_URL = process.argv[2] || `https://stzb.cbg.163.com/cgi/mweb/pl?search_type=role&tfid=f_kingkong&baijia_hero_logic=and&dynamic_icon_hero_id_logic=and&game_compete_serverid=${SERVERIDS}&price_min=${POOL_PRICE[0] * 100}&price_max=${POOL_PRICE[1] * 100}&five_star_hero_count=${FIVE_STAR_MIN}&duanzao_gear_cnt=${FORGED_GEAR_MIN}`;
cfg.logEffective('[cbg-detail]');
console.log(`[cbg-detail] 价格档 ¥${POOL_PRICE[0]}-${POOL_PRICE[1]} | 五星≥${FIVE_STAR_MIN} | 锻造≥${FORGED_GEAR_MIN} | L2 稀世≥${L2.rareEquipMin} | URL 参数与配置指纹 ${cfg.configFingerprint()} 一致`);

// ---- ordersn 归一化（断点续采/去重主键） ----
function ordersnFromUrl(u) {
  const tail = String(u || '').split('?')[0].replace(/\/+$/, '').split('/').pop();
  return /^\d{8,}-/.test(tail) ? tail : '';
}
function recKey(r) {
  if (!r) return '';
  const sn = (r.list && r.list.ordersn) || ordersnFromUrl(r.overview && r.overview.url);
  if (sn) return 'sn:' + sn;
  if (!r.overview) return '';
  return `sp:${r.overview.server}-${String(r.overview.price || '').replace(/,/g, '')}`;
}
function cardKey(c) {
  if (c.ordersn) return 'sn:' + c.ordersn;
  return `sp:${c.server}-${String(c.price || '').replace(/,/g, '')}`;
}

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
        // 卡片链接里带 ordersn（/cgi/mweb/equip/1/<ordersn>），作为断点续采/去重主键
        const a = c.querySelector('a[href*="equip/"]');
        const href = a ? (a.getAttribute('href') || '') : '';
        const m = href.match(/equip\/1\/([A-Za-z0-9-]{8,})/);
        const ordersn = m ? m[1] : '';
        return { idx, price: price ? price.replace(/,/g, '') : '', server, stars, st, eq, lim, ordersn };
      })
      .filter(c => c.server);
  });
}

async function scrollLoadAll(page) {
  // 藏宝阁列表是"滚到页面最底部→加载下一页"机制, 必须滚到底+等加载完成, 不能用小步滚动
  let prev = -1, stable = 0;
  for (let i = 0; i < 80; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(900);   // 等异步加载下一页
    const n = await page.evaluate(() => document.querySelectorAll('.product-item, .extend-product-item').length);
    if (n === prev) {
      stable++;
      if (stable >= 4) break;   // 连续4次卡片数不变才认为到底
    } else {
      stable = 0;
    }
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
  // 断点续采主键: ordersn 优先；仅旧数据缺 ordersn 时回退 server-price
  const doneKeys = new Set(results.map(recKey).filter(Boolean));

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

  // ===== 打开列表页并滚动加载全部(只加载一次) =====
  console.log('\n===== 打开列表页并加载全部 =====');
  let cards = await waitForCards();
  if (cards.length === 0) { console.error('列表持续为空(可能未登录), 停止'); await context.close(); return; }
  console.log('列表卡片数:', cards.length, '已完成:', doneKeys.size);

  // 详情页 goBack 返回后列表 DOM 保留(已验证284张不丢), 只在丢失时才重新加载
  async function ensureList() {
    const still = await page.evaluate(() => document.querySelectorAll('.product-item, .extend-product-item').length);
    if (still > 0) { cards = await collectCards(page); return true; }
    console.log('  列表丢失, 重新加载...');
    cards = await waitForCards();
    return cards.length > 0;
  }

  let rounds = 0;
  while (rounds < 500) {
    const pending = cards.find(c => !doneKeys.has(cardKey(c)));
    if (!pending) { console.log('全部处理完成'); break; }
    const idx = cards.indexOf(pending);
    console.log(`[${doneKeys.size}/${cards.length}] 处理: ${pending.server} ¥${pending.price} ${pending.ordersn ? 'ordersn=' + pending.ordersn : '(无 ordersn, 回退 server-price)'} ...`);
    try {
      // 滚动到目标卡(返回后列表位置会变, 每次用 scrollIntoView 定位)
      await page.evaluate((i) => {
        const el = document.querySelectorAll('.product-item, .extend-product-item')[i];
        if (el) el.scrollIntoView({ block: 'center' });
      }, idx);
      await sleep(600);
      // 点击卡片: 真实鼠标点击(evaluate .click() 对 CBG 无效, 必须用 locator.click)
      const cardLoc = page.locator('.product-item, .extend-product-item').nth(idx);
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
      const ordersn = pending.ordersn || ordersnFromUrl(overview.url);

      const rec = {
        list: { price: pending.price, server: pending.server, stars: pending.stars, st: pending.st, eq: pending.eq, lim: pending.lim, ordersn },
        overview,
        heroCount: heroes.cards ? heroes.cards.length : 0,
        heroes: heroes.cards || [],
        tactics,
        equips,
        source: 'browser',
        capturedAt: new Date().toISOString(),
        statusKind: cfg.classifyStatus(overview.status)
      };
      results.push(rec);
      fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 1), 'utf-8');
      const sv = overview.server || pending.server;
      const pr = overview.price || pending.price;
      // 统一 key: ordersn 优先; 同时补 server-price 兼容旧数据
      doneKeys.add(recKey(rec));
      doneKeys.add(cardKey(pending));
      doneKeys.add(`sp:${sv}-${String(pr).replace(/,/g, '')}`);
      console.log(`  ✓ ${sv} ¥${overview.price} ${overview.stars}★ ${overview.sTactics}S ${overview.rareEquips}宝 满红${overview.fullRed} 限${overview.limited} 锻${overview.forged} | 武将${heroes.cards ? heroes.cards.length : 0} 战法${tactics.length} 宝${equips.length} | ordersn=${ordersn || '-'} 状态=${rec.statusKind}`);
      // 返回列表(复用当前列表 DOM, 不用重新 goto+滚动)
      await page.goBack().catch(() => {});
      await sleep(1800);
      if (!(await ensureList())) break;
    } catch (e) {
      console.error('  ERROR:', e.message);
      doneKeys.add(cardKey(pending));
      await page.goBack().catch(() => {});
      await sleep(1800);
      if (!(await ensureList())) break;
    }
    rounds++;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 1), 'utf-8');
  console.log('\n完成, 已保存', OUT_FILE, '共', results.length, '条');
  await context.close();
}

main().catch(e => { console.error(e); process.exit(1); });
