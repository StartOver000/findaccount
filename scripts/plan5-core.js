// ============================================================
// plan5-core.js — 榜单解析/版本校验/落地判断/5队规划 公共核心库（兼容层）
//
// 重构说明（2026-10-25）:
//   - 解析: 只保留这一份入口，实际由 lib-teams.js 完成（优先 data/teams.json，
//           缺失时回退 docs/队伍强度排行榜.md 并打 warning，别名/合并格/多选一已归一）；
//   - 评分: 由 lib-scoring.js 统一实现，参数全部来自 data/strategy-config.json 的 l3_scoring
//           （tierWeight / onlyGearFactor / missTacticFactor / versionOverrides / skipHeroes /
//            hardRules / gate / profiles），不再在 plan5-core 内硬编码权重；
//   - 旧导出 TacticMap / VersionReq / NormalizeMap 仍保留，但改为从
//     data/tactics-map.json、data/team-aliases.json 生成（单一数据源，不再两处维护）。
// 用法（向后兼容）:
//   const core = require('./plan5-core.js');
//   const teams = core.initTeams();
//   const plan = core.planAccount(acc, teams);       // { cand, res, fullCount, onlyGearCount }
//   const list = core.landStatusList(acc, teams);    // { full, onlyGear, missTac }
// ============================================================
'use strict';
const teamsLib = require('./lib-teams.js');
const scoring = require('./lib-scoring.js');

const ROOT = teamsLib.ROOT;
const RANK_FILE = teamsLib.RANK_FILE;

// ---- 旧兼容表: 从数据文件生成，保持历史消费者的访问方式 ----
const _aliases = teamsLib.loadAliases();
const _tactics = teamsLib.loadTacticsMap();
const TacticMap = {};
for (const k of Object.keys((_tactics && _tactics.map) || {})) TacticMap[k] = (_tactics.map[k] || []).slice();
const VersionReq = {};
const NormalizeMap = {};
for (const raw of Object.keys((_aliases && _aliases.heroAliases) || {})) {
  const a = _aliases.heroAliases[raw];
  if (!a) continue;
  if (a.version) VersionReq[raw] = a.version;
  if (a.name && a.name !== raw) NormalizeMap[raw] = a.name;
}

// ---- 榜单异名 → 账号标准名 ----
function normHero(name) {
  const n = String(name == null ? '' : name).trim();
  const a = _aliases.heroAliases[n];
  return (a && a.name) ? a.name : n;
}

// ---- 战法简称 → 全名命中（A/B 多选一已由 lib-teams 拆份，这里保持旧语义）----
function tacticHit(short, accTacSet) {
  const r = teamsLib.resolveTactic(short);
  const set = accTacSet || {};
  for (const o of r.options || []) if (set[o]) return true;
  return false;
}

// ---- 解析榜单（优先 data/teams.json，缺失时回退 md 并告警）----
let _teamsCache = null;
let _warned = false;
function initTeams() {
  if (_teamsCache) return _teamsCache;
  const r = teamsLib.loadTeams();
  if (!r.teams || !r.teams.length) throw new Error('未解析到任何队伍（data/teams.json 与 docs/队伍强度排行榜.md 均不可用）');
  if (!_warned) {
    _warned = true;
    if (r.source !== 'teams.json') {
      console.error('[plan5-core] 警告: data/teams.json 不可用，已回退解析 docs/队伍强度排行榜.md（建议运行: node scripts/build-teams-json.js）');
    }
    for (const w of r.warnings || []) console.error('[plan5-core] 解析告警: ' + w);
  }
  _teamsCache = r.teams;
  return _teamsCache;
}

// ---- 校验账号武将是否满足队伍武将(含版本校验) ----
function testTeamHeroes(team, heroMarks) {
  const override = scoring.getScoringConfig().versionOverrides;
  for (const slot of scoring.ensureSlots(team)) {
    let ok = false;
    for (const c of slot.candidates || []) {
      const marks = heroMarks && heroMarks[c.name];
      if (!marks) continue;
      const req = (override && override[c.name]) || c.version;
      if (!req || marks.some(mk => String(mk).includes(req))) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

// ---- 队伍落地状态（旧签名：heroMarks 表 + 战法/宝物集合对象）----
function teamLandStatus(team, heroMarks, accTac, accEq) {
  const idx = { heroMarks: heroMarks || {}, tacSet: accTac || {}, eqSet: accEq || {} };
  const st = scoring.teamStatus(team, idx, { useOverride: true });
  if (!st || st.skipped) return null;
  return { TMiss: st.TMiss, EMiss: st.EMiss, TMissCount: st.TMissCount, EMissCount: st.EMissCount };
}

// ---- 以下统一委托给 lib-scoring（唯一实现）----
const bestCombination = scoring.bestCombination;
const planAccount = scoring.planAccount;
const landStatusList = scoring.landStatusList;

module.exports = {
  ROOT, RANK_FILE,
  TacticMap, VersionReq, NormalizeMap, normHero, tacticHit,
  initTeams, testTeamHeroes, teamLandStatus, bestCombination, planAccount, landStatusList
};
