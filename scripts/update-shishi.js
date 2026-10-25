#!/usr/bin/env node
// ============================================================
// update-shishi.js — 自动更新「试师赛季区服白名单」
//
// 数据源（网易官方 H5「告示板」的数据文件，无需登录）:
//   https://w.163.com/h5/stzb/gg/data/teamData.json
//   （同目录另有 newSeverData / combinedServiceData / newOtherSeverData）
//   该文件由官方持续刷新（响应头 Last-Modified 即更新时间，通常每小时级别）。
//   备用源：https://www.163hot.net/st/bulletin/v2/teamData/page（分页 POST）
//
// 原理：teamData 记录每次「分区/组队」计划，字段 teamtype 形如
//   "百业争鸣(试师)" / "金印紫绶(小赛季)(试师)"，teamid 形如 "X6137,X6138,..."
//   只要 teamtype 含「试师」，其 teamid 里的区服即为试师区服。
//
// 用法:
//   node scripts/update-shishi.js              # 抓取并重写 data/shishi-servers.json + docs/试师赛季白名单.md
//   node scripts/update-shishi.js --check      # 只比对不写文件（用于定时巡检/流水线前检查）
//   node scripts/update-shishi.js --json       # 只输出 JSON 到 stdout
//   node scripts/update-shishi.js --force-api  # 跳过静态 JSON，强制走备用接口（验证回退链路）
//   node scripts/update-shishi.js --allow-stale # 允许写入 60 天未更新的数据（仅排障用，正常不要加）
//
// 注意：备用接口 www.163hot.net 已于 2026-05 停止更新（实测最新批次 2026/5/06），
//       静态 JSON 失败时它会因「数据过旧」被安全校验拦下，避免写入残缺白名单。
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_JSON = path.join(ROOT, 'data', 'shishi-servers.json');
const OUT_MD = path.join(ROOT, 'docs', '试师赛季白名单.md');
const OUT_OPEN = path.join(ROOT, 'data', 'shishi-open.json');
const OUT_TXT = path.join(ROOT, 'data', 'shishi-open-serverids.txt');
const STATIC_URL = 'https://w.163.com/h5/stzb/gg/data/teamData.json';
const API_URL = 'https://www.163hot.net/st/bulletin/v2/teamData/page';
const CBG_SERVER_URL = 'https://cbg-stzb.res.netease.com/js/game_compete_server_list.js';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://w.163.com/h5/stzb/gg/index.html' };
const FETCH_TIMEOUT_MS = 20000;

function log(...a) { if (!process.argv.includes('--quiet')) console.log(...a); }

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 网络请求带一次重试（瞬时抖动不至于让整条流水线失败）
async function request(url, opts = {}, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchWithTimeout(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

// 原子写：先写临时文件再 rename，避免中断留下半截文件
function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

async function fetchStatic() {
  const res = await request(STATIC_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`static HTTP ${res.status}`);
  const text = await res.text();
  const lastModified = res.headers.get('last-modified');
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('static JSON 不是数组');
  return { rows: arr, lastModified, source: STATIC_URL };
}

async function fetchApi() {
  // 原始接口：POST {opt:{page,pageSize}}，按 teamtime 倒序分页
  const rows = [];
  for (let page = 0; page < 50; page++) {
    const res = await request(API_URL, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ opt: { page, pageSize: 200 } })
    });
    if (!res.ok) throw new Error(`api HTTP ${res.status}`);
    const json = await res.json();
    const data = (json && json.data) || [];
    rows.push(...data);
    if (data.length < 200) break;
  }
  if (!rows.length) throw new Error('api 返回空数据');
  return { rows, lastModified: new Date().toISOString(), source: API_URL };
}

function normalizeId(raw) {
  const s = String(raw || '').trim().toUpperCase();
  const m = s.match(/^([XS])(\d+)$/);
  return m ? m[1] + m[2] : null;
}

// 藏宝阁当前开放区服列表（game_compete_server_list.js，无需登录）
// 返回 [{ serverid, xid, server_name, area_name }]，仅征服/备战区（含在售号的区服）
async function fetchCbgServers() {
  const res = await request(CBG_SERVER_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`cbg HTTP ${res.status}`);
  const text = await res.text();
  const m = text.match(/var\s+server_data\s*=\s*(\{[\s\S]*\})\s*;/);
  if (!m) throw new Error('cbg server_data 解析失败');
  const data = JSON.parse(m[1]);
  const out = [];
  for (const area of Object.values(data)) {
    for (const s of (area && area.servers) || []) {
      const xid = (String(s.server_name || '').match(/^(X\d+)/) || [])[1] || null;
      out.push({ serverid: s.game_serverid || s.serverid, xid, server_name: s.server_name, area_name: area.area_name });
    }
  }
  return out;
}

