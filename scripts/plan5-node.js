// ============================================================
// plan5-node.js — 自动规划账号最佳5队(武将不重复) — Node.js 高速版
// 完全复刻 plan5-v2.ps1 逻辑(榜单解析/版本校验/落地判断/组合枚举),
// 但用 Node 实现, 枚举组合快 100 倍以上(128 账号从 50 秒 → <1 秒)
// 用法: node scripts/plan5-node.js [dataFile] [outFile]
//   outFile: 可选, 指定则把输出写入该文件(UTF-8, 避免 PowerShell 管道 GBK 乱码)
// ============================================================
const fs = require('fs');
const path = require('path');
const core = require('./plan5-core.js');
const { initTeams, planAccount } = core;
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = process.argv[2] || path.join(ROOT, 'data', 'accounts-final.json');
const OUT_FILE = process.argv[3] || '';
const outLines = [];   // 收集输出行

// ---- 主流程 ----
function main() {
  const teams = initTeams();
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  console.log(`rank teams: ${teams.length}`);
  const seenAcc = new Set();
  for (const acc of data) {
    if (!acc.overview) continue;
    const k = `${acc.list.server}-${acc.overview.price}`;
    if (seenAcc.has(k)) continue;
    seenAcc.add(k);
    const listSrv = acc.list.server, price = acc.overview.price;
    // 用核心库规划最优 5 队
    const plan = planAccount(acc, teams);
    const cand = plan.cand, res = plan.res;
    const fullCount = plan.fullCount, onlyGearCount = plan.onlyGearCount;
    outLines.push(`\n########## ${listSrv} ¥${price} ##########`);
    outLines.push(`URL: ${String(acc.overview.url).replace(/\?.*$/, '')}`);
    outLines.push(`落地统计: 完整 ${fullCount} | 只缺宝 ${onlyGearCount} | 可组 ${cand.length}`);
    if (res) {
      outLines.push(`可组榜单队伍: ${cand.length} 支 | 枚举组合: ${res.combos} 个 | 最优评分: ${res.bestScore}`);
      let i = 0;
      for (const b of res.best) {
        i++;
        const st2 = (b.TMiss === '' && b.EMiss === '') ? '[完整]'
          : (b.TMiss === '') ? `[只缺宝:${b.EMiss}]`
          : (b.EMiss === '') ? `[缺战法:${b.TMiss} 宝齐]`
          : `[缺战法:${b.TMiss} 宝:${b.EMiss}]`;
        outLines.push(`${i}. ${b.Team}(${b.Tier}) ${st2} — 武将: ${b.Heroes.join('、')}`);
      }
    } else {
      outLines.push('  (无可组队伍)');
    }
  }
  const output = outLines.join('\n');
  if (OUT_FILE) {
    fs.writeFileSync(OUT_FILE, output, 'utf-8');
    console.log('saved:', OUT_FILE);
  } else {
    console.log(output);
  }
}

main();
