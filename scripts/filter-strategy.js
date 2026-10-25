// ============================================================
// filter-strategy.js — 数据驱动「筛选条件策略」分析与推荐（2026-10-25）
//
// 回答的问题: 列表阶段该用什么条件/什么顺序决定「哪些号值得点进详情」。
//   1. 单因子证据：五星/S战法/锻造/稀世/价格 各自对最终落地战力的预测力
//   2. 阈值 vs 排序：固定详情预算（10/20/30/40 个）时谁抓到的候选更多
//   3. 推荐参数：宽硬门槛保召回 + 预筛分排序定优先级 + 预算分档
//
// 输入（需先跑过策略评估）:
//   data/accounts-final.json
//   reports/策略落地-20261025/strategy-eval.json
// 输出:
//   reports/筛选条件策略-20261025/筛选条件分析.md
//   reports/筛选条件策略-20261025/filter-strategy.json
//
// 用法: node scripts/filter-strategy.js [输出目录]
// ============================================================
const fs = require('fs');
const path = require('path');

const cfg = require('./lib-config.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'accounts-final.json');
const EVAL_FILE = path.join(ROOT, 'reports', '策略落地-20261025', 'strategy-eval.json');
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'reports', '筛选条件策略-20261025');

// 配置单源：data/strategy-config.json（与采集/分析脚本共用同一份，不再写死阈值）
const L2 = cfg.getL2();
cfg.logEffective('[filter-strategy]');