function extractShishi(rows) {
  const bySeason = [];
  const idSet = new Set();
  for (const r of rows) {
    const type = String(r.teamtype || '');
    if (!type.includes('试师')) continue;
    const ids = String(r.teamid || '').split(/[;,，、\s]+/).map(normalizeId).filter(Boolean);
    if (!ids.length) continue;
    ids.forEach(id => idSet.add(id));
    bySeason.push({ teamtype: type, teamtime: String(r.teamtime || '').trim(), ids });
  }
  // 去重（同一批次可能重复出现），按时间新→旧排序
  const seen = new Set();
  const uniq = [];
  for (const b of bySeason) {
    const key = b.teamtype + '|' + b.teamtime + '|' + b.ids.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(b);
  }
  const ts = s => { const t = Date.parse(String(s).trim()); return Number.isNaN(t) ? 0 : t; };
  uniq.sort((a, b) => ts(b.teamtime) - ts(a.teamtime));
  const ids = [...idSet].sort((a, b) => {
    const na = parseInt(a.slice(1), 10), nb = parseInt(b.slice(1), 10);
    return a[0] === b[0] ? na - nb : a[0].localeCompare(b[0]);
  });
  return { ids, bySeason: uniq };
}

// X5773-X5791 -> 展开
function expandRanges(text) {
  const out = new Set();
  const re = /([XS])(\d+)\s*[-–—~至]\s*([XS])?(\d+)/g;
  let m;
  while ((m = re.exec(text))) {
    const prefix = m[1];
    const from = parseInt(m[2], 10), to = parseInt(m[4], 10);
    for (let i = from; i <= to; i++) out.add(prefix + i);
  }
  return out;
}

function compressRanges(ids) {
  const nums = ids.map(id => ({ p: id[0], n: parseInt(id.slice(1), 10) }))
    .sort((a, b) => a.p === b.p ? a.n - b.n : a.p.localeCompare(b.p));
  const parts = [];
  let start = null, prev = null;
  for (const x of nums) {
    if (start === null) { start = prev = x; continue; }
    if (x.p === prev.p && x.n === prev.n + 1) { prev = x; continue; }
    parts.push(start.n === prev.n ? `${start.p}${start.n}` : `${start.p}${start.n}-${start.p}${prev.n}`);
    start = prev = x;
  }
  if (start) parts.push(start.n === prev.n ? `${start.p}${start.n}` : `${start.p}${start.n}-${start.p}${prev.n}`);
  return parts;
}

function buildMd(data, oldIds) {
  const lines = [];
  lines.push('# 试师赛季白名单');
  lines.push('');
  lines.push('> 用于藏宝阁筛选条件，只找这些赛季内的账号。');
  lines.push('>');
  lines.push(`> 本文件由 \`node scripts/update-shishi.js\` 自动生成，请勿手改。`);
  lines.push(`> 数据源：${STATIC_URL}`);
  lines.push(`> 抓取时间：${data.updatedAt}　官方数据时间：${data.lastModified || '未知'}`);
  lines.push(`> 试师批次：${data.bySeason.length} 个　试师区服：${data.ids.length} 个`);
  lines.push('');
  lines.push('## 按批次（新→旧）');
  lines.push('');
  for (const b of data.bySeason) {
    lines.push(`- ${b.teamtime || '?'}　${b.teamtype}　${compressRanges(b.ids).join(', ')}`);
  }
  // 旧白名单中已被新数据覆盖/缺失的部分（仅提示，不参与筛选）
  if (oldIds && oldIds.size) {
    const missing = [...oldIds].filter(id => !data.ids.includes(id)).sort();
    lines.push('');
    lines.push('## 校验');
    lines.push('');
    lines.push(`- 旧白名单中的区服：${oldIds.size} 个；新数据未覆盖：${missing.length} 个${missing.length ? '（' + missing.join(', ') + '）' : ''}`);
  }
  lines.push('');
  lines.push('## 当前开放试师区服（藏宝阁在售）');
  lines.push('');
  if (data.openServers && data.openServers.length) {
    lines.push(`共 ${data.openServers.length} 个（serverid 供脚本筛选）：`);
    lines.push('');
    lines.push(data.openServers.map(s => `${s.xid}(${s.serverid})`).join(', '));
    lines.push('');
    lines.push('可直接使用的 serverid 串：');
    lines.push('');
    lines.push('```');
    lines.push(data.openServerids.join(','));
    lines.push('```');
  } else {
    lines.push('未获取到藏宝阁区服列表（接口异常），本次跳过。');
  }
  lines.push('');
  lines.push('## 全部区服 ID');
  lines.push('');
  lines.push(data.ids.join(', '));
  lines.push('');
  return lines.join('\n');
}

