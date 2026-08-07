// ============================================================
// api-collect.js — 藏宝阁 API 直采(v3: desc初筛 + 详情重试 + 断点续采)
// 原理:
//   列表: POST /cgi-bin/recommend.py?act=recommd_by_role (page 1..N, count=15)
//         → result[] 含 game_ordersn/server_name/price/desc_sumup_short
//         desc_sumup_short 形如 "118张五星武将卡 23个S级战法 14个稀世宝物"
//         ⚠️ 已验证: desc 的五星数 == 详情 quality=5 数量(36/36 完全一致)
//         → 列表阶段即可用 desc 初筛(五星>=85 且 宝物>=12), 无效号不采详情
//   详情: POST /cgi/api/get_equip_detail (serverid=1&ordersn=xxx)
//         → equip.equip_desc(JSON字符串) 内含 card[](武将) skill[](战法) gear[](宝物)
//         ⚠️ quality 字段才是真实星级(quality===5 五星, quality=4 四星)
// 优化(v3):
//   - 列表 desc 初筛: 五星<85 或 宝<12 的号跳过详情(省 80% 请求)
//   - 详情批量 BATCH=6 + 失败自动重试 2 次(之前 104 个空号多为偶发失败)
//   - 断点续采: 已保存的 OUT 里的 ordersn 自动跳过
// 用法:
//   node scripts/api-collect.js [OUT.json] [priceMin] [priceMax]
//   node scripts/api-collect.js [OUT.json] [priceMin] [priceMax] [browser-detail.json]
//     browser-detail.json: 可选, 传了则只采「浏览器没有的号」(补漏), 省时+防限流
//   前置: .cbg-profile 已登录且完成手机验证(浏览器打开过列表页即可)
// ============================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.cbg-profile');
const OUT = process.argv[2] || path.join(ROOT, 'data', 'accounts-api.json');
const PRICE_MIN = process.argv[3] || '150000';
const PRICE_MAX = process.argv[4] || '250000';
const BROWSER_FILE = process.argv[5] || '';

const SERVERIDS = '44748,44749,44750,44751,44752,44753,44754,44755,44761,44762,44763,44764,44765,44766,44773,44774,44775,44776,44777,44778,44779,44788,44789,44790,44791,44792,44793,44794,44804,44805,44808,44809,44810,44811,44812,44819,44820,44821,44822,44823,44824,44834,44835,44836,44837,44838,44839,44840,44841,44854,44855,44856,44857,44858,44859,44860,44861,44862,44863,44869,44870,44871,44872,44873,44874';
const LIST_URL = `https://stzb.cbg.163.com/cgi/mweb/pl?search_type=role&tfid=f_kingkong&baijia_hero_logic=and&dynamic_icon_hero_id_logic=and&game_compete_serverid=${SERVERIDS}&price_min=${PRICE_MIN}&price_max=${PRICE_MAX}&five_star_hero_count=85&duanzao_gear_cnt=12`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 从 desc_sumup_short 解析 五星数/宝物数, 返回 null 表示解析失败
function parseDesc(sumup) {
  const s = String(sumup || '');
  const m5 = s.match(/(\d+)张五星武将卡/);
  const m12 = s.match(/(\d+)个稀世宝物/);
  if (!m5 && !m12) return null;
  return { star5: m5 ? parseInt(m5[1], 10) : 0, gear: m12 ? parseInt(m12[1], 10) : 0 };
}

// 从 equip_desc 构造统一结果
function buildResult(d) {
  const desc = d.desc || {};
  const heroes = (desc.card || []).map(x => ({
    name: x.name, hero_id: x.hero_id, country: x.country, season: x.season,
    awake: x.awake_state, advance: x.advance_num, quality: x.quality
  }));
  return {
    list: { server: d.server_name ? d.server_name.replace(/(X\d{4}).*/, '$1') : '', price: d.price, ordersn: d.ordersn, sumup: d.sumup },
    overview: {
      url: `https://stzb.cbg.163.com/cgi/mweb/equip/1/${d.ordersn}`,
      server: d.server_name || '', price: d.price, fullRed: 0, status: d.status
    },
    heroCount: heroes.length,
    heroes,
    tactics: (desc.skill || []).map(x => x.name).filter(Boolean),
    equips: (desc.gear || []).map(x => x.name).filter(Boolean)
  };
}

