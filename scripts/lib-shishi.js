// ============================================================
// lib-shishi.js — 试师白名单统一读取入口
//
// 唯一来源:
//   data/shishi-open.json  ← scripts/update-shishi.js 生成，含「当前藏宝阁开放」的
//                            试师区服 serverid（随赛季滚动更新，免登录）
//   data/shishi-servers.json ← 全量历史试师区服（按批次，用于文档/校验）
//
// 旧硬编码只作为文件缺失时的兜底（2026-08 的 65 个，对应区服已关闭）。
// 任何采集脚本都不应再手写 serverid。
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OPEN_FILE = path.join(ROOT, 'data', 'shishi-open.json');
const SERVERS_FILE = path.join(ROOT, 'data', 'shishi-servers.json');

const LEGACY_SERVERIDS = '44748,44749,44750,44751,44752,44753,44754,44755,44761,44762,44763,44764,44765,44766,44773,44774,44775,44776,44777,44778,44779,44788,44789,44790,44791,44792,44793,44794,44804,44805,44808,44809,44810,44811,44812,44819,44820,44821,44822,44823,44824,44834,44835,44836,44837,44838,44839,44840,44841,44854,44855,44856,44857,44858,44859,44860,44861,44862,44863,44869,44870,44871,44872,44873,44874';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// 当前可筛选的试师 serverid 串。
// 返回 { ids, count, updatedAt, source }；文件缺失/损坏时回退旧硬编码并标记 legacy。
function getServerIds(file = OPEN_FILE) {
  try {
    const j = readJson(file);
    if (Array.isArray(j.openServerids) && j.openServerids.length) {
      return {
        ids: j.openServerids.join(','),
        count: j.openServerids.length,
        updatedAt: j.updatedAt || '',
        source: `data/shishi-open.json (${j.openServerids.length} 个试师, ${j.updatedAt || '?'})`
      };
    }
  } catch (e) { /* fall through to legacy */ }
  return {
    ids: LEGACY_SERVERIDS,
    count: LEGACY_SERVERIDS.split(',').length,
    updatedAt: '',
    source: 'legacy-hardcoded(已过期, 请先运行 npm run shishi)'
  };
}

// 全量历史试师区服 ID（X#### 形式），用于校验与文档
function getShishiIds(file = SERVERS_FILE) {
  const j = readJson(file);
  if (!Array.isArray(j.ids) || !j.ids.length) throw new Error(`${file} 缺少 ids`);
  return j.ids;
}

module.exports = { ROOT, OPEN_FILE, SERVERS_FILE, LEGACY_SERVERIDS, getServerIds, getShishiIds };
