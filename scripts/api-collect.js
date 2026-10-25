// ============================================================
// api-collect.js — 藏宝阁 API 直采(v4: 全量慢速采集 + 登录停下提醒)
// 原理:
//   列表: POST /cgi-bin/recommend.py?act=recommd_by_role (page 1..N, count=15)
//         → result[] 含 game_ordersn/server_name/price/desc_sumup_short
//         desc_sumup_short 形如 "118张五星武将卡 23个S级战法 14个稀世宝物"
//         ⚠️ 已验证: desc 的五星数 == 详情 quality=5 数量(36/36 完全一致)
//         → 列表阶段即可用 desc 初筛(五星/S战法/稀世宝物/锻造, 参数见 data/strategy-config.json)
//   详情: POST /cgi/api/get_equip_detail (serverid=1&ordersn=xxx)
//         → equip.equip_desc(JSON字符串) 内含 card[](武将) skill[](战法) gear[](宝物)
//         ⚠️ quality 字段才是真实星级(quality===5 五星, quality=4 四星)
// 设计(v4, 用户确认方向: 全量 + 正确优先 + 登录停下提醒):
//   - 默认全量采集: 列表里所有通过 L2 门槛的号都采详情(不跳过)
//   - 详情前按预筛分排序(scripts/prefilter.js): 预测战力高的先采, 预算有限时优先保候选
//   - 慢速串行: 详情每号间隔 3-4 秒, 列表翻页 800ms → 不会触发账号级限流
//   - 登录/验证失效: 停下打印提醒, 等用户完成手机验证后按回车继续
//   - 连续失败 >=3: 自动长退避 60-120 秒(疑似限流)
//   - 断点续采: 已成功保存的号自动跳过(中断后可继续)
// 用法:
//   node scripts/api-collect.js [OUT.json] [priceMin] [priceMax] [browser-detail.json] [topN]
//     browser-detail.json: 可选, 传了则只采「浏览器没有的号」(补漏模式)
//     topN: 可选数字, 只采预筛分最高的前 N 个号(精选模式, 防限流)
//   env STZB_LOGIN_WAIT_MS: 登录/验证人工等待超时(毫秒, 默认 120000, 0=不限时)
//   前置: 首次需在打开的浏览器窗口登录并完成手机验证
// 阈值来源: data/strategy-config.json（经 lib-config.js），脚本内不写死门槛值
// ============================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const cfg = require('./lib-config.js');
const runmeta = require('./lib-runmeta.js');
const { loadL2, passListFilter } = require('./list-filter.js');
const { sortByPrefilter, scoreAccount } = require('./prefilter.js');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.cbg-profile');
const OUT = process.argv[2] || path.join(ROOT, 'data', 'accounts-api.json');
const PRICE_MIN = process.argv[3] || '150000';
const PRICE_MAX = process.argv[4] || '250000';
const BROWSER_FILE = process.argv[5] || '';
const TOPN = process.argv[6] ? parseInt(process.argv[6], 10) : 0;

// 登录/验证人工等待超时(毫秒): 默认 120 秒, 超时明确报错 exit 1，避免无人值守时永久挂起
const LOGIN_WAIT_MS = Number(process.env.STZB_LOGIN_WAIT_MS || 120000);
if (!Number.isFinite(LOGIN_WAIT_MS) || LOGIN_WAIT_MS < 0) {
  console.error(`[api-collect] 无效的 STZB_LOGIN_WAIT_MS=${process.env.STZB_LOGIN_WAIT_MS}（需要 >=0 的毫秒数）`);
  process.exit(1);
}

// ---- L2 列表初筛参数（来自 data/strategy-config.json, 见 2026-10-25 策略落地） ----
// FUNNEL_CONTROL=1 时为对照实验模式: 采样区间读 l2_list_filter.controlMode（默认 70 星 / 5 锻造）
const L2 = loadL2();
const CONTROL = L2.control;
const FIVESTAR = CONTROL ? L2.controlMode.fiveStarLow : L2.fiveStarMin;
const DUANZAO = CONTROL ? L2.controlMode.gearLow : L2.forgedGearMin;
cfg.logEffective('[api-collect]');
const run = runmeta.beginRun('api-collect', {
  out: OUT, priceMin: PRICE_MIN, priceMax: PRICE_MAX,
  browserFile: BROWSER_FILE || null, topN: TOPN, control: CONTROL,
  loginWaitMs: LOGIN_WAIT_MS
});

