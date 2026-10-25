// ============================================================
// lib-teams.js — 榜单解析 / 武将异名归一 / 队伍库读写 单一实现
// 数据来源:
//   docs/队伍强度排行榜.md      人工榜单（权威原文）
//   data/team-aliases.json     异名 + 版本要求 + 合并单元格 + 宝物异名
//   data/tactics-map.json      战法简称 → 全名
//   data/name-camp.json        武将 → 阵营
//   data/teams.json            结构化队伍库（由 scripts/build-teams-json.js 生成）
// 用法:
//   const T = require('./lib-teams.js');
//   const { teams, source, warnings } = T.loadTeams();   // teams.json 优先, 缺失回退 md
//   const parsed = T.parseRankFile();                    // 直接解析 md（自检/生成用）
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const RANK_FILE = path.join(ROOT, 'docs', '队伍强度排行榜.md');
const TEAMS_JSON = path.join(ROOT, 'data', 'teams.json');
const ALIASES_FILE = path.join(ROOT, 'data', 'team-aliases.json');
const TACTICS_FILE = path.join(ROOT, 'data', 'tactics-map.json');
const NAME_CAMP_FILE = path.join(ROOT, 'data', 'name-camp.json');

const SCHEMA = 'stzb-teams/1';
const TIERS = ['T0+', 'T0', 'T1', 'T2-'];
const TIER_ID = { 'T0+': 'T0P', 'T0': 'T0', 'T1': 'T1', 'T2-': 'T2M' };
const CAMP_RE = /^[魏蜀吴群汉晋]$/;
const SUMMARY_RE = /^\|\s*(T0\+|T0-|T0|T1|T2-)\s*\|\s*(.+?)\s*\|\s*$/;
const TIER_HEAD_RE = /^##\s+(T0\+|T0-|T0|T1|T2-)\s*$/;
const H2_RE = /^##\s+/;
const H3_RE = /^###\s+(.+)$/;
const TABLE_RE = /^\|\s*([^|]+?)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/;
const HR_RE = /^-{3,}$/;

// ---------------- 基础工具 ----------------
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}
function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}
function fileSha1(file) {
  return sha1(fs.readFileSync(file));
}
function stripAnnotations(s) {
  // 去掉单元格里的（…）人工注释，例如 桃园问津（守拙）、杂屯/凶（图中文字待确认）
  return String(s == null ? '' : s).replace(/（[^）]*）/g, '').trim();
}
function splitCell(cell) {
  const s = stripAnnotations(cell);
  if (!s) return [];
  return s.split(/[\/／]/).map(x => x.trim()).filter(Boolean);
}

// ---------------- 配置文件（带缓存） ----------------
let _cache = null;
function clearCache() { _cache = null; }
function load() {
  if (_cache) return _cache;
  const aliases = readJson(ALIASES_FILE);
  const tactics = readJson(TACTICS_FILE);
  const nameCamp = readJson(NAME_CAMP_FILE);
  const tacticCanonical = new Set();
  for (const arr of Object.values(tactics.map || {})) for (const v of arr) tacticCanonical.add(v);
  _cache = {
    aliases,
    tactics,
    nameCamp,
    heroAliases: aliases.heroAliases || {},
    mergedCells: aliases.mergedCells || {},
    equipAliases: aliases.equipAliases || {},
    knownEquips: new Set(aliases.knownEquips || []),
    tacticMap: tactics.map || {},
    tacticCanonical,
    tacticUnresolved: tactics.unresolved || {},
    unresolvedHeroes: (aliases.unresolved && aliases.unresolved.heroes) || {},
    unresolvedEquips: (aliases.unresolved && aliases.unresolved.equips) || {}
  };
  return _cache;
}
function loadAliases() { return load().aliases; }
function loadTacticsMap() { return load().tactics; }
function loadNameCamp() { return load().nameCamp; }

// ---------------- 武将/战法/宝物归一 ----------------
function normalizeHero(raw) {
  const C = load();
  const rawName = String(raw == null ? '' : raw).trim();
  const a = C.heroAliases[rawName];
  const name = a && a.name ? a.name : rawName;
  const version = a && a.version ? a.version : null;
  let camp = (a && a.camp) || C.nameCamp[name] || null;
  if (!camp && version && CAMP_RE.test(version)) camp = version;
  return {
    raw: rawName,
    name,
    version,
    camp,
    note: a ? a.note || null : null
  };
}

