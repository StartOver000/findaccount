#!/usr/bin/env node
// ============================================================
// verify-shishi.js — 找号链路「试师数据层」校验（默认离线，无需登录）
//
// 校验内容:
//   1. data/shishi-servers.json  全量试师批次（结构/排序/去重/批次覆盖/新鲜度）
//   2. data/shishi-open.json     当前开放试师 serverid（与批次、文档、txt、lib 一致）
//   3. docs/试师赛季白名单.md    自动生成标记 + 计数 + 全部 ID 覆盖
//   4. scripts/lib-shishi.js     统一读取入口能读到新文件（而非 legacy 兜底）
//   5. 采集脚本接线              api-collect / cbg-detail-extract / page-list-collect / collect.ps1 / find-all.ps1
//   6. JS 语法（node --check）与 PowerShell 语法解析
//
// 用法:
//   node scripts/verify-shishi.js          # 离线校验（CI/提交前）
//   node scripts/verify-shishi.js --live   # 额外联网执行 update-shishi.js --check，验证数据源可用
// 退出码: 0 全部通过；1 有失败项
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OPEN_FILE = path.join(ROOT, 'data', 'shishi-open.json');
const SERVERS_FILE = path.join(ROOT, 'data', 'shishi-servers.json');
const TXT_FILE = path.join(ROOT, 'data', 'shishi-open-serverids.txt');
const MD_FILE = path.join(ROOT, 'docs', '试师赛季白名单.md');
const LIB_FILE = path.join(ROOT, 'scripts', 'lib-shishi.js');
const UPDATE_FILE = path.join(ROOT, 'scripts', 'update-shishi.js');

