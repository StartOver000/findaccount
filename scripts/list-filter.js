// ============================================================
// list-filter.js — 列表阶段初筛（L2）公共逻辑
// 依据 data/strategy-config.json 的 l2_list_filter（单源，经 lib-config.js 读取）:
//   解析 CBG 列表卡的 desc_sumup_short:
//   "118张五星武将卡 23个S级战法 14个稀世宝物"
// 注意: 锻造数(duanzao) 只能靠服务端筛选参数, desc 里没有, 客户端无法复核。
// 用法:
//   const { parseDesc, passListFilter, loadL2 } = require('./list-filter.js');
//   const l2 = loadL2();
//   const r = passListFilter(card, l2);   // { pass, reason, desc }
// 反证实验: 环境变量 FUNNEL_CONTROL=1 时按 l2_list_filter.controlMode 放宽
//   （默认 70<=五星<85 或 5<=稀世<12，采对照样本用）。配置缺失时直接报错，不再静默回退。
// ============================================================
const cfgLib = require('./lib-config.js');

const CONTROL = process.env.FUNNEL_CONTROL === '1';

// 读 L2 配置；FUNNEL_CONTROL=1 时必须存在 l2_list_filter.controlMode
function loadL2() {
  const l2 = cfgLib.getL2();
  let controlMode = null;
  if (CONTROL) {
    controlMode = l2.controlMode;
    const keys = ['fiveStarLow', 'fiveStarHigh', 'gearLow', 'gearHigh'];
    const bad = keys.filter(k => !controlMode || typeof controlMode[k] !== 'number');
    if (bad.length) {
      throw new Error(`[list-filter] FUNNEL_CONTROL=1 但 data/strategy-config.json 的 l2_list_filter.controlMode 缺少数字字段: ${bad.join(', ')}`);
    }
  }
  return { ...l2, control: CONTROL, controlMode };
}

// 解析 desc_sumup_short → { star5, sTac, gear }；无任何字段时返回 null
function parseDesc(sumup) {
  const s = String(sumup || '');
  const mStars = s.match(/(\d+)张五星/);
  const mTac = s.match(/(\d+)个S级战法/);
  const mGear = s.match(/(\d+)个稀世宝物/);
  if (!mStars && !mTac && !mGear) return null;
  return {
    star5: mStars ? parseInt(mStars[1], 10) : 0,
    sTac: mTac ? parseInt(mTac[1], 10) : 0,
    gear: mGear ? parseInt(mGear[1], 10) : 0
  };
}

// L2 初筛：返回是否通过 + 原因（便于日志统计"筛掉了什么"）
function passListFilter(card, l2) {
  const cfg = l2 || loadL2();
  const desc = parseDesc(card && card.sumup);
  if (!desc) return { pass: false, reason: 'no-desc', desc: null };
  if (cfg.control) {
    // 对照样本: 按配置采低星或低稀世的号（其余条件沿用）
    const cm = cfg.controlMode;
    const lowStar = desc.star5 >= cm.fiveStarLow && desc.star5 < cm.fiveStarHigh;
    const lowGear = desc.gear >= cm.gearLow && desc.gear < cm.gearHigh;
    if (!lowStar && !lowGear) return { pass: false, reason: 'control-out', desc };
    return { pass: true, reason: 'control', desc };
  }
  if (desc.star5 < cfg.fiveStarMin) return { pass: false, reason: 'star5', desc };
  if (desc.sTac < cfg.sTacticMin) return { pass: false, reason: 'sTac', desc };
  if (desc.gear < cfg.rareEquipMin) return { pass: false, reason: 'gear', desc };
  return { pass: true, reason: 'ok', desc };
}

module.exports = { loadL2, parseDesc, passListFilter, CONTROL };
