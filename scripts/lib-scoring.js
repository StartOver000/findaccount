// ============================================================
// lib-scoring.js — 统一评估引擎（唯一实现，参数全部来自 data/strategy-config.json）
// 取代三套分散权重: plan5-core.planAccount / strategy-eval.evaluate / analyze-accounts.ps1 的权重段。
// 参数来源: lib-config.getL3() → l3_scoring.{tierWeight,onlyGearFactor,missTacticFactor,
//          missingTacticCurve,versionOverrides,skipHeroes,hardRules,gate,profiles}
// 语义要点:
//   - 武将按槽位匹配；合并单元格（木鹿/曹仁）按「候选任一命中」；
//   - 战法/宝物单元格内 A/B 表示二选一，命中任一即视为满足；
//   - 缺战法按缺口数分档（missingTacticCurve）：缺 1 ×0.7、缺 2 降一档再 ×0.6、缺 3+ 记 0；
//     同一本战法只有一张替补卡 → 每本最多救 rescueCapPerTactic 队，多出的按「缺 2」降档计；
//   - versionOverrides（如 司马懿=晋）在 evaluate(acc,teams,true) 时生效；
//   - skipHeroes 中的武将（弓诸葛）所在队伍整队跳过（账号数据里没有该武将）。
// 用法:
//   const S = require('./lib-scoring.js');
//   const teams = require('./lib-teams.js').loadTeams().teams;
//   const r = S.evaluate(acc, teams, true);
//   const plan = S.planAccount(acc, teams);
// ============================================================
'use strict';
const cfg = require('./lib-config.js');
const teamsLib = require('./lib-teams.js');

const T1PLUS = ['T0+', 'T0', 'T1'];
const nf = n => Number(Number(n).toFixed(2));
const priceOf = a => {
  // 兼容两种数据源: merge 后是元(1500-2500), API 原始文件是分(150000-250000)
  const raw = parseInt(String(a.overview && a.overview.price).replace(/,/g, ''), 10);
  return raw >= 10000 ? Math.round(raw / 100) : raw;
};
const starsOf = a => {
  if (a.list && a.list.stars) return parseInt(a.list.stars, 10);
  const m = String((a.list && a.list.sumup) || '').match(/(\d+)张五星/);
  return m ? +m[1] : null;
};
const sTacOf = a => {
  if (a.overview && a.overview.sTactics) return parseInt(a.overview.sTactics, 10);
  const m = String((a.list && a.list.sumup) || '').match(/(\d+)个S级/);
  return m ? +m[1] : null;
};
const forgedOf = a => (a.overview && a.overview.forged != null) ? parseInt(a.overview.forged, 10) : null;
const nMiss = s => (s ? String(s).split('/').filter(Boolean).length : 0);

// ---------------- 配置 ----------------
const DEFAULT_CURVE = {
  enabled: true,
  oneMissingFactor: 0.7,
  twoMissing: { tierDown: { 'T0+': 'T0', 'T0': 'T1', 'T1': 'T2-', 'T2-': 'T2-' }, factor: 0.6 },
  threePlusFactor: 0,
  rescueCapPerTactic: 1,
  extraTeamsFactor: 'twoMissing'
};
function normalizeCurve(raw) {
  const src = raw || {};
  const c = Object.assign({}, DEFAULT_CURVE, src);
  c.enabled = c.enabled !== false;
  c.twoMissing = Object.assign({}, DEFAULT_CURVE.twoMissing, src.twoMissing || {});
  c.twoMissing.tierDown = Object.assign({}, DEFAULT_CURVE.twoMissing.tierDown, (src.twoMissing && src.twoMissing.tierDown) || {});
  for (const k of ['oneMissingFactor', 'threePlusFactor']) {
    if (typeof c[k] !== 'number') throw new Error(`l3_scoring.missingTacticCurve.${k} 不是数字`);
  }
  if (typeof c.twoMissing.factor !== 'number') throw new Error('l3_scoring.missingTacticCurve.twoMissing.factor 不是数字');
  if (typeof c.rescueCapPerTactic !== 'number' || c.rescueCapPerTactic < 1) throw new Error('l3_scoring.missingTacticCurve.rescueCapPerTactic 必须 >= 1');
  if (c.extraTeamsFactor !== 'twoMissing' && c.extraTeamsFactor !== 'zero') throw new Error('l3_scoring.missingTacticCurve.extraTeamsFactor 只支持 twoMissing / zero');
  return c;
}
function getScoringConfig() {
  const l3 = cfg.getL3();
  if (!l3 || typeof l3 !== 'object') throw new Error('strategy-config.json 缺少 l3_scoring 段');
  const tierWeight = l3.tierWeight;
  if (!tierWeight || typeof tierWeight !== 'object') throw new Error('l3_scoring.tierWeight 缺失');
  return {
    tierWeight,
    onlyGearFactor: l3.onlyGearFactor != null ? l3.onlyGearFactor : 0.8,
    missTacticFactor: l3.missTacticFactor != null ? l3.missTacticFactor : 0.2,
    missingTacticCurve: normalizeCurve(l3.missingTacticCurve),
    versionOverrides: l3.versionOverrides || {},
    skipHeroes: l3.skipHeroes || [],
    hardRules: l3.hardRules || {},
    gate: l3.gate || {},
    profiles: l3.profiles || {}
  };
}
function tierScore(tier) {
  return getScoringConfig().tierWeight[tier] || 0;
}
function isT1Plus(tier) { return T1PLUS.includes(tier); }