function resolveTactic(token) {
  const C = load();
  const t = String(token).trim();
  if (C.tacticMap[t]) return { raw: t, options: C.tacticMap[t].slice(), known: true };
  if (C.tacticCanonical.has(t)) return { raw: t, options: [t], known: true };
  return { raw: t, options: [t], known: false };
}

function resolveEquip(token) {
  const C = load();
  const t = String(token).trim();
  const alias = C.equipAliases[t];
  const name = alias || t;
  return { raw: t, name, known: !!(alias || C.knownEquips.has(t)) };
}

// 单元格（第二/第三战法）→ 一个「需求组」：A/B 表示二选一，命中任一即可
function tacticRequirement(cell) {
  const label = stripAnnotations(cell);
  if (!label) return null;
  const options = [];
  const unknown = [];
  for (const tok of label.split(/[\/／]/).map(x => x.trim()).filter(Boolean)) {
    const r = resolveTactic(tok);
    for (const o of r.options) if (!options.includes(o)) options.push(o);
    if (!r.known) unknown.push(tok);
  }
  return { label, options, unknown };
}

function equipRequirement(cell) {
  const label = stripAnnotations(cell);
  if (!label) return null;
  const options = [];
  const unknown = [];
  for (const tok of label.split(/[\/／]/).map(x => x.trim()).filter(Boolean)) {
    const r = resolveEquip(tok);
    if (!options.includes(r.name)) options.push(r.name);
    if (!r.known) unknown.push(tok);
  }
  return { label, options, unknown };
}

// 武将单元格 → 候选武将（合并单元格「木鹿/曹仁」解析成两个候选，任一命中即可）
function heroCellCandidates(cell, ctx) {
  const C = load();
  const raw = String(cell == null ? '' : cell).trim();
  const registered = C.mergedCells[raw];
  let raws;
  if (registered) raws = registered.slice();
  else if (/[\/／]/.test(raw)) {
    raws = raw.split(/[\/／]/).map(x => x.trim()).filter(Boolean);
    if (ctx && ctx.warnings) ctx.warnings.push(`第 ${ctx.line} 行合并单元格「${raw}」未在 data/team-aliases.json 登记，已自动拆分为候选：${raws.join('、')}`);
  } else raws = [raw];
  return raws.map(normalizeHero);
}

// ---------------- 榜单 md 解析 ----------------
function parseTeamName(headingText) {
  let raw = String(headingText || '').trim();
  let tierShift = null;
  if (raw.includes('已降级')) tierShift = 'T2-';
  raw = raw.split('：').pop().trim();
  raw = raw.replace(/^\d+[.、]\s*/, '').trim();
  raw = raw.replace(/（[^）]*）/g, '').trim();
  return { name: raw, tierShift };
}

