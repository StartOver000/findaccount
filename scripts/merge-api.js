// ============================================================
// merge-api.js — 合并数据生成 accounts-final.json(v2: API 为主, 浏览器可选增强)
// 主数据: API直采(data/accounts-api.json, ordersn唯一, 几分钟, 实时在售)
// 静态表: data/name-camp.json(武将→阵营, 唯一映射)
//          + 内置 hero_id 特判表(版本武将: 关羽蜀/魏, 曹操魏/汉, 赵云SP 等)
// 可选增强: 浏览器采集 detail 文件(显式 --browser, 或自动选「最新且未过期」的
//          data/accounts-detail-*.json)。过期文件(l0_data.maxStaleDays)一律跳过并 warn,
//          不再按文件体积猜测当前批次。
// 数据时效/provenance: 每条记录补 source(browser|api) / capturedAt(ISO) / statusKind,
//          capturedAt 优先取文件内容里的采集时间, 否则取文件 mtime。
// 去重: 统一按 ordersn(藏宝阁商品号) 唯一身份; 绝不按 server-price 去重。
// 用法:
//   node scripts/merge-api.js [--api <path>] [--browser <path>] [--out <path>]
//                             [--no-browser] [--help]
//   默认: --api data/accounts-api.json  --out data/accounts-final.json
//         --browser 自动选最新未过期的 detail 文件(没有则只用 API)
// 退出码: 0 成功, 1 失败(失败会写入 data/run-meta.json 的 failed 记录)
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./lib-config');
const runmeta = require('./lib-runmeta');

const ROOT = cfg.ROOT;
const DEFAULT_API = path.join(ROOT, 'data', 'accounts-api.json');
const DEFAULT_OUT = path.join(ROOT, 'data', 'accounts-final.json');
const NAMECAMP_FILE = path.join(ROOT, 'data', 'name-camp.json');

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

const USAGE = `用法: node scripts/merge-api.js [--api <path>] [--browser <path>] [--out <path>]
       [--no-browser] [--allow-stale] [--help]

  --api <path>       API 直采文件, 默认 data/accounts-api.json
  --browser <path>   浏览器 detail 文件(显式指定, 优先级高于自动发现)
  --out <path>       输出文件, 默认 data/accounts-final.json
  --no-browser       只用 API 数据(不自动发现浏览器文件)

说明: --browser 显式指定时不再做过期拒绝(用户明确要这份数据), 但过期会 warn,
      且每条账号的 capturedAt 如实记录该文件的实际采集时间。`;

function parseArgs(argv) {
  const opts = { api: null, browser: null, out: null, autoBrowser: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const takeValue = () => {
      if (eq >= 0) return arg.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`参数 ${key} 缺少值`);
      return v;
    };
    switch (key) {
      case '--api': opts.api = takeValue(); break;
      case '--browser': opts.browser = takeValue(); opts.autoBrowser = false; break;
      case '--out': opts.out = takeValue(); break;
      case '--no-browser': opts.autoBrowser = false; break;
      case '-h':
      case '--help': console.log(USAGE); process.exit(0); break;
      default: throw new Error(`未知参数: ${arg}\n${USAGE}`);
    }
  }
  return opts;
}

function resolvePath(p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  const fromCwd = path.resolve(process.cwd(), p);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(ROOT, p);
}

// 记录里的 ordersn: 优先 overview.url 末段(藏宝阁商品号), 兼容 list.ordersn
function ordersnOf(rec) {
  const u = rec && rec.overview && rec.overview.url ? String(rec.overview.url) : '';
  const tail = u.split('/').pop().split('?')[0];
  if (tail && /^\d{8,}-/.test(tail)) return tail;
  if (rec && rec.list && rec.list.ordersn) return String(rec.list.ordersn);
  return tail || '';
}

function readRecords(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.records)) return raw.records;
  if (raw && Array.isArray(raw.accounts)) return raw.accounts;
  throw new Error(`[merge] ${file} 不是数组(或 {records:[]})`);
}

function fileMtimeIso(file) {
  return new Date(fs.statSync(file).mtimeMs).toISOString();
}