const results = [];
function record(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
function readText(file) { return fs.readFileSync(file, 'utf-8'); }
function uniqSortedNumeric(ids) {
  const seen = new Set();
  for (const id of ids) {
    if (!/^[XS]\d+$/.test(id)) throw new Error(`非法区服 ID: ${id}`);
    if (seen.has(id)) throw new Error(`重复区服 ID: ${id}`);
    seen.add(id);
  }
  const num = s => parseInt(s.slice(1), 10);
  const sorted = [...ids].sort((a, b) => (a[0] === b[0] ? num(a) - num(b) : a[0].localeCompare(b[0])));
  return sorted.join(',') === ids.join(',');
}

// ---------- 1. 全量批次 ----------
let serverData, batchIds;
record('shishi-servers.json 结构', () => {
  assert(fs.existsSync(SERVERS_FILE), `缺少 ${SERVERS_FILE}`);
  serverData = readJson(SERVERS_FILE);
  assert(Array.isArray(serverData.ids) && serverData.ids.length >= 100, `ids 数量异常: ${serverData.ids ? serverData.ids.length : '缺失'}`);
  assert(serverData.totalRows > 0, 'totalRows 缺失/为 0');
  assert(serverData.shishiBatchCount === serverData.bySeason.length, `shishiBatchCount(${serverData.shishiBatchCount}) != bySeason.length(${serverData.bySeason.length})`);
  assert(Array.isArray(serverData.bySeason) && serverData.bySeason.length > 0, 'bySeason 为空');
  assert(uniqSortedNumeric(serverData.ids), 'ids 未按数字升序/去重排序');
  batchIds = new Set(serverData.ids);
  const seen = new Set();
  for (const b of serverData.bySeason) {
    assert(b.teamtype && b.teamtime, '批次缺少 teamtype/teamtime');
    assert(Array.isArray(b.ids) && b.ids.length > 0, `批次 ${b.teamtype} 无区服`);
    for (const id of b.ids) {
      assert(batchIds.has(id), `批次 ${b.teamtype} 含未收录区服 ${id}`);
      seen.add(id);
    }
    const ts = Date.parse(b.teamtime);
    assert(!Number.isNaN(ts), `批次时间无法解析: ${b.teamtime}`);
  }
  assert(seen.size === batchIds.size, `批次并集(${seen.size}) != ids(${batchIds.size})`);
  const ageDays = (Date.now() - Date.parse(serverData.bySeason[0].teamtime)) / 864e5;
  assert(ageDays < 180, `最新批次距今 ${Math.floor(ageDays)} 天，数据源可能停滞`);
  return `${serverData.shishiBatchCount} 批 / ${serverData.ids.length} 服，最新 ${serverData.bySeason[0].teamtime} ${serverData.bySeason[0].teamtype}`;
});

// ---------- 2. 当前开放列表 ----------
let openData;
record('shishi-open.json 结构', () => {
  assert(fs.existsSync(OPEN_FILE), `缺少 ${OPEN_FILE}`);
  openData = readJson(OPEN_FILE);
  assert(Array.isArray(openData.openServerids) && openData.openServerids.length > 0, 'openServerids 为空');
  assert(openData.count === openData.openServerids.length, `count(${openData.count}) != openServerids(${openData.openServerids.length})`);
  const sorted = [...openData.openServerids].sort((a, b) => a - b);
  assert(openData.openServerids.every((v, i) => v === sorted[i]), 'openServerids 未按数字升序/去重排序');
  for (const id of openData.openServerids) assert(Number.isInteger(id) && id > 0, `非法 serverid: ${id}`);
  assert(Array.isArray(openData.servers) && openData.servers.length === openData.openServerids.length, `servers 数量(${openData.servers ? openData.servers.length : 0}) 与 openServerids 不一致`);
  const ids = new Set(openData.openServerids);
  for (const s of openData.servers) {
    assert(Number.isInteger(s.serverid), `serverid 非数字: ${JSON.stringify(s)}`);
    assert(ids.has(s.serverid), `servers 含不在 openServerids 的 serverid: ${s.serverid}`);
    assert(s.xid && batchIds.has(s.xid), `xid ${s.xid} 不在历史试师白名单`);
  }
  assert(openData.updatedAt && !Number.isNaN(Date.parse(openData.updatedAt)), 'updatedAt 无法解析');
  return `${openData.count} 个开放试师，抓取于 ${openData.updatedAt}`;
});

record('shishi-open-serverids.txt 一致', () => {
  assert(fs.existsSync(TXT_FILE), `缺少 ${TXT_FILE}`);
  const txt = readText(TXT_FILE).trim();
  assert(txt === openData.openServerids.join(','), 'txt 与 shishi-open.json 的 openServerids 不一致');
  return `${openData.openServerids.length} 个 serverid`;
});

// ---------- 3. 文档 ----------
record('docs/试师赛季白名单.md', () => {
  assert(fs.existsSync(MD_FILE), `缺少 ${MD_FILE}`);
  const md = readText(MD_FILE);
  assert(md.includes('自动生成'), '缺少“自动生成”标记（可能仍是手写旧表）');
  assert(md.includes(`试师批次：${serverData.bySeason.length} 个`), '批次计数与 JSON 不一致');
  assert(md.includes(`试师区服：${serverData.ids.length} 个`), '区服计数与 JSON 不一致');
  const missing = serverData.ids.filter(id => !md.includes(id));
  assert(missing.length === 0, `文档缺少 ${missing.length} 个区服，如 ${missing.slice(0, 5).join(',')}`);
  if (openData && openData.openServerids.length) {
    assert(md.includes('当前开放试师区服'), '缺少“当前开放试师区服”章节');
  }
  return `${serverData.ids.length} 个区服全部覆盖`;
});

// ---------- 4. 读取入口 ----------
record('lib-shishi.js 读取新数据', () => {
  assert(fs.existsSync(LIB_FILE), '缺少 scripts/lib-shishi.js');
  const { getServerIds, getShishiIds } = require(LIB_FILE);
  const open = getServerIds();
  assert(open.source.includes('shishi-open.json'), `读取入口走了兜底: ${open.source}`);
  assert(open.ids === openData.openServerids.join(','), '读取入口返回的 serverid 与 open.json 不一致');
  assert(open.count === openData.openServerids.length, '读取入口 count 不一致');
  const full = getShishiIds();
  assert(full.length === serverData.ids.length, 'getShishiIds 与 shishi-servers.json 不一致');
  return `${open.count} 个开放试师`;
});

// ---------- 5. 采集脚本接线 ----------
record('采集脚本不再写死区服', () => {
  const wired = {
    'scripts/api-collect.js': LIB_FILE,
    'scripts/cbg-detail-extract.js': LIB_FILE,
    'scripts/page-list-collect.js': LIB_FILE
  };
  for (const [rel, lib] of Object.entries(wired)) {
    const f = path.join(ROOT, rel);
    assert(fs.existsSync(f), `缺少 ${rel}`);
    const text = readText(f);
    assert(text.includes("require('./lib-shishi')"), `${rel} 未接入 lib-shishi.js`);
    assert(!text.includes('44748,44749'), `${rel} 仍残留旧硬编码 serverid`);
  }
  const collect = readText(path.join(ROOT, 'scripts', 'collect.ps1'));
  assert(collect.includes('shishi-open.json'), 'collect.ps1 未读取 data/shishi-open.json');
  assert(collect.includes('openServerids'), 'collect.ps1 未解析 openServerids');
  const findAll = readText(path.join(ROOT, 'scripts', 'find-all.ps1'));
  assert(findAll.includes('update-shishi.js'), 'find-all.ps1 未在采集前刷新白名单');
  return 'api-collect / cbg-detail-extract / page-list-collect / collect.ps1 / find-all.ps1 均已接线';
});

// ---------- 6. 语法 ----------
record('JS 语法 (node --check)', () => {
  const files = [
    'scripts/update-shishi.js', 'scripts/lib-shishi.js', 'scripts/api-collect.js',
    'scripts/cbg-detail-extract.js', 'scripts/page-list-collect.js',
    'scripts/merge-api.js', 'scripts/strategy-eval.js', 'scripts/list-filter.js'
  ];
  const bad = [];
  for (const rel of files) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf-8' });
    if (r.status !== 0) bad.push(`${rel}: ${(r.stderr || '').split('\n')[0]}`);
  }
  assert(bad.length === 0, bad.join('; '));
  return `${files.length} 个 JS 文件通过`;
});

