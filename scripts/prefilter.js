// ============================================================
// prefilter.js — 列表阶段「预筛分」：决定详情抓取顺序（L2.5）
//
// 背景（2026-10-25，见 reports/筛选条件策略-20261025/筛选条件分析.md）:
//   - 对 117 个有列表字段的已采账号做回归，落地战力与列表字段相关度：
//     S级战法 0.51 > 价格 0.36 > 已锻造 0.21 > 五星 0.19 > 稀世宝物 0.05
//   - 固定详情预算时，按「预测战力」排序比按「五星数」排序多抓到 2-3 倍候选；
//     6 个候选里有 1 个只有 85 星（星级门槛会直接误杀）
//   - 公式: 预测战力 ≈ -36 + 1.3×S战法 + 0.3×已锻造 + 0.03×五星 + 6.0×价格(千元)
//     五折交叉验证 R²≈0.24，Top10 覆盖 5/6 候选（样本仅 6 个正例，只用于排序，不用于硬淘汰）
//
// 用法:
//   const { scoreAccount, sortByPrefilter, loadWeights } = require('./prefilter.js');
//   sortByPrefilter(todo);   // 就地降序排序（高优先在前）
//   scoreAccount({ stars: 110, st: 22, forged: 18, price: 199900 }).score
//
// 字段兼容:
//   五星: stars / star5      S战法: st / sTac
//   已锻造: forged / eq / duanzao
//   价格: '分'(藏宝阁列表 150000) 或 '元'(merge 后 1500) 自动识别
//
// 权重唯一来源 data/strategy-config.json 的 l2_list_filter.prefilter：
//   weights（含锻造项）/ weightsNoForged（API 列表拿不到锻造数时）。
// 2026-10-25 起经 lib-config 读取且 fail-closed：缺配置/缺权重直接抛错，
// 不再保留静默默认值（A7：删除静默回退）。
// ============================================================
'use strict';

const { getPrefilterWeights } = require('./lib-config');

function loadWeights() {
  return getPrefilterWeights('full');
}

function loadNoForgedWeights() {
  return getPrefilterWeights('noForged');
}

function num(v) {
  const n = Number(String(v == null ? '' : v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return num(obj[k]);
  }
  return 0;
}

// 藏宝阁列表/API 用「分」，merge 后用「元」；>10000 视为分
function priceYuan(v) {
  const n = num(v);
  return n > 10000 ? n / 100 : n;
}

function scoreAccount(a, w) {
  const stars = pick(a, ['stars', 'star5']);
  const st = pick(a, ['st', 'sTac', 'stTac']);
  const hasForged = !!(a && ('forged' in a || 'eq' in a || 'duanzao' in a));
  const forged = pick(a, ['forged', 'eq', 'duanzao']);
  const price = priceYuan(a && a.price);
  const ww = w || (hasForged ? loadWeights() : loadNoForgedWeights());
  const score = +(ww.intercept + ww.st * st + ww.forged * forged + ww.stars * stars + ww.pricePer1000 * (price / 1000)).toFixed(2);
  return { score, features: { stars, st, forged, price } };
}

function sortByPrefilter(cards, w) {
  return cards.sort((a, b) => scoreAccount(b, w).score - scoreAccount(a, w).score);
}

module.exports = { loadWeights, loadNoForgedWeights, priceYuan, scoreAccount, sortByPrefilter };