// 数据合理性校验：异常时抛错，避免把坏数据写进白名单
// 试师约两周一个批次；超过 60 天没有新批次基本可判定数据源停滞（如备用接口已停更）
function assertSanity(ids, bySeason, allowStale) {
  if (ids.length < 100) throw new Error(`试师区服仅 ${ids.length} 个（<100），疑似数据源异常`);
  const newest = bySeason[0];
  const ts = Date.parse(newest ? newest.teamtime : '');
  const ageDays = Number.isNaN(ts) ? Infinity : (Date.now() - ts) / 864e5;
  if (ageDays > 60 && !allowStale) {
    throw new Error(`最新试师批次（${newest ? newest.teamtime : '?'}）距今 ${Math.floor(ageDays)} 天，数据源可能已停更；如确认无误可加 --allow-stale`);
  }
  return ageDays;
}

async function main() {
  const check = process.argv.includes('--check');
  const jsonOnly = process.argv.includes('--json');
  const forceApi = process.argv.includes('--force-api');
  const allowStale = process.argv.includes('--allow-stale');
  let src;
  if (forceApi) {
    log('[source] --force-api，跳过静态 JSON');
    src = await fetchApi();
  } else {
    try {
      src = await fetchStatic();
      log(`[source] 静态 JSON 成功（Last-Modified: ${src.lastModified || '未知'}）`);
    } catch (e) {
      log(`[source] 静态 JSON 失败（${e.message}），回退原始接口…`);
      src = await fetchApi();
    }
  }
  const { ids, bySeason } = extractShishi(src.rows);
  if (!ids.length) throw new Error('未解析到任何试师区服，数据格式可能已变');
  const ageDays = assertSanity(ids, bySeason, allowStale);
  if (ageDays > 30) log(`[warn] 最新试师批次距今 ${Math.floor(ageDays)} 天，建议核对数据源`);

  // 与藏宝阁当前开放区服求交集，得到「现在就能买到」的试师区服 serverid
  let openServers = [];
  try {
    const all = await fetchCbgServers();
    openServers = all.filter(s => s.xid && ids.includes(s.xid));
  } catch (e) {
    log(`[cbg] 区服列表获取失败（${e.message}），跳过开放区服统计`);
  }
  const openServerids = [...new Set(openServers.map(s => s.serverid))].sort((a, b) => a - b);

  const oldIds = fs.existsSync(OUT_MD) ? expandRanges(fs.readFileSync(OUT_MD, 'utf-8')) : new Set();
  const data = {
    updatedAt: new Date().toISOString(),
    lastModified: src.lastModified,
    source: src.source,
    totalRows: src.rows.length,
    shishiBatchCount: bySeason.length,
    ids,
    bySeason,
    openServerids,
    openServers
  };

  if (jsonOnly) { console.log(JSON.stringify(data, null, 2)); return; }

  log(`[result] 批次 ${bySeason.length}，区服 ${ids.length}，范围 ${ids[0]} ~ ${ids[ids.length - 1]}`);
  const newest = bySeason[0];
  log(`[newest] ${newest.teamtime} ${newest.teamtype} → ${newest.ids.join(',')}`);
  if (openServerids.length) log(`[open] 藏宝阁当前开放试师 ${openServerids.length} 个 → ${openServerids.join(',')}`);
  if (oldIds.size) {
    const missing = [...oldIds].filter(id => !ids.includes(id));
    log(`[verify] 旧白名单 ${oldIds.size} 个，新数据缺失 ${missing.length}${missing.length ? '：' + missing.join(',') : ''}`);
  }

  if (check) {
    log('[check] 未写入文件');
    return;
  }
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, JSON.stringify(data, null, 2));
  atomicWrite(OUT_MD, buildMd(data, oldIds));
  atomicWrite(OUT_OPEN, JSON.stringify({
    updatedAt: data.updatedAt,
    source: CBG_SERVER_URL,
    count: openServerids.length,
    openServerids,
    servers: openServers
  }, null, 2));
  atomicWrite(OUT_TXT, openServerids.join(',') + '\n');
  log(`[write] ${path.relative(ROOT, OUT_JSON)}`);
  log(`[write] ${path.relative(ROOT, OUT_MD)}`);
  log(`[write] ${path.relative(ROOT, OUT_OPEN)}`);
  log(`[write] ${path.relative(ROOT, OUT_TXT)}`);
}

main().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