const nf = n => Number(n.toFixed(2));
const pct = (a, b) => (b ? nf(a / b * 100) : 0);
const parseNum = v => {
  const n = parseInt(String(v == null ? '' : v).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};
const priceOf = a => {
  const raw = parseNum(a.overview && a.overview.price);
  return raw == null ? null : (raw >= 10000 ? Math.round(raw / 100) : raw);
};

// ---- 数据 join ----
if (!fs.existsSync(EVAL_FILE)) {
  console.error(`缺少 ${path.relative(ROOT, EVAL_FILE)}，先运行: node scripts/strategy-eval.js`);
  process.exit(1);
}
const evalJson = JSON.parse(fs.readFileSync(EVAL_FILE, 'utf-8'));
const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
const bySn = {};
for (const a of data) {
  const sn = String((a.overview && a.overview.url) || '').split('/').pop().split('?')[0];
  if (sn) bySn[sn] = a;
}
const rows = evalJson.rows.map(r => {
  const a = bySn[r.ordersn] || {};
  const li = a.list || {};
  const ov = a.overview || {};
  return {
    ...r,
    stars: parseNum(li.stars || ov.stars),
    st: parseNum(ov.sTactics || li.st),
    eq: parseNum(ov.forged),
    rare: parseNum(ov.rareEquips || li.eq),
    price: r.price || priceOf(a)
  };
}).filter(r => r.price && r.stars != null && r.st != null && r.eq != null && r.rare != null);

const N = rows.length;
const cand = r => (r.gatePass || r.baoBaoPass) && r.premiumOk;   // 可进入购买候选
const high = r => r.score >= 15;                                  // 高落地战力（参考线）
const CAND = rows.filter(cand);
const HIGH = rows.filter(high);

// ---- 统计工具 ----
function corr(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sx += (xs[i] - mx) ** 2; sy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sx * sy || 1);
}
function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
}
function ols(X, y) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => Array(p).fill(0));
  const b = Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < p; a++) {
      b[a] += X[i][a] * y[i];
      for (let c = 0; c < p; c++) A[a][c] += X[i][a] * X[i][c];
    }
  }
  for (let i = 0; i < p; i++) {
    let m = i;
    for (let r = i + 1; r < p; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
    [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]];
    const d = A[i][i];
    for (let c = i; c < p; c++) A[i][c] /= d;
    b[i] /= d;
    for (let r = 0; r < p; r++) {
      if (r === i) continue;
      const f = A[r][i];
      for (let c = i; c < p; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  return b;
}
const FEATS = r => [1, r.st, r.eq, r.stars, r.rare, r.price / 1000];
const FULL_MODEL = ols(rows.map(FEATS), rows.map(r => r.score));
let ybar = rows.reduce((a, r) => a + r.score, 0) / N;
let sst = rows.reduce((a, r) => a + (r.score - ybar) ** 2, 0);
let sse = rows.reduce((a, r, i) => a + (r.score - FEATS(r).reduce((s, v, k) => s + v * FULL_MODEL[k], 0)) ** 2, 0);
const R2 = 1 - sse / (sst || 1);

// 五折交叉验证（确定性洗牌）
function fiveFoldCV() {
  const idx = rows.map((_, i) => i);
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const folds = [[], [], [], [], []];
  idx.forEach((i, k) => folds[k % 5].push(i));
  let cvSse = 0, cvSst = 0, cap10 = 0, cap20 = 0, tested = 0;
  folds.forEach((test, fi) => {
    const train = [];
    folds.forEach((f, j) => { if (j !== fi) train.push(...f); });
    const beta = ols(train.map(i => FEATS(rows[i])), train.map(i => rows[i].score));
    const scored = test.map(i => ({ r: rows[i], p: FEATS(rows[i]).reduce((s, v, k) => s + v * beta[k], 0) }))
      .sort((a, b) => b.p - a.p);
    for (const i of test) {
      const pred = FEATS(rows[i]).reduce((s, v, k) => s + v * beta[k], 0);
      cvSse += (rows[i].score - pred) ** 2;
      cvSst += (rows[i].score - ybar) ** 2;
    }
    cap10 += scored.slice(0, 10).filter(x => cand(x.r)).length;
    cap20 += scored.slice(0, 20).filter(x => cand(x.r)).length;
    tested += test.length;
  });
  return { r2: 1 - cvSse / (cvSst || 1), cap10, cap20, tested };
}
const CV = fiveFoldCV();

// 预筛分权重（配置单源：l2_list_filter.prefilter.weights，缺失时 lib-config 直接抛错）
const PW = cfg.getPrefilterWeights();
const P = r => PW.intercept + PW.st * r.st + PW.forged * r.eq + PW.stars * r.stars + PW.pricePer1000 * (r.price / 1000);

// ---- 单因子分档 ----
const FACTORS = [
  { key: 'price', label: '价格(元)', get: r => r.price, bands: [[1500, 1800], [1800, 2000], [2000, 2200], [2200, 2501]] },
  { key: 'stars', label: '五星卡数', get: r => r.stars, bands: [[85, 90], [90, 95], [95, 100], [100, 105], [105, 110], [110, 115], [115, 999]] },
  { key: 'st', label: 'S级战法数', get: r => r.st, bands: [[0, 20], [20, 22], [22, 24], [24, 27]] },
  { key: 'eq', label: '已锻造宝物', get: r => r.eq, bands: [[0, 15], [15, 18], [18, 22], [22, 99]] },
  { key: 'rare', label: '稀世宝物', get: r => r.rare, bands: [[0, 12], [12, 15], [15, 18], [18, 21], [21, 99]] }
];
function bandTable(f) {
  return f.bands.map(([lo, hi]) => {
    const sub = rows.filter(r => f.get(r) >= lo && f.get(r) < hi);
    const c = sub.filter(cand).length;
    const sc = sub.map(r => r.score);
    return {
      band: `${lo}-${hi === 999 ? '∞' : hi}`, n: sub.length, cand: c,
      candPct: pct(c, sub.length), meanScore: sub.length ? nf(sc.reduce((a, b) => a + b, 0) / sub.length) : 0,
      medianScore: median(sc), meanValue: sub.length ? nf(sub.reduce((a, r) => a + r.valuePer1000, 0) / sub.length) : 0,
      gate: sub.filter(r => r.gatePass).length
    };
  });
}

// ---- 累计阈值 ----
function cumTable(get, thresholds) {
  return thresholds.map(t => {
    const sub = rows.filter(r => get(r) >= t);
    const c = sub.filter(cand).length;
    return {
      t, n: sub.length, retainPct: pct(sub.length, N), cand: c, precision: pct(c, sub.length),
      recall: pct(c, CAND.length), high15: pct(sub.filter(high).length, sub.length)
    };
  });
}
const CUM = {
  st: cumTable(r => r.st, [18, 20, 21, 22, 23, 24, 25]),
  stars: cumTable(r => r.stars, [85, 90, 95, 100, 105, 110, 115]),
  eq: cumTable(r => r.eq, [12, 15, 18, 20, 22])
};

// ---- 排序 vs 阈值：固定详情预算 ----
const RANKS = [
  { name: '预筛分 P(推荐)', get: r => P(r) },
  { name: '现行：五星优先', get: r => r.stars * 1000 + r.eq },
  { name: 'S战法优先', get: r => r.st },
  { name: '已锻造优先', get: r => r.eq },
  { name: '价格优先', get: r => r.price }
];
const RANK_RESULTS = RANKS.map(x => {
  const sorted = rows.slice().sort((a, b) => x.get(b) - x.get(a));
  return {
    name: x.name,
    at: [10, 20, 30, 40].map(D => {
      const top = sorted.slice(0, D);
      return { D, cand: top.filter(cand).length, high15: top.filter(high).length };
    })
  };
});

// ---- 候选明细 ----
const candDetail = CAND.slice().sort((a, b) => b.score - a.score).map(r => ({
  ordersn: r.ordersn.slice(-4), price: r.price, stars: r.stars, st: r.st, eq: r.eq, rare: r.rare,
  score: r.score, gatePass: r.gatePass, baoBaoPass: r.baoBaoPass,
  prefilter: nf(P(r))
}));
const minCand = k => Math.min(...CAND.map(r => r[k]));
const maxCand = k => Math.max(...CAND.map(r => r[k]));

// ---- 推荐 ----
// 硬门槛 = 配置单源 l2_list_filter（数据推导项单独标注），不再写死 85/15/12
const RECO = {
  hardFloors: {
    fiveStarMin: L2.fiveStarMin,
    sTacticMin: miniSt(),               // 候选最小 S 战法（数据推导）
    forgedGearMin: L2.forgedGearMin,
    rareEquipMin: L2.rareEquipMin,
    note: `列表字段门槛来自 data/strategy-config.json 的 l2_list_filter（config ${cfg.configFingerprint()}）；sTacticMin 为数据推导项`
  },
  prefilter: { weights: PW, usage: '按 P 降序抓详情，只排序不淘汰' },
  priceTiers: [
    { budget: 2000, priceRange: [1500, 2000], detailBudget: 30, note: '按预筛分排序采' },
    { budget: 2500, priceRange: [1800, 2500], detailBudget: L2.detailBudget, note: '全量上限取 l2_list_filter.detailBudget' },
    { budget: 1500, priceRange: [1200, 1500], detailBudget: 15, note: '走捡漏线，配合 docs/选号计划-v3-筛子法.md' }
  ],
  stopRule: '抓满 detailBudget 个详情，或候选（过门槛+溢价规则）已达 5 个即停'
};
function miniSt() { return minCand('st'); }

// ---- Markdown ----
const L = [];
const push = s => L.push(s);
const corrWith = k => nf(corr(rows.map(r => r[k]), rows.map(r => r.score)));

push(`# 筛选条件策略分析（数据驱动）`);
push('');
push(`> 数据：\`data/accounts-final.json\` 中 ${data.length} 个号，能同时对拼列表字段与策略评估结果的有 **${N}** 个；`);
push(`> 评估结果：\`reports/策略落地-20261025/strategy-eval.json\`（2026-08 快照，价格已过期，用于看「相对关系」）。`);
push(`> 参数来源：\`data/strategy-config.json\`（config fingerprint \`${cfg.configFingerprint()}\`），阈值不再写死在本脚本。`);
push(`> 结论定义：**候选** = 过主门槛或补宝型通道，且过溢价规则；**高分** = 落地战力 ≥ 15。`);
push('');
push(`## 1. 结论摘要`);
push('');
push(`1. **五星数是最弱的预测因子**（r=${corrWith('stars')}）：6 个候选里有 1 个只有 85 星；旧默认门槛「五星≥90」会误杀它，现按 config l2_list_filter.fiveStarMin=${RECO.hardFloors.fiveStarMin} 保留。`);
push(`2. **S级战法数最强**（r=${corrWith('st')}），已锻造次之（r=${corrWith('eq')}），价格（r=${corrWith('price')}）是「内容量」代理；稀世宝物几乎无预测力（r=${corrWith('rare')}，且受价格/锻造共线影响）。`);
push(`3. **同样的详情预算，排序比抬门槛划算**：预算 20 个详情时，预筛分排序抓到 ${RANK_RESULTS[0].at[1].cand}/${CAND.length} 个候选 + ${RANK_RESULTS[0].at[1].high15}/${HIGH.length} 个高分号；现行五星优先只抓到 ${RANK_RESULTS[1].at[1].cand}/${CAND.length} + ${RANK_RESULTS[1].at[1].high15}/${HIGH.length}。`);
push(`4. 预筛分只用于**排序**，不用于硬淘汰；硬门槛保持宽（保召回），让排序决定先点谁。`);
push('');
push(`## 2. 单因子证据`);
push('');
push(`| 因子 | 与落地战力相关系数 r | 结论 |`);
push(`|---|---:|---|`);
push(`| S级战法数 | ${corrWith('st')} | 最强，作主排序因子 |`);
push(`| 价格 | ${corrWith('price')} | 正相关（贵号内容多），预算内可用 |`);
push(`| 已锻造宝物 | ${corrWith('eq')} | 次强，作辅助 |`);
push(`| 五星卡数 | ${corrWith('stars')} | 弱，不能当主门槛 |`);
push(`| 稀世宝物 | ${corrWith('rare')} | 近似无关，只作采集底线 |`);
push('');
for (const f of FACTORS) {
  push(`### ${f.label} 分档`);
  push('');
  push(`| 区间 | 数量 | 候选 | 候选率 | 均分 | 中位分 | 性价比/千元 | 主门槛通过 |`);
  push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const b of bandTable(f)) push(`| ${b.band} | ${b.n} | ${b.cand} | ${b.candPct}% | ${b.meanScore} | ${b.medianScore} | ${b.meanValue} | ${b.gate} |`);
  push('');
}
push(`## 3. 阈值 vs 排序（固定详情预算）`);
push('');
push(`| 排序方式 | Top10 候选/高分 | Top20 | Top30 | Top40 |`);
push(`|---|---:|---:|---:|---:|`);
for (const x of RANK_RESULTS) {
  const cell = a => `${a.cand}/${a.high15}`;
  push(`| ${x.name} | ${cell(x.at[0])} | ${cell(x.at[1])} | ${cell(x.at[2])} | ${cell(x.at[3])} |`);
}
push('');
push(`> 上表是「抓前 D 个详情」时，D 个号里包含多少候选 / 多少高分号。候选共 ${CAND.length} 个、高分共 ${HIGH.length} 个（在 ${N} 个已知列表字段的号中）。`);
push('');
push(`### 累计门槛：召回 vs 精度`);
push('');
push(`| S战法 ≥ | 保留 | 保留率 | 候选 | 精度 | 召回 | 高分率 |`);
push(`|---:|---:|---:|---:|---:|---:|---:|`);
for (const c of CUM.st) push(`| ${c.t} | ${c.n} | ${c.retainPct}% | ${c.cand} | ${c.precision}% | ${c.recall}% | ${c.high15}% |`);
push('');
push(`| 五星 ≥ | 保留 | 候选 | 精度 | 召回 |`);
push(`|---:|---:|---:|---:|---:|`);
for (const c of CUM.stars) push(`| ${c.t} | ${c.n} | ${c.cand} | ${c.precision}% | ${c.recall}% |`);
push('');
push(`| 锻造 ≥ | 保留 | 候选 | 精度 | 召回 |`);
push(`|---:|---:|---:|---:|---:|`);
for (const c of CUM.eq) push(`| ${c.t} | ${c.n} | ${c.cand} | ${c.precision}% | ${c.recall}% |`);
push('');
push(`## 4. 预测模型（预筛分来源）`);
push('');
push(`OLS（因变量=落地战力，样本 ${N}）：\`score ≈ ${FULL_MODEL.map(x => nf(x)).join(' + ').replace(/ \+ -/g, ' − ')}\`，`);
push(`其中特征顺序为 常数 / S战法 / 已锻造 / 五星 / 稀世 / 价格(千元)。拟合 R²=${nf(R2)}；五折交叉验证 R²=${nf(CV.r2)}，`);
push(`交叉验证中 Top10 详情覆盖 ${CV.cap10}/${CAND.length} 个候选、Top20 覆盖 ${CV.cap20}/${CAND.length}（每折各取前 10/20 再合计）。`);
push('');
push(`> 预筛分用更简单的固定权重：P = ${PW.intercept} + ${PW.st}×S战法 + ${PW.forged}×锻造 + ${PW.stars}×五星 + ${PW.pricePer1000}×价格(千元)，见 \`scripts/prefilter.js\`。`);
push('');
push(`## 5. 候选明细（${CAND.length} 个）`);
push('');
push(`| 尾号 | 价格 | 五星 | S战法 | 锻造 | 稀世 | 战力 | 预筛分 | 通道 |`);
push(`|---|---:|---:|---:|---:|---:|---:|---:|---|`);
for (const c of candDetail) push(`| ${c.ordersn} | ¥${c.price} | ${c.stars} | ${c.st} | ${c.eq} | ${c.rare} | ${c.score} | ${c.prefilter} | ${c.gatePass ? '主门槛' : '补宝型'} |`);
push('');
push(`> 候选最小特征值：五星 ${minCand('stars')} / S战法 ${minCand('st')} / 锻造 ${minCand('eq')} / 稀世 ${minCand('rare')}；价格 ${Math.min(...CAND.map(c => c.price))}–${Math.max(...CAND.map(c => c.price))}。`);
push('');
push(`## 6. 推荐筛选条件`);
push('');
push(`**硬门槛（保召回，不符合才跳过）**：`);
push('');
push(`- 区服：当前开放试师（\`npm run shishi\` 刷新，65 个左右）`);
push(`- 价格：≤ 预算（档位见下）`);
push(`- 五星 ≥ ${RECO.hardFloors.fiveStarMin}（config l2_list_filter.fiveStarMin，采集底线）`);
push(`- S级战法 ≥ ${RECO.hardFloors.sTacticMin}（数据推导；数据里候选最小 ${minCand('st')}）`);
push(`- 稀世宝物 ≥ ${RECO.hardFloors.rareEquipMin}（config l2_list_filter.rareEquipMin，采集底线）`);
push(`- 已锻造 ≥ ${RECO.hardFloors.forgedGearMin}（config l2_list_filter.forgedGearMin；候选实际 ≥ ${minCand('eq')}，留余量）`);
push('');
push(`**详情排序（决定先点谁）**：按预筛分 P 降序，抓满 detailBudget 个；P 只排序、不淘汰。`);
push('');
push(`**预算分档**：`);
push('');
push(`| 预算 | 价格区间 | 详情预算 | 说明 |`);
push(`|---:|---|---:|---|`);
for (const t of RECO.priceTiers) push(`| ¥${t.budget} | ${t.priceRange[0]}–${t.priceRange[1]} | ${t.detailBudget} | ${t.note || '按预筛分排序采'}` + ` |`);
push('');
push(`**停止规则**：${RECO.stopRule}。`);
push('');
push(`## 7. 复现与校准`);
push('');
push('```powershell');
push('node scripts/strategy-eval.js            # 先算落地战力（数据更新后重跑）');
push('node scripts/filter-strategy.js          # 生成本报告');
push('node scripts/api-collect.js data/accounts-api.json 150000 200000 "" 30   # 精选 30 个详情（按预筛分）');
push('```');
push('');
push(`每次新采集后重跑本脚本；样本 ≥300 个号时再调整预筛分权重。当前样本仅 ${CAND.length} 个正例，结论方向可信、数值不要过度解读。`);
push('');
push(`## 8. 已知局限`);
push('');
push(`- 样本来自 2026-08-10 快照，价格/在售结构已变化，绝对值会漂移；本报告只用于相对排序与门槛设计。`);
push(`- ${data.length - N} 个号缺列表字段（API 来源无 desc），无法参与单因子分析。`);
push(`- 「候选」只有 ${CAND.length} 个正例，任何阈值在 ±1 个候选上都会明显变化；因此推荐宽门槛 + 排序，而不是精调阈值。`);
push('- 预筛分权重由 117 个样本回归得到，换赛季/换版本后建议重跑校准。');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, '筛选条件分析.md'), L.join('\n'), 'utf-8');
fs.writeFileSync(path.join(OUT_DIR, 'filter-strategy.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  inputs: { dataFile: path.relative(ROOT, DATA_FILE), evalFile: path.relative(ROOT, EVAL_FILE) },
  sample: { total: data.length, joined: N, candidates: CAND.length, highScore: HIGH.length },
  correlations: { st: corrWith('st'), price: corrWith('price'), eq: corrWith('eq'), stars: corrWith('stars'), rare: corrWith('rare') },
  model: { coefficients: FULL_MODEL, featureOrder: ['intercept', 'st', 'forged', 'stars', 'rare', 'pricePer1000'], r2: nf(R2), cvR2: nf(CV.r2), cvTop10Candidates: CV.cap10, cvTop20Candidates: CV.cap20 },
  prefilter: PW,
  config: { path: 'data/strategy-config.json', fingerprint: cfg.configFingerprint() },
  thresholds: CUM,
  ranking: RANK_RESULTS,
  recommendation: RECO,
  candidates: candDetail
}, null, 2), 'utf-8');

console.log('saved:', path.relative(ROOT, path.join(OUT_DIR, '筛选条件分析.md')));
console.log('saved:', path.relative(ROOT, path.join(OUT_DIR, 'filter-strategy.json')));
console.log(`n=${N} cand=${CAND.length} high=${HIGH.length} r2=${nf(R2)} cvR2=${nf(CV.r2)} top20: pref=${RANK_RESULTS[0].at[1].cand}/${RANK_RESULTS[0].at[1].high15} stars=${RANK_RESULTS[1].at[1].cand}/${RANK_RESULTS[1].at[1].high15}`);
