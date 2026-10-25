// ============================================================
// verify-core.js — 核心离线回归测试（npm test 的第二部分）
//
// 覆盖：配置单源、运行元数据、队伍库结构、采集脚本接线、ps1 BOM/语法。
// 完全离线，不访问网络、不读写 data/accounts-*.json。
// 用法：node scripts/verify-core.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.error(`FAIL ${name}: ${e.message}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function walkFiles(dir, suffix, out) {
  const acc = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, suffix, acc);
    else if (entry.name.endsWith(suffix)) acc.push(p);
  }
  return acc;
}

// ---------- 1. 配置单源 ----------
test('配置：l0/l2/l3 段齐全且数值合法', () => {
  const cfg = require('./lib-config');
  const l0 = cfg.getL0();
  assert(l0 && Array.isArray(l0.excludeFromRecommend), 'l0_data.excludeFromRecommend 缺失');
  const l2 = cfg.getL2();
  for (const k of ['fiveStarMin', 'sTacticMin', 'forgedGearMin', 'rareEquipMin', 'detailBudget']) {
    assert(typeof l2[k] === 'number', `l2.${k} 不是数字`);
  }
  const tw = cfg.getTierWeight();
  assert(tw['T0+'] > 0 && tw.T0 > 0, 'tierWeight 缺失关键档位');
  assert(cfg.getPrefilterWeights('full').st > 0, 'prefilter.weights 异常');
  assert(cfg.getPrefilterWeights('noForged').st > 0, 'prefilter.weightsNoForged 异常');
});

test('配置：状态归一化 classifyStatus', () => {
  const cfg = require('./lib-config');
  assert(cfg.classifyStatus('上架中') === 'onSale', '上架中');
  assert(cfg.classifyStatus('公示期') === 'publicity', '公示期');
  assert(cfg.classifyStatus('已售出') === 'sold', '已售出');
  assert(cfg.classifyStatus('已下架') === 'delisted', '已下架');
  assert(cfg.classifyStatus('') === 'unknown', '空状态');
});

test('配置：fingerprint 与生效参数可用', () => {
  const cfg = require('./lib-config');
  assert(/^[0-9a-f]{8}$/.test(cfg.configFingerprint()), '指纹格式错误');
  const text = cfg.effectiveSummary();
  assert(text.includes('五星') && text.includes('tier权重'), '生效参数摘要缺字段');
});

// ---------- 2. 运行元数据 ----------
test('runmeta：begin/finish/fail 往返一致', () => {
  const meta = require('./lib-runmeta');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stzb-runmeta-'));
  const file = path.join(tmp, 'run-meta.json');
  try {
    const run = meta.beginRun('verify', { n: 1 }, file);
    assert(run.runId && run.status === 'running', 'beginRun 异常');
    meta.finishRun(run, { count: 3 }, file);
    const after = meta.readMeta(file);
    assert(after.lastRun.status === 'ok', 'finishRun 状态未落盘');
    assert(after.lastRun.counts.count === 3, 'counts 未落盘');
    assert(after.history.length === 1, 'history 未写入');
    const run2 = meta.beginRun('verify2', {}, file);
    meta.failRun(run2, new Error('boom'), file);
    const after2 = meta.readMeta(file);
    assert(after2.lastRun.status === 'failed' && /boom/.test(after2.lastRun.error), 'failRun 异常');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 3. 队伍库（data/teams.json） ----------
const teamsPath = path.join(ROOT, 'data', 'teams.json');
test('队伍库：data/teams.json 结构合法', () => {
  assert(fs.existsSync(teamsPath), 'data/teams.json 不存在（先跑 node scripts/build-teams-json.js）');
  const db = JSON.parse(fs.readFileSync(teamsPath, 'utf8'));
  assert(Array.isArray(db.teams) && db.teams.length >= 90, `队伍数异常: ${db.teams && db.teams.length}`);
  assert(db.parsedAt, '缺少 parsedAt');
  for (const t of db.teams) {
    assert(t.tier && Array.isArray(t.heroes) && t.heroes.length >= 2, `队伍 ${t.id} 结构异常`);
    for (const h of t.heroes) assert(h.name && typeof h.name === 'string', `队伍 ${t.id} 武将名缺失`);
  }
});

// ---------- 4. 脚本接线（防止回退到硬编码） ----------
test('接线：采集/合并脚本使用 lib-config', () => {
  for (const rel of ['scripts/merge-api.js', 'scripts/api-collect.js', 'scripts/list-filter.js', 'scripts/cbg-detail-extract.js']) {
    const src = read(rel);
    assert(src.includes('./lib-config') || src.includes("require('./lib-config')"), `${rel} 未 require lib-config`);
  }
});

test('接线：find-all.ps1 优先走 report.js 且检查退出码', () => {
  const src = read('scripts/find-all.ps1');
  assert(src.includes('report.js'), 'find-all.ps1 未接 report.js');
  assert(/\$LASTEXITCODE/.test(src), 'find-all.ps1 未检查退出码');
});

test('接线：ps1 全部 UTF-8 BOM（递归含 scripts/legacy/）', () => {
  const files = walkFiles(path.join(ROOT, 'scripts'), '.ps1');
  assert(files.length >= 12, `ps1 数量异常: ${files.length}`);
  for (const f of files) {
    const b = fs.readFileSync(f).subarray(0, 3);
    assert(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf, `${path.relative(ROOT, f)} 缺少 UTF-8 BOM`);
  }
});

test('接线：统一评分引擎 lib-scoring 被 plan5-core/strategy-eval 使用', () => {
  assert(fs.existsSync(path.join(ROOT, 'scripts', 'lib-scoring.js')), 'scripts/lib-scoring.js 不存在');
  for (const rel of ['scripts/plan5-core.js', 'scripts/strategy-eval.js']) {
    const src = read(rel);
    assert(src.includes('lib-scoring'), `${rel} 未使用统一评分引擎`);
  }
});

test('接线：report.js 存在且可被 find-all 调用', () => {
  assert(fs.existsSync(path.join(ROOT, 'scripts', 'report.js')), 'scripts/report.js 不存在');
  const src = read('scripts/report.js');
  assert(/--customer/.test(src), 'report.js 缺少 --customer 参数处理');
});

// ---------- 5. 数据文件存在性（只读检查，不改内容） ----------
test('数据：accounts-final.json 可解析且数量合理', () => {
  const file = path.join(ROOT, 'data', 'accounts-final.json');
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(Array.isArray(arr) && arr.length >= 100, `账号数量异常: ${arr && arr.length}`);
  const withStatus = arr.filter((a) => a.statusKind || (a.overview && a.overview.status)).length;
  assert(withStatus > 0, '没有可识别的状态字段');
});

// ---------- 汇总 ----------
console.log(`\nverify-core: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f.name}: ${f.error.message}`);
  process.exit(1);
}