// 试师区服: 统一从 scripts/lib-shishi.js 读取「当前开放试师」serverid（data/shishi-open.json，
// 由 scripts/update-shishi.js 随赛季滚动更新；文件缺失时内部回退旧硬编码并提示）
const { getServerIds } = require('./lib-shishi');
const { ids: SERVERIDS, source: SERVERIDS_SRC } = getServerIds();
console.log(`[servers] ${SERVERIDS_SRC}`);
const LIST_URL = `https://stzb.cbg.163.com/cgi/mweb/pl?search_type=role&tfid=f_kingkong&baijia_hero_logic=and&dynamic_icon_hero_id_logic=and&game_compete_serverid=${SERVERIDS}&price_min=${PRICE_MIN}&price_max=${PRICE_MAX}&five_star_hero_count=${FIVESTAR}&duanzao_gear_cnt=${DUANZAO}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 等待用户按回车(用于登录/验证时停下等用户处理)
// 超时（STZB_LOGIN_WAIT_MS，默认 120 秒）后 reject，由 main 的 catch 打印清楚原因并 exit 1
function waitForEnter(prompt) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    let timer = null;
    if (LOGIN_WAIT_MS > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rl.close();
        const err = new Error(
          `等待人工完成登录/验证超时：${LOGIN_WAIT_MS}ms 内未按回车。` +
          `请先在浏览器窗口完成登录/手机验证后重跑（env STZB_LOGIN_WAIT_MS 可调大，0=不限时）。` +
          `触发场景: ${String(prompt).replace(/\n/g, ' ')}`
        );
        err.code = 'LOGIN_TIMEOUT';
        reject(err);
      }, LOGIN_WAIT_MS);
    }
    rl.question(`\n${prompt}\n完成后按回车继续 (或 Ctrl+C 退出; ${LOGIN_WAIT_MS > 0 ? `${Math.round(LOGIN_WAIT_MS / 1000)} 秒超时` : '不限时'}): `, () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rl.close();
      resolve();
    });
  });
}

// 判断接口返回是否需要登录/验证
function needLogin(msg) {
  const s = String(msg || '');
  return s.includes('更新登陆状态') || s.includes('需要验证手机') || s.includes('登录');
}

// 从 desc_sumup_short 解析 五星数/宝物数（历史函数，初筛已统一走 list-filter.passListFilter）
function parseDesc(sumup) {
  const s = String(sumup || '');
  const m5 = s.match(/(\d+)张五星武将卡/);
  const m12 = s.match(/(\d+)个稀世宝物/);
  if (!m5 && !m12) return null;
  return { star5: m5 ? parseInt(m5[1], 10) : 0, gear: m12 ? parseInt(m12[1], 10) : 0 };
}

// 从 equip_desc 构造统一结果（含数据溯源: source/capturedAt/statusKind）
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
    equips: (desc.gear || []).map(x => x.name).filter(Boolean),
    source: 'api',
    capturedAt: new Date().toISOString(),
    statusKind: cfg.classifyStatus(d.status)
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
  return { ordersn: c.ordersn, server_name: c.server_name, price: c.price, sumup: c.sumup, status: equip.status_desc || '', msg: res.msg || '', desc };
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
    const listResult = await page.evaluate(([sid, pmin, pmax, fiveStar, duanzao]) => {
      return (async () => {
        const out = { cards: [], msg: '' };
        for (let p = 1; p <= 20; p++) {
          const body = `search_type=role&count=15&view_loc=search_cond&tfid=f_kingkong&baijia_hero_logic=and&dynamic_icon_hero_id_logic=and&game_compete_serverid=${encodeURIComponent(sid)}&price_min=${pmin}&price_max=${pmax}&five_star_hero_count=${fiveStar}&duanzao_gear_cnt=${duanzao}&order_by=&page=${p}&exter=direct`;
          const res = await fetch('/cgi-bin/recommend.py?client_type=h5&act=recommd_by_role', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, credentials: 'include'
          });
          const j = await res.json();
          if (j.msg && !out.msg) out.msg = j.msg;
          const arr = j.result || [];
          for (const c of arr) out.cards.push({ ordersn: c.game_ordersn, server_name: c.server_name, price: c.price, sumup: c.desc_sumup_short || '' });
          const totalPages = j.pager ? j.pager.total_pages : 0;
          if (p >= totalPages || totalPages === 0) break;
          await new Promise(r => setTimeout(r, 800));   // 翻页间隔 800ms 防限流
        }
        return out;
      })();
    }, [SERVERIDS, PRICE_MIN, PRICE_MAX, FIVESTAR, DUANZAO]);
    cards = listResult.cards || [];
    // 登录/验证失效 → 停下等用户处理
    if (cards.length === 0 && needLogin(listResult.msg)) {
      await waitForEnter(`⚠️ 需要登录/验证手机 (${listResult.msg})\n请在打开的浏览器窗口中完成登录或手机验证`);
      // 重新加载页面刷新会话
      await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(3000);
      attempt = 0;   // 重置重试计数, 用户完成后继续
      continue;
    }
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

  // L2 初筛（data/strategy-config.json）：五星 / S战法 / 稀世宝物 / 锻造 四道门
  // 2026-10-25 起不再写死 85/12，改为配置驱动；详情前再用预筛分排序（见 prefilter.js）
  let pass = 0, skip = 0, resumed = 0, brSkip = 0;
  const skipByReason = { 'no-desc': 0, star5: 0, sTac: 0, gear: 0 };
  const todo = [];
  for (const c of cards) {
    if (done.has(c.ordersn)) { resumed++; continue; }
    if (browserSns.has(c.ordersn)) { brSkip++; continue; }
    const pf = passListFilter(c, L2);
    if (!pf.pass) { skip++; if (skipByReason[pf.reason] != null) skipByReason[pf.reason]++; continue; }
    const d = pf.desc;
    pass++;
    todo.push({ ...c, star5: d.star5, sTac: d.sTac, st: d.sTac, gear: d.gear });
  }
  // 预筛分排序: 详情预算有限时先采「最可能成队」的号，而不是五星最多的号
  sortByPrefilter(todo);
  if (TOPN > 0 && todo.length > TOPN) {
    console.log(`topN 精选: 按预筛分只采前 ${TOPN} 个 (共 ${todo.length} 个可采, 预筛分最高 ${scoreAccount(todo[0]).score})`);
    todo.length = TOPN;
  }
  console.log(`filter(L2 ${CONTROL ? 'CONTROL' : JSON.stringify({ star5: FIVESTAR, sTac: L2.sTacticMin, duanzao: DUANZAO })}): need-fetch ${todo.length} | browser-skip ${brSkip} | desc-skip ${skip} (no-desc ${skipByReason['no-desc']}, star5 ${skipByReason.star5}, sTac ${skipByReason.sTac}, gear ${skipByReason.gear}) | resumed ${resumed}`);

  // ---- 2. 详情(慢速单采 + 限流长退避 + 登录停下提醒) ----
  // 教训: 批量并发(>3) 或 密集请求 会触发藏宝阁账号级限流(eb-re410),
  //       一旦触发, 列表+详情接口同时挂掉且持续 15 分钟+。
  //       本版改为: 串行单采, 每号间隔 3-4 秒, 失败指数退避(5s/15s/30s/60s)。
  //       登录/验证失效时停下等用户处理。
  console.log('== 2/2 fetch detail (serial, 3s interval, long backoff) ==');
  const results = [...done.values()];
  let failCount = 0;
  let consecutiveFail = 0;
  for (let i = 0; i < todo.length; i++) {
    const c = todo[i];
    let ok = false;
    // 尝试: 首次 + 最多4次重试(指数退避)
    for (let attempt = 0; attempt <= 4 && !ok; attempt++) {
      if (attempt > 0) await sleep(5000 * Math.pow(2, attempt - 1));
      const d = await fetchDetail(page, c);
      // 登录/验证失效 → 停下等用户
      if (needLogin(d.msg)) {
        await waitForEnter(`⚠️ 需要登录/验证手机 (${d.msg})\n请在打开的浏览器窗口中完成登录或手机验证`);
        await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(3000);
        attempt = -1;   // 重置重试, 用户完成后继续
        continue;
      }
      if (d.desc && (d.desc.card || []).length) {
        results.push(buildResult(d));
        ok = true;
        consecutiveFail = 0;
      }
    }
    if (!ok) {
      failCount++;
      consecutiveFail++;
      console.log(`  fail: ${c.ordersn} (连续失败 ${consecutiveFail})`);
      // 连续失败 >=3 → 疑似限流, 长退避 60-120 秒
      if (consecutiveFail >= 3) {
        const waitMs = 60000 + Math.floor(Math.random() * 60000);
        console.log(`  ⚠️ 疑似限流, 暂停 ${Math.round(waitMs / 1000)} 秒...`);
        await sleep(waitMs);
        consecutiveFail = 0;
      }
    } else {
      console.log(`  ${i + 1}/${todo.length} done`);
    }
    fs.writeFileSync(OUT, JSON.stringify(results, null, 1), 'utf-8');
    await sleep(3000 + Math.floor(Math.random() * 1000));   // 每号间隔 3-4 秒
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 1), 'utf-8');
  console.log('\ndone, saved', OUT, 'total', results.length, '| detail-fail:', failCount);
  await context.close();
  return {
    list: cards.length,
    needFetch: todo.length,
    browserSkip: brSkip,
    descSkip: skip,
    descSkipByReason: skipByReason,
    resumed,
    detailFail: failCount,
    results: results.length,
    control: CONTROL
  };
}

main()
  .then(counts => { runmeta.finishRun(run, counts); })
  .catch(e => {
    runmeta.failRun(run, e);
    if (e && e.code === 'LOGIN_TIMEOUT') {
      console.error('[api-collect][login] ' + e.message);
    } else {
      console.error('FATAL:', e);
    }
    process.exit(1);
  });
