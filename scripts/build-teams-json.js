#!/usr/bin/env node
// ============================================================
// build-teams-json.js — 从 docs/队伍强度排行榜.md 生成结构化队伍库 data/teams.json
// 用法:
//   node scripts/build-teams-json.js
//   node scripts/build-teams-json.js --check-accounts data/accounts-final.json
//   node scripts/build-teams-json.js --md docs/队伍强度排行榜.md --out data/teams.json
// 说明:
//   - 解析逻辑全部在 lib-teams.js（唯一实现），本脚本只负责序列化 + 自检报告；
//   - --check-accounts 输出「完全可匹配队伍数」（全部武将在 186 号账号数据中存在名称）
//     与「单账号可完全组建队伍数」（同一账号同时拥有全部武将/版本）；
//   - 生成 results 是幂等的（除 parsedAt 外），供 plan5-core 优先读取。
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const teamsLib = require('./lib-teams.js');
const cfg = require('./lib-config.js');

const ROOT = teamsLib.ROOT;

function usage() {
  console.log([
    '用法: node scripts/build-teams-json.js [选项]',
    '',
    '选项:',
    '  --md <file>                榜单 md 路径（默认 docs/队伍强度排行榜.md）',
    '  --out <file>               输出 JSON 路径（默认 data/teams.json）',
    '  --check-accounts [file]    对照账号数据统计可匹配队伍（默认 data/accounts-final.json）',
    '  --json                     以 JSON 摘要输出（便于脚本消费）',
    '  --quiet                    只输出错误',
    '  -h, --help                 显示帮助'
  ].join('\n'));
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function parseArgs(argv) {
  const opt = { md: teamsLib.RANK_FILE, out: teamsLib.TEAMS_JSON, check: null, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opt.help = true; }
    else if (a === '--md') { opt.md = resolvePath(argv[++i] || ''); }
    else if (a === '--out') { opt.out = resolvePath(argv[++i] || ''); }
    else if (a === '--check-accounts') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { opt.check = resolvePath(next); i++; }
      else opt.check = resolvePath('data/accounts-final.json');
    } else if (a === '--json') opt.json = true;
    else if (a === '--quiet') opt.quiet = true;
    else if (a.startsWith('-')) throw new Error('未知选项: ' + a);
    else throw new Error('未知参数: ' + a);
  }
  return opt;
}

// ---------------- 账号对照 ----------------
function checkAccounts(runtimeTeams, file) {
  const S = require('./lib-scoring.js');
  const accounts = JSON.parse(fs.readFileSync(file, 'utf8'));
  const universe = new Set();
  for (const acc of accounts) for (const h of acc.heroes || []) universe.add(h.name);
  const indexes = accounts.map(acc => ({ acc, idx: S.buildIndex(acc) }));

  const nameRows = [];
  const accountRows = [];
  for (const team of runtimeTeams) {
    const slots = team.Slots || [];
    const missing = [];
    for (let i = 0; i < slots.length; i++) {
      const cands = slots[i].candidates || [];
      if (!cands.some(c => universe.has(c.name))) missing.push({ slot: i, raw: slots[i].raw, candidates: cands.map(c => c.name) });
    }
    nameRows.push({ team: team.Team, tier: team.Tier, id: team.id, missing });

    let by = null;
    for (const { acc, idx } of indexes) {
      const st = S.teamStatus(team, idx, { useOverride: true });
      if (st && !st.skipped) { by = acc; break; }
    }
    if (by) {
      accountRows.push({
        team: team.Team, tier: team.Tier, id: team.id,
        server: by.list && by.list.server, price: by.overview && by.overview.price,
        url: by.overview && by.overview.url
      });
    }
  }
  const nameMatched = nameRows.filter(r => r.missing.length === 0);
  const nameUnmatched = nameRows.filter(r => r.missing.length > 0);
  return {
    file: rel(file),
    total: runtimeTeams.length,
    // 「完全可匹配」= 所有武将名称都可解析（不要求同一账号同时拥有）
    nameMatchable: nameMatched.length,
    nameMatchRate: runtimeTeams.length ? +(nameMatched.length / runtimeTeams.length).toFixed(4) : 0,
    nameUnmatched: nameUnmatched.map(r => ({
      id: r.id, team: r.team, tier: r.tier,
      missing: r.missing
    })),
    // 「单账号可完全组建」= 某个账号同时拥有全部武将（含版本标记）
    singleAccountMatchable: accountRows.length,
    singleAccountMatchRate: runtimeTeams.length ? +(accountRows.length / runtimeTeams.length).toFixed(4) : 0,
    singleAccountTeams: accountRows,
    accountCount: accounts.length
  };
}