// ---------------- 账号索引 ----------------
function buildHeroMarks(acc) {
  const m = {};
  for (const h of acc.heroes || []) {
    const mk = Array.isArray(h.marks) ? h.marks : [String(h.marks || '')];
    (m[h.name] = m[h.name] || []).push(...mk);
  }
  return m;
}
function buildIndex(acc) {
  const idx = { heroMarks: buildHeroMarks(acc), tacSet: {}, eqSet: {} };
  for (const t of acc.tactics || []) idx.tacSet[t] = true;
  for (const e of acc.equips || []) idx.eqSet[e] = true;
  return idx;
}

// ---------------- 槽位/队伍 ----------------
function ensureSlots(team) {
  if (Array.isArray(team.Slots) && team.Slots.length) return team.Slots;
  // 兼容旧结构（{Heroes,T1,T2,Equip} 扁平字符串）：尽力还原，仅用于外部旧数据
  const heroes = team.Heroes || [];
  const split = s => String(s || '').split('/').map(x => x.trim()).filter(Boolean);
  const t1 = split(team.T1), t2 = split(team.T2), eq = split(team.Equip);
  const groups = tokens => tokens.map(tok => {
    const r = teamsLib.resolveTactic(tok);
    return { label: tok, options: r.options };
  });
  const eqGroups = tokens => tokens.map(tok => {
    const r = teamsLib.resolveEquip(tok);
    return { label: tok, options: [r.name] };
  });
  // 尽量按「每名武将一组」分配；数量不匹配时把全部需求挂到第一格（旧扁平语义）
  const per = (tokens, i) => {
    if (tokens.length === heroes.length) return [tokens[i]].map(x => groups([x]?x:[])[0]).filter(Boolean);
    return i === 0 ? groups(tokens) : [];
  };
  return heroes.map((h, i) => ({
    raw: h,
    candidates: [teamsLib.normalizeHero(h)],
    second: per(t1, i),
    third: per(t2, i),
    equip: i === 0 ? eqGroups(eq) : []
  }));
}
function slotHit(slot, idx, overrideMap) {
  for (const c of slot.candidates || []) {
    const marks = idx.heroMarks[c.name];
    if (!marks) continue;
    const req = (overrideMap && overrideMap[c.name]) || c.version;
    if (!req || marks.some(mk => String(mk).includes(req))) return true;
  }
  return false;
}
function teamSkipped(team) {
  const skip = getScoringConfig().skipHeroes;
  if (!skip.length) return false;
  const names = new Set();
  for (const slot of ensureSlots(team)) for (const c of slot.candidates || []) { names.add(c.name); names.add(c.raw); }
  for (const h of team.Heroes || []) names.add(h);
  return skip.some(h => names.has(h));
}
function groupMiss(groups, set) {
  return (groups || []).filter(g => !(g.options || []).some(o => set[o]));
}

// 单队落地状态: null=武将不满足/被跳过; 否则 {TMiss,EMiss,TMissCount,EMissCount,skipped}
function teamStatus(team, idx, opts) {
  const o = opts || {};
  if (teamSkipped(team)) return { skipped: true, TMiss: '', EMiss: '', TMissCount: 0, EMissCount: 0 };
  const slots = ensureSlots(team);
  for (const slot of slots) if (!slotHit(slot, idx, o.useOverride ? getScoringConfig().versionOverrides : null)) return null;
  const missingT = [], missingE = [];
  for (const slot of slots) {
    for (const g of groupMiss(slot.second, idx.tacSet)) missingT.push(g.label);
    for (const g of groupMiss(slot.third, idx.tacSet)) missingT.push(g.label);
    for (const g of groupMiss(slot.equip, idx.eqSet)) missingE.push(g.label);
  }
  const tm = [...new Set(missingT)], em = [...new Set(missingE)];
  return {
    skipped: false,
    TMiss: tm.join('/'), EMiss: em.join('/'),
    TMissCount: tm.length, EMissCount: em.length,
    status: tm.length === 0 && em.length === 0 ? 'full' : (tm.length === 0 ? 'onlyGear' : 'missTac')
  };
}

