// ============================================================
// lib-config.js — 策略配置单源（Node 侧）
//
// 所有脚本禁止再写死筛选/评分阈值：统一 require('./lib-config')。
// 配置缺失或字段缺失时直接抛错（fail-closed），不再静默回退旧默认值。
// 环境变量 STZB_CONFIG 可指定配置路径（测试用）。
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'data', 'strategy-config.json');

let cache = null;
let cachePath = '';

function resolveConfigPath(p) {
  if (p) return path.resolve(p);
  if (process.env.STZB_CONFIG) return path.resolve(process.env.STZB_CONFIG);
  return DEFAULT_CONFIG_PATH;
}

function loadConfig(p) {
  const file = resolveConfigPath(p);
  if (cache && cachePath === file) return cache;
  if (!fs.existsSync(file)) {
    throw new Error(`[config] 找不到策略配置：${file}（期望 data/strategy-config.json）`);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`[config] 解析失败 ${file}: ${e.message}`);
  }
  if (!cfg.l2_list_filter) throw new Error('[config] 缺少 l2_list_filter 段');
  if (!cfg.l3_scoring || !cfg.l3_scoring.tierWeight) throw new Error('[config] 缺少 l3_scoring.tierWeight');
  cache = cfg;
  cachePath = file;
  return cfg;
}

function reload(p) {
  cache = null;
  cachePath = '';
  return loadConfig(p);
}

function getSection(name, p) {
  const cfg = loadConfig(p);
  const sec = cfg[name];
  if (!sec || typeof sec !== 'object') throw new Error(`[config] 缺少 ${name} 段`);
  return sec;
}

function getL0(p) { return getSection('l0_data', p); }
function getL1(p) { return getSection('l1_pool', p); }
function getL2(p) {
  const l2 = getSection('l2_list_filter', p);
  for (const k of ['fiveStarMin', 'sTacticMin', 'forgedGearMin', 'rareEquipMin', 'detailBudget']) {
    if (typeof l2[k] !== 'number' || !Number.isFinite(l2[k])) {
      throw new Error(`[config] l2_list_filter.${k} 缺失或不是数字`);
    }
  }
  return l2;
}
function getL3(p) { return getSection('l3_scoring', p); }
function getL4(p) { return getSection('l4_manual_check', p); }

function getTierWeight(p) {
  const tw = getL3(p).tierWeight;
  if (!tw || typeof tw !== 'object' || !Object.keys(tw).length) {
    throw new Error('[config] l3_scoring.tierWeight 为空');
  }
  return tw;
}

// 列表阶段预筛分权重：kind = 'full'（默认，含锻造项） | 'noForged'（API 列表无锻造数）
function getPrefilterWeights(kind, p) {
  const l2 = getL2(p);
  const pf = l2.prefilter || {};
  const key = kind === 'noForged' || kind === 'no_forged' ? 'weightsNoForged' : 'weights';
  const w = pf[key];
  if (!w || typeof w !== 'object') throw new Error(`[config] l2_list_filter.prefilter.${key} 缺失`);
  return w;
}

function configFingerprint(p) {
  const file = resolveConfigPath(p);
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
}

function effectiveSummary(p) {
  const l2 = getL2(p);
  const tw = getTierWeight(p);
  const twText = Object.entries(tw).map(([k, v]) => `${k}${v}`).join('/');
  return [
    `五星≥${l2.fiveStarMin}`,
    `S战法≥${l2.sTacticMin}`,
    `锻造≥${l2.forgedGearMin}`,
    `稀世≥${l2.rareEquipMin}`,
    `详情预算${l2.detailBudget}`,
    `tier权重 ${twText}`,
    `config ${configFingerprint(p)}`,
  ].join(' | ');
}

function logEffective(prefix) {
  console.log(`${prefix || '[config]'} 生效参数：${effectiveSummary()}`);
}

// 把藏宝阁页面/接口里的状态文本归一化为 onSale / publicity / sold / delisted / other / unknown
function classifyStatus(text, p) {
  const labels = getL0(p).statusLabels || {};
  const t = String(text == null ? '' : text).trim();
  if (!t) return 'unknown';
  for (const [kind, list] of Object.entries(labels)) {
    if ((list || []).some((label) => t.includes(label))) return kind;
  }
  return 'other';
}

module.exports = {
  ROOT,
  DEFAULT_CONFIG_PATH,
  resolveConfigPath,
  loadConfig,
  reload,
  getL0,
  getL1,
  getL2,
  getL3,
  getL4,
  getTierWeight,
  getPrefilterWeights,
  configFingerprint,
  effectiveSummary,
  logEffective,
  classifyStatus,
};