// ---------------- 主流程 ----------------
function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) { usage(); return 0; }
  if (!fs.existsSync(opt.md)) throw new Error('榜单文件不存在: ' + rel(opt.md));

  const parsed = teamsLib.parseRankFile(opt.md);
  const teams = parsed.teams;
  const stats = parsed.stats;

  let check = null;
  if (opt.check) {
    if (!fs.existsSync(opt.check)) throw new Error('账号数据文件不存在: ' + rel(opt.check));
    check = checkAccounts(teams, opt.check);
  }

  const json = {
    schema: teamsLib.SCHEMA,
    version: 1,
    updatedAt: new Date().toISOString(),
    parsedAt: new Date().toISOString(),
    generator: 'scripts/build-teams-json.js',
    sourceFile: rel(opt.md),
    sourceHash: teamsLib.fileSha1(opt.md),
    aliasesFile: rel(teamsLib.ALIASES_FILE),
    tacticsFile: rel(teamsLib.TACTICS_FILE),
    configFingerprint: cfg.configFingerprint(),
    stats: {
      total: stats.total,
      byTier: stats.byTier,
      summaryCounts: stats.summaryCounts,
      totalSummary: stats.totalSummary,
      summaryOnly: stats.summaryOnly,
      summaryOnlyTeams: stats.summaryOnlyTeams,
      missingDetail: stats.missingDetail,
      notInSummary: stats.notInSummary,
      unknownHeroes: stats.unresolvedHeroes,
      unresolvedHeroes: stats.unresolvedHeroes,
      unresolvedTactics: stats.unresolvedTactics,
      unresolvedEquips: stats.unresolvedEquips,
      duplicateTeamNames: stats.duplicateTeamNames,
      campMissing: stats.campMissing,
      heroMappings: stats.heroMappings,
      accountCheck: check
    },
    teams: teams.map(teamsLib.teamToJson)
  };

  fs.mkdirSync(path.dirname(opt.out), { recursive: true });
  const tmp = opt.out + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, opt.out);

  if (opt.json) {
    console.log(JSON.stringify({ out: rel(opt.out), sourceHash: json.sourceHash, stats: json.stats }, null, 2));
    return 0;
  }
  if (opt.quiet) return 0;

  const L = [];
  L.push('队伍库已生成: ' + rel(opt.out));
  L.push('来源: ' + rel(opt.md) + ' (sha1 ' + json.sourceHash.slice(0, 12) + ')');
  L.push('队伍: ' + stats.total + ' 队 ' + JSON.stringify(stats.byTier));
  L.push('速览: ' + stats.totalSummary + ' ' + JSON.stringify(stats.summaryCounts) +
    ' | 详情: ' + stats.total + ' | 仅有速览无详情: ' + stats.summaryOnlyTeams.length +
    (stats.summaryOnlyTeams.length ? ' (' + stats.summaryOnlyTeams.map(t => t.tier + '·' + t.name).join('、') + ')' : ''));
  if (stats.duplicateTeamNames.length) {
    L.push('重名队伍(已分配唯一 id): ' + stats.duplicateTeamNames.map(d => d.name + '×' + d.count).join('、'));
  }
  if (stats.unresolvedHeroes.length) L.push('未识别武将(无别名/无阵营): ' + stats.unresolvedHeroes.join('、'));
  if (stats.unresolvedTactics.length) L.push('未识别战法(不在账号战法表): ' + stats.unresolvedTactics.join('、'));
  if (stats.unresolvedEquips.length) L.push('未识别宝物(不在账号宝物表): ' + stats.unresolvedEquips.join('、'));
  if (stats.campMissing.length) L.push('缺阵营武将: ' + stats.campMissing.join('、'));
  if (stats.notInSummary.length) L.push('详情有但速览无: ' + stats.notInSummary.map(t => t.tier + '·' + t.name).join('、'));
  if (stats.missingDetail.length) L.push('速览有但详情无: ' + stats.missingDetail.map(t => t.tier + '·' + t.name).join('、'));
  if (parsed.warnings.length) {
    L.push('解析告警:');
    for (const w of parsed.warnings) L.push('  - ' + w);
  }
  if (check) {
    L.push('');
    L.push('账号对照 (' + check.file + ', ' + check.accountCount + ' 号):');
    L.push('  完全可匹配队伍(名称级): ' + check.nameMatchable + '/' + check.total +
      ' (' + (check.nameMatchRate * 100).toFixed(1) + '%, 目标 ≥91/101)');
    L.push('  单账号可完全组建: ' + check.singleAccountMatchable + '/' + check.total +
      ' (' + (check.singleAccountMatchRate * 100).toFixed(1) + '%)');
    if (check.nameUnmatched.length) {
      L.push('  名称级不可匹配队伍:');
      for (const r of check.nameUnmatched) {
        L.push('    - ' + r.id + ' ' + r.team + ' [' + r.tier + '] 缺: ' +
          r.missing.map(m => m.raw + (m.candidates.join('|') !== m.raw ? '→' + m.candidates.join('|') : '')).join('、'));
      }
    }
  }
  console.log(L.join('\n'));
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error('build-teams-json 失败: ' + e.message);
  process.exitCode = 1;
}