// ---------------- 组合枚举（武将不重复，最大化总分） ----------------
function bestCombination(cand, maxK) {
  const n = cand.length;
  if (n === 0) return null;
  const maxK2 = Math.min(maxK, n);
  let best = null, bestScore = -1, combos = 0, kNow = maxK2;
  const chosen = [];
  const keysOf = c => c.HeroKeys || c.Heroes || [];
  function dfs(start, depth) {
    if (depth === kNow) {
      combos++;
      const used = new Set(); let conflict = false; let sc = 0;
      for (const ci of chosen) {
        const c = cand[ci];
        for (const h of keysOf(c)) { if (used.has(h)) { conflict = true; break; } }
        if (conflict) break;
        for (const h of keysOf(c)) used.add(h);
        sc += c.Score;
      }
      if (!conflict && sc > bestScore) { bestScore = sc; best = chosen.map(ci => cand[ci]); }
      return;
    }
    for (let i = start; i < n; i++) { chosen.push(i); dfs(i + 1, depth + 1); chosen.pop(); }
  }
  for (let k = maxK2; k >= 1; k--) {
    kNow = k;
    dfs(0, 0);
    if (bestScore >= 0) break;
  }
  return { best, bestScore, combos };
}

// ---------------- 账号规划 / 落地清单 ----------------
function planAccount(acc, teams, opts) {
  const o = opts || { useOverride: true };
  const C = getScoringConfig();
  const CURVE = C.missingTacticCurve;
  const HR = C.hardRules;
  const idx = buildIndex(acc);
  const cand = [];
  const oneMissing = [];
  for (const team of teams) {
    const st = teamStatus(team, idx, o);
    if (!st || st.skipped) continue;
    const w = C.tierWeight[team.Tier] || 0;
    const item = {
      Team: team.Team,
      Tier: team.Tier,
      Heroes: [...(team.Heroes || [])],
      HeroKeys: ensureSlots(team).map(s => (s.candidates && s.candidates[0] ? s.candidates[0].name : s.raw)),
      Score: 0,
      TMiss: st.TMiss,
      EMiss: st.EMiss,
      k: st.TMissCount
    };
    if (st.TMissCount === 0 && st.EMissCount === 0) {
      item.Score = w;
      cand.push(item);
    } else if (st.TMissCount === 0) {
      let extra = 1;
      if (HR.onlyGearManyMissing && HR.onlyGearManyMissing.tiers.includes(team.Tier) &&
        st.EMissCount >= HR.onlyGearManyMissing.minMissing) extra = HR.onlyGearManyMissing.factor;
      item.Score = nf(w * C.onlyGearFactor * extra);
      cand.push(item);
    } else if (CURVE.enabled && st.TMissCount === 1) {
      // 缺 1 本的队可能靠替补卡救回；先收集，稍后按「每本战法最多救 1 队」截断
      item.Score = nf(w * CURVE.oneMissingFactor);
      oneMissing.push(item);
    }
    // 缺 >= 2 本战法：短期补两件不现实，不进入「现有可打」阵容（仍算进 evaluate 的战力降档）
  }
  if (oneMissing.length) {
    const byTactic = new Map();
    for (const c of oneMissing) {
      if (!byTactic.has(c.TMiss)) byTactic.set(c.TMiss, []);
      byTactic.get(c.TMiss).push(c);
    }
    for (const list of byTactic.values()) {
      list.sort((a, b) => b.Score - a.Score);
      list.forEach((c, i) => { if (i < CURVE.rescueCapPerTactic) cand.push(c); });
    }
  }
  const res = bestCombination(cand, 5);
  let fullCount = 0, onlyGearCount = 0;
  for (const c of cand) {
    if (c.TMiss === '' && c.EMiss === '') fullCount++;
    else if (c.TMiss === '') onlyGearCount++;
  }
  return { cand, res, fullCount, onlyGearCount };
}