// 文件级采集时间: 优先记录里的 capturedAt(取最大值), 否则文件 mtime
function captureTimeOf(records, file) {
  let latest = 0;
  for (const r of records) {
    const t = r && r.capturedAt ? Date.parse(r.capturedAt) : NaN;
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest ? new Date(latest).toISOString() : fileMtimeIso(file);
}

function ageDays(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

function fmtAge(iso) {
  const d = ageDays(iso);
  if (!Number.isFinite(d)) return '时间未知';
  return d >= 1 ? `${d.toFixed(1)} 天前` : `${(d * 24).toFixed(1)} 小时前`;
}

// 自动发现「最新且未过期」的浏览器 detail 文件; 过期文件跳过并告警
function discoverBrowserFile(maxStaleDays, warnings) {
  const dataDir = path.join(ROOT, 'data');
  if (!fs.existsSync(dataDir)) return null;
  const candidates = [];
  for (const name of fs.readdirSync(dataDir)) {
    if (!/^accounts-detail-.*\.json$/.test(name)) continue;
    const file = path.join(dataDir, name);
    try {
      const records = readRecords(file);
      const capturedAt = captureTimeOf(records, file);
      candidates.push({ name, file, records, capturedAt, age: ageDays(capturedAt) });
    } catch (e) {
      warnings.push(`浏览器文件不可读，已跳过: ${name} (${e.message})`);
    }
  }
  candidates.sort((a, b) => b.age - a.age); // age 小 = 新
  const fresh = candidates.filter((c) => c.age <= maxStaleDays);
  for (const c of candidates) {
    if (c.age > maxStaleDays) {
      warnings.push(
        `跳过过期浏览器文件 ${c.name}（采集于 ${c.capturedAt}，${fmtAge(c.capturedAt)}，` +
        `超过 l0_data.maxStaleDays=${maxStaleDays} 天）`
      );
    }
  }
  return fresh.length ? fresh[0] : null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const l0 = cfg.getL0();
  const l2 = cfg.getL2();
  const maxStaleDays = Number(l0.maxStaleDays);
  if (!Number.isFinite(maxStaleDays) || maxStaleDays <= 0) {
    throw new Error('[merge] l0_data.maxStaleDays 缺失或非法');
  }
  const apiFile = resolvePath(opts.api || DEFAULT_API);
  const outFile = resolvePath(opts.out || DEFAULT_OUT);
  if (!fs.existsSync(apiFile)) throw new Error(`[merge] API 文件不存在: ${apiFile}`);

  const run = runmeta.beginRun('merge', {
    api: apiFile,
    browser: null,
    out: outFile,
    maxStaleDays,
    autoBrowser: opts.autoBrowser,
  });
  const warnings = [];
  try {
    cfg.logEffective('[merge]');
    console.log(`[merge] API 文件: ${apiFile}`);
    if (!fs.existsSync(NAMECAMP_FILE)) throw new Error(`[merge] 缺少静态表: ${NAMECAMP_FILE}`);
    const nameCamp = JSON.parse(fs.readFileSync(NAMECAMP_FILE, 'utf8'));

    // ---- 1. 选浏览器增强文件(可选) ----
    let browserRecords = [];
    let browserFile = null;
    let browserCapturedAt = null;
    if (opts.browser) {
      browserFile = resolvePath(opts.browser);
      if (!fs.existsSync(browserFile)) throw new Error(`[merge] 指定的浏览器文件不存在: ${browserFile}`);
      browserRecords = readRecords(browserFile);
      browserCapturedAt = captureTimeOf(browserRecords, browserFile);
      const age = ageDays(browserCapturedAt);
      if (age > maxStaleDays) {
        // 显式指定 = 用户明确要这份数据(如离线回放 8 月旧快照): 允许合并, 但必须 warn,
        // 且每条记录的 capturedAt 如实写成该文件的实际采集时间(内容优先, 否则 mtime)。
        warnings.push(
          `显式浏览器文件已过期但按用户指定合并: ${browserFile}` +
          `（采集于 ${browserCapturedAt}，${fmtAge(browserCapturedAt)}，超过 l0_data.maxStaleDays=${maxStaleDays} 天）`
        );
      }
    } else if (opts.autoBrowser) {
      const found = discoverBrowserFile(maxStaleDays, warnings);
      if (found) {
        browserFile = found.file;
        browserRecords = found.records;
        browserCapturedAt = found.capturedAt;
        console.log(`[merge] 自动选用浏览器文件: ${found.name}（采集于 ${found.capturedAt}，${fmtAge(found.capturedAt)}）`);
      } else {
        console.log('[merge] 没有未过期的浏览器 detail 文件，仅使用 API 数据');
      }
    } else {
      console.log('[merge] --no-browser：仅使用 API 数据');
    }
    run.params.browser = browserFile;

    // ---- 2. API 直采 → final 记录 ----
    const apiRecords = readRecords(apiFile);
    const apiCapturedAt = captureTimeOf(apiRecords, apiFile);

    function campOf(h) {
      const sp = h.hero_id != null ? HERO_SPECIAL[h.hero_id] : undefined;
      if (sp) return sp;
      return nameCamp[h.name] || '';
    }

    // 浏览器已有的 ordersn: API 不再重复添加(浏览器 marks 更准)
    const browserSns = new Set(browserRecords.map(ordersnOf).filter(Boolean));
    const added = [];
    let skippedLow = 0, skippedEmpty = 0;
    for (const a of apiRecords) {
      const ordersn = ordersnOf(a) || (a.list && a.list.ordersn ? String(a.list.ordersn) : '');
      if (ordersn && browserSns.has(ordersn)) continue;
      // 重要: API card 的 quality 字段才是真实星级(quality===5 才是五星)!
      //       不能用名字白名单(star5-names)过滤——四星同名武将会混进来。
      const heroes = (a.heroes || []).filter((h) => h.quality === 5).map((h) => ({
        name: h.name,
        marks: [campOf(h) + (h.awake ? '极' : '') + (h.season === 'SP' ? 'SP' : (h.season || 'N'))]
      }));
      if (heroes.length === 0) { skippedEmpty++; continue; }
      const equips = a.equips || [];
      // 阈值单源: 五星数 >= l2_list_filter.fiveStarMin, 宝物数 >= l2_list_filter.rareEquipMin
      // (旧代码写死 85/12, 与配置 rareEquipMin=10 漂移, 会误剔 API 补采号)
      if (heroes.length < l2.fiveStarMin || equips.length < l2.rareEquipMin) { skippedLow++; continue; }
      const yuanInt = String(Math.round((a.list.price || 0) / 100));
      const yuan = yuanInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const status = (a.overview && a.overview.status) ? String(a.overview.status) : '';
      added.push({
        list: { server: a.list.server, price: yuanInt, ordersn, sumup: a.list.sumup },
        overview: { url: a.overview && a.overview.url ? a.overview.url : `https://stzb.cbg.163.com/cgi/mweb/equip/1/${ordersn}`, server: a.list.server, price: yuan, fullRed: 0, status },
        heroCount: heroes.length,
        heroes,
        tactics: a.tactics || [],
        equips,
        source: 'api',
        capturedAt: (a.capturedAt && Number.isFinite(Date.parse(a.capturedAt))) ? a.capturedAt : apiCapturedAt,
        statusKind: cfg.classifyStatus(status),
      });
    }
    console.log(`[merge] api：${apiRecords.length} 条 → 新增 ${added.length}（空详情 ${skippedEmpty} / 低于阈值 ${skippedLow}）`);

    // ---- 3. 浏览器记录补 provenance/ordersn ----
    const browserOut = [];
    for (const r of browserRecords) {
      if (!r || typeof r !== 'object') continue;
      const ordersn = ordersnOf(r);
      if (r.list && !r.list.ordersn && ordersn) r.list.ordersn = ordersn;
      if (!r.capturedAt) r.capturedAt = browserCapturedAt;
      r.source = 'browser';
      r.statusKind = cfg.classifyStatus(r.overview && r.overview.status);
      browserOut.push(r);
    }

    // ---- 4. 合并: 浏览器优先, 其余 API 追加; 统一按 ordersn 去重 ----
    const seen = new Set();
    const merged = [];
    let dupBrowser = 0, dupApi = 0, noOrdersn = 0;
    for (const rec of browserOut) {
      const sn = ordersnOf(rec);
      if (!sn) { noOrdersn++; merged.push(rec); continue; }
      if (seen.has(sn)) { dupBrowser++; continue; }
      seen.add(sn);
      merged.push(rec);
    }
    for (const rec of added) {
      const sn = ordersnOf(rec);
      if (!sn) { noOrdersn++; merged.push(rec); continue; }
      if (seen.has(sn)) { dupApi++; continue; }
      seen.add(sn);
      merged.push(rec);
    }
    if (noOrdersn) warnings.push(`有 ${noOrdersn} 条记录缺少 ordersn，无法参与去重（已保留）`);
    if (dupBrowser) warnings.push(`浏览器文件内部重复 ordersn ${dupBrowser} 条（已按首条保留）`);

    // ---- 5. 写盘 + 运行元数据 ----
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(merged, null, 1), 'utf8');

    const statusCounts = {};
    const sourceCounts = {};
    for (const rec of merged) {
      statusCounts[rec.statusKind || 'unknown'] = (statusCounts[rec.statusKind || 'unknown'] || 0) + 1;
      sourceCounts[rec.source || 'unknown'] = (sourceCounts[rec.source || 'unknown'] || 0) + 1;
    }
    console.log('[merge] 来源分布:', JSON.stringify(sourceCounts), '| 状态分布:', JSON.stringify(statusCounts));
    for (const w of warnings) console.warn('[merge][warn]', w);
    const counts = {
      api: apiRecords.length,
      browser: browserRecords.length,
      apiAdded: added.length,
      apiSkippedEmpty: skippedEmpty,
      apiSkippedLow: skippedLow,
      merged: merged.length,
      dupBrowser,
      dupApi,
      noOrdersn,
      warnings: warnings.length,
      staleSkipped: warnings.filter((w) => w.includes('过期浏览器文件') || w.includes('过期的显式浏览器文件')).length,
      sources: sourceCounts,
      statusKinds: statusCounts,
    };
    runmeta.finishRun(run, counts);
    console.log('[merge] 汇总: API', apiRecords.length, '| browser', browserRecords.length,
      '| api-added', added.length, '| merged', merged.length);
    console.log('[merge] saved:', outFile);
    return counts;
  } catch (e) {
    runmeta.failRun(run, e);
    throw e;
  }
}

try {
  main();
} catch (e) {
  console.error('[merge][fatal]', e.message);
  process.exitCode = 1;
}