record('PowerShell 语法解析', () => {
  const psDir = path.join(ROOT, 'scripts');
  const files = fs.readdirSync(psDir).filter(f => f.endsWith('.ps1'));
  const bad = [];
  for (const f of files) {
    const p = path.join(psDir, f).replace(/'/g, "''");
    const cmd = `$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${p}',[ref]$t,[ref]$e) > $null; if($e -and $e.Count){$e | ForEach-Object { $_.Message }; exit 1}`;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf-8' });
    if (r.error) return `跳过（找不到 powershell: ${r.error.code}）`;
    if (r.status !== 0) bad.push(`${f}: ${(r.stdout || '').trim().split('\n')[0]}`);
  }
  assert(bad.length === 0, bad.join('; '));
  return `${files.length} 个 ps1 通过`;
});

// ---------- 7. 可选联网 ----------
if (process.argv.includes('--live')) {
  record('联网刷新 --check', () => {
    assert(fs.existsSync(UPDATE_FILE), '缺少 scripts/update-shishi.js');
    const r = spawnSync(process.execPath, [UPDATE_FILE, '--check'], { encoding: 'utf-8', timeout: 180000 });
    if (r.error) throw new Error(`执行失败: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`update-shishi --check 退出码 ${r.status}: ${(r.stderr || '').trim().slice(0, 300)}`);
    const openLine = (r.stdout || '').split('\n').find(l => l.startsWith('[open]')) || '';
    return openLine.trim();
  });
}

// ---------- 输出 ----------
for (const r of results) {
  console.log(`${r.ok ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}
const failed = results.filter(r => !r.ok);
console.log('');
console.log(`结果: ${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项失败` : ''}`);
process.exit(failed.length ? 1 : 0);