function landStatusList(acc, teams, opts) {
  const o = opts || { useOverride: true };
  const idx = buildIndex(acc);
  const full = [], onlyGear = [], missTac = [];
  for (const team of teams) {
    const st = teamStatus(team, idx, o);
    if (!st || st.skipped) continue;
    const item = { team: team.Team, tier: team.Tier, tMiss: st.TMiss, eMiss: st.EMiss, k: st.TMissCount };
    if (st.TMissCount === 0 && st.EMissCount === 0) full.push(item);
    else if (st.TMissCount === 0) onlyGear.push(item);
    else missTac.push(item);
  }
  return { full, onlyGear, missTac };
}

// ---------------- 完整评估（与旧 strategy-eval.evaluate 字段兼容） ----------------
function evaluate(acc, teams, useOverride) {
  const C = getScoringConfig();
  const HR = C.hardRules, GATE = C.gate, P = C.profiles, CURVE = C.missingTacticCurve;
  const idx = buildIndex(acc);
  const rows = [];
  let preHard = 0;
  for (const team of teams) {
    if (teamSkipped(team)) continue;
    const st = teamStatus(team, idx, { useOverride });
    if (!st || st.skipped) continue;
    preHard++;
    const tier = team.Tier;
    const w = C.tierWeight[tier] || 0;
    // 硬规则 1（legacy）：高档队缺战法 >= N 整队不计。曲线启用后由 missingTacticCurve 取代（缺 2 降档计分）。
    const hr1 = HR.highTierMissingTactics;
    if (!CURVE.enabled && w && hr1 && hr1.enabled !== false && (!hr1.tiers || hr1.tiers.includes(tier)) &&
      st.TMissCount >= hr1.minMissing) continue;
    let status, extra = 1;
    if (st.TMissCount === 0 && st.EMissCount === 0) status = 'full';
    else if (st.TMissCount === 0) {
      status = 'onlyGear';
      // 硬规则 2: 只缺宝但缺 >= N 件 → 纸面潜力降权
      if (HR.onlyGearManyMissing && HR.onlyGearManyMissing.tiers.includes(tier) &&
        st.EMissCount >= HR.onlyGearManyMissing.minMissing) extra = HR.onlyGearManyMissing.factor;
    } else status = 'missTac';
    rows.push({
      team: team.Team, tier, status, tMiss: st.TMiss, eMiss: st.EMiss,
      k: st.TMissCount, extra, factor: 0, contribution: 0, rescued: false
    });
  }

  // ---- 缺战法分级曲线：缺 1 扣分 / 缺 2 降档 / 缺 3+ 记 0；每本战法最多救 1 队 ----
  const twoContribution = tier => {
    const down = (CURVE.twoMissing.tierDown && CURVE.twoMissing.tierDown[tier]) || tier;
    return { down, value: nf((C.tierWeight[down] || 0) * CURVE.twoMissing.factor) };
  };
  const missStats = { oneMissing: 0, twoMissing: 0, threePlus: 0, rescued: 0, unrescued: 0, rescuedTeams: [] };
  const missRows = rows.filter(r => r.status === 'missTac');
  if (CURVE.enabled) {
    // 缺 1 本的队：按缺失战法分组，每组只救该组档位最高的 rescueCapPerTactic 支
    const oneByTactic = new Map();
    for (const r of missRows) {
      if (r.k !== 1) continue;
      if (!oneByTactic.has(r.tMiss)) oneByTactic.set(r.tMiss, []);
      oneByTactic.get(r.tMiss).push(r);
    }
    for (const [tactic, list] of oneByTactic) {
      list.sort((a, b) => (C.tierWeight[b.tier] || 0) - (C.tierWeight[a.tier] || 0));
      list.forEach((r, i) => {
        r.rescued = i < CURVE.rescueCapPerTactic;
        if (r.rescued) {
          missStats.rescued++;
          missStats.rescuedTeams.push({ team: r.team, tier: r.tier, tactic });
        } else missStats.unrescued++;
      });
    }
  }
  for (const r of rows) {
    const w = C.tierWeight[r.tier] || 0;
    if (r.status === 'full') {
      r.factor = 1;
      r.contribution = nf(w);
    } else if (r.status === 'onlyGear') {
      r.factor = nf(C.onlyGearFactor * r.extra);
      r.contribution = nf(w * r.factor);
    } else if (CURVE.enabled) {
      if (r.k >= 3) {
        r.factor = CURVE.threePlusFactor;
        r.contribution = nf(w * CURVE.threePlusFactor);
        missStats.threePlus++;
      } else if (r.k === 2) {
        const t = twoContribution(r.tier);
        r.tierDownTo = t.down;
        r.factor = w ? nf(t.value / w) : 0;
        r.contribution = t.value;
        missStats.twoMissing++;
      } else {
        missStats.oneMissing++;
        if (r.rescued) {
          r.factor = CURVE.oneMissingFactor;
          r.contribution = nf(w * CURVE.oneMissingFactor);
        } else if (CURVE.extraTeamsFactor === 'zero') {
          r.factor = 0;
          r.contribution = 0;
        } else {
          const t = twoContribution(r.tier);
          r.tierDownTo = t.down;
          r.factor = w ? nf(t.value / w) : 0;
          r.contribution = t.value;
        }
      }
    } else {
      // 曲线关闭：退回旧的「缺战法统一 ×missTacticFactor」口径
      r.factor = C.missTacticFactor;
      r.contribution = nf(w * C.missTacticFactor);
    }
  }

  const full = rows.filter(r => r.status === 'full');
  const onlyGear = rows.filter(r => r.status === 'onlyGear');
  const missTac = rows.filter(r => r.status === 'missTac');
  const score = nf(rows.reduce((s, r) => s + r.contribution, 0));
  const fullT1plus = full.filter(r => T1PLUS.includes(r.tier)).length;
  const onlyGearT1plus = onlyGear.filter(r => T1PLUS.includes(r.tier)).length;
  const t0OnlyGear = onlyGear.filter(r => r.tier === 'T0+' || r.tier === 'T0').length;
  const price = priceOf(acc);
  // 真成长 = T1+ 只缺宝且缺 <= N 件（补宝型只认这个）
  const growth = onlyGear.filter(r => T1PLUS.includes(r.tier) &&
    nMiss(r.eMiss) <= (GATE.alt2_baobao ? GATE.alt2_baobao.maxEquipMissingPerTeam : 2));
  const missT1plus = {
    one: missTac.filter(r => T1PLUS.includes(r.tier) && r.k === 1).length,
    rescued: missTac.filter(r => T1PLUS.includes(r.tier) && r.k === 1 && r.rescued).length,
    two: missTac.filter(r => T1PLUS.includes(r.tier) && r.k === 2).length,
    threePlus: missTac.filter(r => T1PLUS.includes(r.tier) && r.k >= 3).length
  };

  // ---- 门槛 ----
  const gatePass = fullT1plus >= GATE.minFullT1plus ||
    (fullT1plus >= GATE.alt.minFullT1plus && onlyGearT1plus >= GATE.alt.minOnlyGearT1plus);
  const baoBaoPass = !gatePass &&
    onlyGearT1plus >= GATE.alt2_baobao.minOnlyGearT1plus &&
    growth.length >= GATE.alt2_baobao.minRealGrowth;

  // ---- 溢价规则 ----
  let premiumOk = true;
  if (price > HR.premiumOver.price) {
    premiumOk = fullT1plus >= HR.premiumOver.requireFullT1plus || t0OnlyGear >= HR.premiumOver.requireT0OnlyGear;
  }

  // ---- 画像 ----
  let profile = '其他';
  if (P['即战型'] && full.length >= P['即战型'].fullMin && fullT1plus >= P['即战型'].fullT1plusMin && onlyGear.length <= P['即战型'].onlyGearMax) profile = '即战型';
  else if (P['均衡型'] && fullT1plus >= P['均衡型'].fullT1plusMin && onlyGear.length >= P['均衡型'].onlyGearMin) profile = '均衡型';
  else if (P['补宝型'] && fullT1plus <= P['补宝型'].fullT1plusMax && onlyGearT1plus >= P['补宝型'].onlyGearT1plusMin) profile = '补宝型';

  const valuePer1000 = price > 0 ? nf(score / (price / 1000)) : 0;
  const sn = String((acc.overview && acc.overview.url) || '').split('/').pop().split('?')[0];
  return {
    ordersn: sn, server: acc.list.server, price,
    stars: starsOf(acc), sTac: sTacOf(acc), forged: forgedOf(acc),
    heroCount: acc.heroCount,
    full, onlyGear, missTac, growth,
    score, valuePer1000,
    fullT1plus, onlyGearT1plus, t0OnlyGear,
    missTacticStats: missStats, missT1plus,
    gatePass, baoBaoPass, premiumOk, profile,
    preHard, hardDropped: preHard - rows.length
  };
}

module.exports = {
  T1PLUS, nf, priceOf, starsOf, sTacOf, forgedOf, nMiss,
  getScoringConfig, tierScore, isT1Plus,
  buildHeroMarks, buildIndex, ensureSlots, teamSkipped, teamStatus, bestCombination,
  planAccount, landStatusList, evaluate
};
