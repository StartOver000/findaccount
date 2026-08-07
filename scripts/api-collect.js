// ============================================================
// api-collect.js — 藏宝阁 API 直采(档3实验成功后的正式采集器)
// 原理:
//   列表: POST /cgi-bin/recommend.py?act=recommd_by_role (page 1..N, count=15)
//   详情: POST /cgi/api/get_equip_detail (serverid=1&ordersn=xxx)
//         → equip.equip_desc(JSON字符串) 内含 card[](武将) skill[](战法) gear[](宝物)
// 实现: 页面内 fetch(自动带 cookie/referer/会话), 不点 DOM, 150 个号几分钟跑完
// 用法:
//   node scripts/api-collect.js [OUT.json] [priceMin] [priceMax]
//   前置: .cbg-profile 已登录(浏览器采集用过的 profile 可直接复用)
// ============================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.cbg-profile');
const OUT = process.argv[2] || path.join(ROOT, 'data', 'accounts-api.json');
const PRICE_MIN = process.argv[3] || '150000';
const PRICE_MAX = process.argv[4] || '250000';

const SERVERIDS = '44748,44749,44750,44751,44752,44753,44754,44755,44761,44762,44763,44764,44765,44766,44773,44774,44775,44776,44777,44778,44779,44788,44789,44790,44791,44792,44793,44794,44804,44805,44808,44809,44810,44811,44812,44819,44820,44821,44822,44823,44824,44834,44835,44836,44837,44838,44839,44840,44841,44854,44855,44856,44857,44858,44859,44860,44861,44862,44863,44869,44870,44871,44872,44873,44874';
const LIST_URL = `https://stzb.cbg.163.com/cgi/mweb/pl?search_type=role&tfid=f_kingkong&baijia_hero_logic=and&dynamic_icon_hero_id_logic=and&game_compete_serverid=${SERVERIDS}&price_min=${PRICE_MIN}&price_max=${PRICE_MAX}&five_star_hero_count=85&duanzao_gear_cnt=12`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, { headless: false });
  const page = context.pages()[0] || await context.newPage();
  // 打开列表页建立会话(页面内 fetch 依赖 referer + cookie)
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(3000);

  // ---- 1. 列表(页面内 fetch 翻页) ----
  console.log('== 拉取列表 ==');
  const cards = await page.evaluate(([sid, pmin, pmax]) => {
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
      }
      return out;
    })();
  }, [SERVERIDS, PRICE_MIN, PRICE_MAX]);
  console.log('列表共:', cards.length, '个账号');

  // ---- 2. 详情(页面内 fetch, 分批避免 evaluate 超时) ----
  console.log('== 拉取详情 ==');
  const results = [];
  const BATCH = 6;
  for (let i = 0; i < cards.length; i += BATCH) {
    const batch = cards.slice(i, i + BATCH);
    const data = await page.evaluate((batch) => {
      return Promise.all(batch.map(async (c) => {
        const body = `serverid=1&ordersn=${c.ordersn}&h5_device=other&app_client=other`;
        const res = await fetch('/cgi/api/get_equip_detail?client_type=h5', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, credentials: 'include'
        });
        const j = await res.json();
        const equip = j.equip || {};
        let desc = {};
        try { desc = JSON.parse(equip.equip_desc || '{}'); } catch (e) {}
        return { ordersn: c.ordersn, server_name: c.server_name, price: c.price, sumup: c.sumup, status: equip.status_desc || '', desc };
      }));
    }, batch);
    for (const d of data) {
      const desc = d.desc || {};
      const heroes = (desc.card || []).map(x => ({
        name: x.name, hero_id: x.hero_id, country: x.country, season: x.season,
        awake: x.awake_state, advance: x.advance_num, quality: x.quality
      }));
      results.push({
        list: { server: d.server_name ? d.server_name.replace(/(X\d{4}).*/, '$1') : '', price: d.price, ordersn: d.ordersn, sumup: d.sumup },
        overview: {
          url: `https://stzb.cbg.163.com/cgi/mweb/equip/1/${d.ordersn}`,
          server: d.server_name || '', price: d.price, fullRed: 0, status: d.status
        },
        heroCount: heroes.length,
        heroes,
        tactics: (desc.skill || []).map(x => x.name).filter(Boolean),
        equips: (desc.gear || []).map(x => x.name).filter(Boolean)
      });
    }
    fs.writeFileSync(OUT, JSON.stringify(results, null, 1), 'utf-8');
    console.log(`  已采 ${Math.min(i + BATCH, cards.length)}/${cards.length}`);
    await sleep(200 + Math.floor(Math.random() * 300));
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 1), 'utf-8');
  console.log('\n完成, 已保存', OUT, '共', results.length, '条');
  await context.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