async function fetchDetail(page, c) {
  const body = `serverid=1&ordersn=${c.ordersn}&h5_device=other&app_client=other`;
  const res = await page.evaluate((body) => {
    return fetch('/cgi/api/get_equip_detail?client_type=h5', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, credentials: 'include'
    }).then(r => r.json());
  }, body);
  const equip = res.equip || {};
  let desc = {};
  try { desc = JSON.parse(equip.equip_desc || '{}'); } catch (e) {}
  return { ordersn: c.ordersn, server_name: c.server_name, price: c.price, sumup: c.sumup, status: equip.status_desc || '', desc };
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, { headless: false });
  const page = context.pages()[0] || await context.newPage();
  // 打开列表页建立会话(页面内 fetch 依赖 referer + cookie)
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(3000);

  // ---- 断点续采: 读取已有结果(只保留 heroes 非空的, 空号重新采) ----
  const done = new Map(); // ordersn -> result
  if (fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
      for (const r of prev) {
        if (!r.list || !r.list.ordersn) continue;
        if (r.heroes && r.heroes.length > 0) done.set(r.list.ordersn, r);
      }
      console.log('resume: 有效', done.size, '条 (空号将重采)');
    } catch (e) { console.log('resume: 忽略损坏旧文件'); }
  }

  // ---- 1. 列表(页面内 fetch 翻页, desc 初筛, 失败自动重试) ----
  console.log('== 1/2 拉取列表 + desc 初筛 ==');
  let cards = [];
  for (let attempt = 1; attempt <= 3 && cards.length === 0; attempt++) {
    if (attempt > 1) { console.log('list retry', attempt, '...'); await sleep(3000 * attempt); }
    cards = await page.evaluate(([sid, pmin, pmax]) => {
      return (async () => {
        const out = [];
        for (let p = 1; p <= 20; p++) {
          const body = `search_type=role&count=15&view_loc=search_cond&tfid=f_kingkong&baijia_hero_logic=and&dynamic_icon_hero_id_logic=and&game_compete_serverid=${encodeURIComponent(sid)}&price_min=${pmin}&price_max=${pmax}&five_star_hero_count=85&duanzao_gear_cnt=12&order_by=&page=${p}&exter=direct`;
          const res = await fetch('/cgi-bin/recommend.py?client_type=h5&act=recommd_by_role', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, credentials: 'include'
          });
          const j = await res.json();
          const arr = j.result || [];
          for (const c of arr) out.push({ ordersn: c.game_ordersn, server_name: c.server_name, price: c.price, sumup: c.desc_sumup_short || '' });
          const totalPages = j.pager ? j.pager.total_pages : 0;
          if (p >= totalPages || totalPages === 0) break;
          await new Promise(r => setTimeout(r, 400));
        }
        return out;
      })();
    }, [SERVERIDS, PRICE_MIN, PRICE_MAX]);
  }
  console.log('list:', cards.length, 'accounts');

  // 若传了浏览器 detail 文件, 只采浏览器没有的号(补漏, 防限流)
  let browserSns = new Set();
  if (BROWSER_FILE && fs.existsSync(BROWSER_FILE)) {
    try {
      const br = JSON.parse(fs.readFileSync(BROWSER_FILE, 'utf-8'));
      for (const b of br) {
        const u = b.overview && b.overview.url ? b.overview.url : '';
        const sn = u.split('/').pop().split('?')[0];
        if (sn && sn.length > 10) browserSns.add(sn);
      }
      console.log('browser-file:', BROWSER_FILE, '已有', browserSns.size, '个, 跳过这些只补漏');
    } catch (e) { console.log('browser-file 解析失败, 采全部'); }
  }

  // desc 初筛: 只有 五星>=85 且 宝>=12 且 (浏览器没有的号) 才采详情
  let pass = 0, skip = 0, resumed = 0, brSkip = 0;
  const todo = [];
  for (const c of cards) {
    if (done.has(c.ordersn)) { resumed++; continue; }
    if (browserSns.has(c.ordersn)) { brSkip++; continue; }
    const d = parseDesc(c.sumup);
    if (!d || d.star5 < 85 || d.gear < 12) { skip++; continue; }
    pass++;
    todo.push(c);
  }
  console.log(`filter: need-fetch ${pass} | browser-skip ${brSkip} | desc-skip ${skip} | resumed ${resumed}`);

  // ---- 2. 详情(批量 + 重试) ----
  console.log('== 2/2 fetch detail (batch 4, retry 3) ==');
  const results = [...done.values()];
  const BATCH = 4;
  let failCount = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const data = await Promise.all(batch.map(c => fetchDetail(page, c)));

    // 重试失败的(desc 为空 或 card 为空)
    const retry = [];
    for (const d of data) {
      if (!d.desc || !(d.desc.card || []).length) { retry.push(d); continue; }
      results.push(buildResult(d));
    }

    // 重试逻辑(最多3轮, 系统繁忙时等待更长)
    for (let round = 1; round <= 3 && retry.length; round++) {
      await sleep(800 * round);
      const again = [];
      const rd = await Promise.all(retry.map(c => fetchDetail(page, c)));
      for (const d of rd) {
        if (!d.desc || !(d.desc.card || []).length) { again.push(d); continue; }
        results.push(buildResult(d));
      }
      retry.length = 0;
      retry.push(...again);
    }
    failCount += retry.length;

    fs.writeFileSync(OUT, JSON.stringify(results, null, 1), 'utf-8');
    console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length} (fail-after-retry: ${failCount})`);
    await sleep(400 + Math.floor(Math.random() * 500));
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 1), 'utf-8');
  console.log('\ndone, saved', OUT, 'total', results.length, '| detail-fail:', failCount);
  await context.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