function parseRankText(md, opts) {
  const options = opts || {};
  const lines = String(md).split(/\r?\n/);
  const warnings = [];
  const summary = {};
  for (const line of lines) {
    const m = line.match(SUMMARY_RE);
    if (m) summary[m[1]] = m[2].split('、').map(x => x.trim()).filter(Boolean);
  }

  const rawTeams = [];
  const summaryOnly = [];
  let tier = '';
  let cur = null; // {tier, name, line, rows: []}
  const flush = () => {
    if (!cur) return;
    if (cur.rows.length === 3) rawTeams.push(cur);
    else if (cur.rows.length === 0) summaryOnly.push({ tier: cur.tier, name: cur.name, line: cur.line });
    else warnings.push(`第 ${cur.line} 行「${cur.name}」表格只解析到 ${cur.rows.length} 名武将（应为 3 名），已跳过`);
    cur = null;
  };

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const tm = line.match(TIER_HEAD_RE);
    if (tm) { flush(); tier = tm[1]; return; }
    if (H2_RE.test(line)) { flush(); tier = ''; return; }
    const hm = line.match(H3_RE);
    if (hm) {
      flush();
      const info = parseTeamName(hm[1]);
      const pt = info.tierShift || tier;
      const list = summary[pt];
      if (!list) warnings.push(`第 ${lineNo} 行「${info.name}」找不到对应分档的速览行（分档=${pt || '(未识别)'}）`);
      else if (!list.includes(info.name)) warnings.push(`第 ${lineNo} 行详情队名「${info.name}」不在 ${pt} 速览名单中（速览/详情不一致）`);
      if (info.name) cur = { tier: pt, name: info.name, line: lineNo, rows: [] };
      return;
    }
    if (!cur) return;
    const fm = line.match(TABLE_RE);
    if (!fm) return;
    const heroCell = fm[1].trim();
    if (heroCell === '武将' || HR_RE.test(heroCell)) return;
    cur.rows.push({ heroCell, t1: fm[2].trim(), t2: fm[3].trim(), equip: fm[4].trim(), line: lineNo });
  });
  flush();

  // ---- 归一化 + 组装 ----
  const ctx = { warnings };
  const teams = [];
  const counters = {};
  const unresolvedHeroes = new Set();
  const unresolvedTactics = new Set();
  const unresolvedEquips = new Set();
  const heroMappings = [];
  const campMissing = new Set();

  for (const rt of rawTeams) {
    const tierIdx = (counters[rt.tier] = (counters[rt.tier] || 0) + 1);
    const id = `${TIER_ID[rt.tier]}-${String(tierIdx).padStart(2, '0')}`;
    const slots = rt.rows.map(row => {
      const cands = heroCellCandidates(row.heroCell, { warnings, line: row.line });
      for (const c of cands) {
        const existing = heroMappings.find(x => x.raw === c.raw);
        if (existing) { if (existing.name !== c.name) warnings.push(`异名映射冲突：「${c.raw}」→「${existing.name}」/「${c.name}」`); }
        else heroMappings.push({ raw: c.raw, name: c.name, version: c.version, note: c.note, line: row.line });
        const unresolved = load().unresolvedHeroes[c.name] || load().unresolvedHeroes[c.raw];
        if (unresolved) unresolvedHeroes.add(c.name || c.raw);
        else if (!c.camp) campMissing.add(c.name);
      }
      const groups = list => (list || []).filter(Boolean);
      const second = groups([tacticRequirement(row.t1)]);
      const third = groups([tacticRequirement(row.t2)]);
      const equips = groups([equipRequirement(row.equip)]);
      for (const g of second.concat(third)) for (const u of g.unknown) unresolvedTactics.add(u);
      for (const g of equips) for (const u of g.unknown) unresolvedEquips.add(u);
      return { raw: row.heroCell, candidates: cands, second, third, equip: equips };
    });
    teams.push({
      id,
      tier: rt.tier,
      name: rt.name,
      sourceLine: rt.line,
      slots
    });
  }

  // ---- 自检统计 ----
  const detailByTier = {};
  for (const t of teams) detailByTier[t.tier] = (detailByTier[t.tier] || 0) + 1;
  const summaryCounts = {};
  for (const t of TIERS) summaryCounts[t] = (summary[t] || []).length;
  const totalSummary = Object.values(summaryCounts).reduce((a, b) => a + b, 0);
  const total = teams.length;

  const detailNames = new Set(teams.map(t => `${t.tier}|${t.name}`));
  const summaryOnlyNames = new Set(summaryOnly.map(t => `${t.tier}|${t.name}`));
  const missingDetail = [];
  for (const t of TIERS) for (const name of summary[t] || []) {
    const key = `${t}|${name}`;
    if (!detailNames.has(key) && !summaryOnlyNames.has(key)) missingDetail.push({ tier: t, name });
  }
  const notInSummary = [];
  const rawNames = new Set(rawTeams.map(t => `${t.tier}|${t.name}`));
  for (const t of teams) if ((summary[t.tier] || []).length && !(summary[t.tier] || []).includes(t.name)) notInSummary.push({ tier: t.tier, name: t.name });
  // 原文标题存在但表格行数异常被跳过的，也在 warnings 中

  const nameCount = {};
  for (const t of teams) nameCount[t.name] = (nameCount[t.name] || 0) + 1;
  const duplicateTeamNames = Object.keys(nameCount).filter(n => nameCount[n] > 1).map(n => ({ name: n, count: nameCount[n] }));

  if (totalSummary !== total) {
    warnings.push(`速览共 ${totalSummary} 名（T0+ ${summaryCounts['T0+']} / T0 ${summaryCounts['T0']} / T1 ${summaryCounts['T1']} / T2- ${summaryCounts['T2-']}），详情解析 ${total} 队；` +
      (summaryOnly.length ? `${summaryOnly.length} 队只有标题无配置表格（${summaryOnly.map(x => x.name).join('、')}）` : '两者不一致'));
  }
  if (duplicateTeamNames.length) warnings.push(`重名队伍：${duplicateTeamNames.map(d => d.name + '×' + d.count).join('、')}（分档/配置不同，按独立队伍计算，id 已区分）`);
  if (unresolvedHeroes.size) warnings.push(`未识别武将（账号快照中不存在的名称）：${[...unresolvedHeroes].join('、')} —— 见 data/team-aliases.json unresolved`);
  if (unresolvedTactics.size) warnings.push(`未识别战法（按原名处理，命中不到计缺失）：${[...unresolvedTactics].join('、')}`);
  if (unresolvedEquips.size) warnings.push(`未识别宝物（按原名处理）：${[...unresolvedEquips].join('、')}`);
  for (const t of summaryOnly) warnings.push(`速览/详情不一致：${t.tier}「${t.name}」只有标题，没有配置表格，无法落地匹配`);
  if (missingDetail.length) warnings.push(`速览有、详情缺失：${missingDetail.map(x => `${x.tier}·${x.name}`).join('、')}`);

  return {
    teams: teams.map(toRuntime),
    raw: {
      summary, summaryCounts, summaryOnly, missingDetail, notInSummary,
      duplicateTeamNames, heroMappings: heroMappings.map(h => ({ raw: h.raw, name: h.name, version: h.version, note: h.note })),
      unresolvedHeroes: [...unresolvedHeroes], unresolvedTactics: [...unresolvedTactics], unresolvedEquips: [...unresolvedEquips],
      campMissing: [...campMissing]
    },
    stats: {
      total, byTier: detailByTier, summaryCounts, totalSummary,
      summaryOnly: summaryOnly.length, summaryOnlyTeams: summaryOnly.map(x => ({ tier: x.tier, name: x.name })),
      missingDetail, notInSummary, duplicateTeamNames,
      unresolvedHeroes: [...unresolvedHeroes], unresolvedTactics: [...unresolvedTactics], unresolvedEquips: [...unresolvedEquips],
      campMissing: [...campMissing], heroMappings: heroMappings.length
    },
    warnings
  };
}

function parseRankFile(file) {
  const f = file || RANK_FILE;
  return parseRankText(fs.readFileSync(f, 'utf-8'));
}

// ---------------- 运行期队伍对象 ----------------
// runtime team: { id, Tier, Team, Heroes:[cellRaw...], Slots:[{raw,candidates,second,third,equip}], T1,T2,Equip(展示用扁平原文) }
function toRuntime(t) {
  const slots = t.slots;
  return {
    id: t.id,
    Tier: t.tier,
    Team: t.name,
    Heroes: slots.map(s => s.raw),
    Slots: slots,
    T1: slots.map(s => (s.second || []).map(g => g.label).join('/')).join('/'),
    T2: slots.map(s => (s.third || []).map(g => g.label).join('/')).join('/'),
    Equip: slots.map(s => (s.equip || []).map(g => g.label).join('/')).join('/')
  };
}

function heroSlotsToCandidates(hero) {
  const primary = { raw: hero.raw || hero.name, name: hero.name, version: hero.version || null, camp: hero.camp || null };
  const alternatives = (hero.alternatives || []).map(a => ({ raw: a.raw || a.name, name: a.name, version: a.version || null, camp: a.camp || null }));
  return [primary, ...alternatives];
}

// teams.json 条目 → runtime team
function teamFromJson(json) {
  const slots = (json.heroes || []).map(h => ({
    raw: h.raw || h.name,
    candidates: heroSlotsToCandidates(h),
    second: (h.tactics && h.tactics.second) || [],
    third: (h.tactics && h.tactics.third) || [],
    equip: h.equips || []
  }));
  return {
    id: json.id,
    Tier: json.tier,
    Team: json.name,
    Heroes: slots.map(s => s.raw),
    Slots: slots
  };
}

// runtime team → teams.json 条目（build-teams-json.js 使用）
function teamToJson(team) {
  const heroes = team.Slots.map(s => {
    const cands = s.candidates || [];
    const primary = cands[0] || { name: s.raw, raw: s.raw, version: null, camp: null };
    return {
      name: primary.name,
      raw: primary.raw || s.raw,
      version: primary.version || null,
      camp: primary.camp || null,
      alternatives: cands.slice(1).map(c => ({ name: c.name, raw: c.raw || c.name, version: c.version || null, camp: c.camp || null })),
      tactics: {
        second: (s.second || []).map(g => ({ label: g.label, options: g.options })),
        third: (s.third || []).map(g => ({ label: g.label, options: g.options }))
      },
      equips: (s.equip || []).map(g => ({ label: g.label, options: g.options }))
    };
  });
  const flatGroups = key => {
    const out = [];
    for (const h of heroes) for (const g of (h.tactics && h.tactics[key]) || []) for (const o of g.options) if (!out.includes(o)) out.push(o);
    return out;
  };
  const flatEquips = () => {
    const out = [];
    for (const h of heroes) for (const g of h.equips || []) for (const o of g.options) if (!out.includes(o)) out.push(o);
    return out;
  };
  return {
    id: team.id,
    tier: team.Tier,
    name: team.Team,
    heroes,
    tactics: { second: flatGroups('second'), third: flatGroups('third') },
    equips: flatEquips(),
    legacy: { T1: team.T1, T2: team.T2, Equip: team.Equip }
  };
}

// ---------------- 队伍库加载 ----------------
function loadTeams(opts) {
  const options = opts || {};
  const jsonPath = options.teamsJson || TEAMS_JSON;
  const rankFile = options.rankFile || RANK_FILE;
  const warnings = [];
  if (!options.noJson && fs.existsSync(jsonPath)) {
    try {
      const doc = readJson(jsonPath);
      if (!doc || !Array.isArray(doc.teams) || doc.teams.length === 0) throw new Error('缺少 teams 数组');
      const teams = doc.teams.map(teamFromJson);
      // 过期检测（只 warning，不阻断）
      const srcAbs = doc.sourceFile ? path.resolve(ROOT, doc.sourceFile) : rankFile;
      if (fs.existsSync(srcAbs) && doc.sourceHash) {
        const cur = fileSha1(srcAbs);
        if (cur !== doc.sourceHash) warnings.push('data/teams.json 已过期（榜单 md 已变更），建议重跑: node scripts/build-teams-json.js');
      }
      return { teams, source: 'teams.json', doc, warnings, stats: doc.stats || {} };
    } catch (e) {
      warnings.push(`data/teams.json 读取失败（${e.message}），回退解析 md`);
    }
  }
  if (!fs.existsSync(rankFile)) throw new Error(`找不到榜单文件: ${rankFile}`);
  const parsed = parseRankFile(rankFile);
  warnings.push('data/teams.json 不存在，已回退解析 docs/队伍强度排行榜.md（建议运行: node scripts/build-teams-json.js）');
  return { teams: parsed.teams, source: 'md', doc: null, warnings, stats: parsed.stats, parsed };
}

module.exports = {
  ROOT, RANK_FILE, TEAMS_JSON, ALIASES_FILE, TACTICS_FILE, NAME_CAMP_FILE, SCHEMA, TIERS, TIER_ID,
  sha1, fileSha1, stripAnnotations, splitCell,
  normalizeHero, resolveTactic, resolveEquip, tacticRequirement, equipRequirement,
  parseRankText, parseRankFile, toRuntime, teamFromJson, teamToJson, loadTeams,
  loadAliases, loadTacticsMap, loadNameCamp, clearCache
};
