// ============================================================
// parse-questionnaire.js — 解析客户填写的 xlsx 问卷 → 找号参数
// 用法:
//   node scripts/parse-questionnaire.js [客户填写.xlsx]            # 只看解析结果
//   node scripts/parse-questionnaire.js [客户填写.xlsx] --run      # 直接跑 采集+报告
// ============================================================
const ExcelJS = require('exceljs');
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const XLSX = process.argv[2] || path.join(ROOT, 'docs', '找号需求问卷.xlsx');
const RUN = process.argv.includes('--run');
const CUSTOMER = (() => { const i = process.argv.indexOf('--customer'); return i > -1 ? process.argv[i + 1] : '客户'; })();

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.getWorksheet(1);
  const ans = {};
  ws.eachRow((row, rn) => {
    if (rn < 3) return;
    const q = row.getCell(1).value ? String(row.getCell(1).value).trim() : '';
    const a = row.getCell(3).value;
    const av = a === null || a === undefined ? '' : String(a).trim();
    if (q && av) ans[q] = av;
  });

  // 模糊取答案: 问卷问题文本可能带"(填数字)"等后缀, 用包含匹配更稳
  const pick = (kw, fallback = '') => {
    const k = Object.keys(ans).find(q => q.includes(kw));
    return k ? ans[k] : fallback;
  };

  console.log('===== 客户需求解析 =====');
  Object.keys(ans).forEach(k => console.log(`  ${k}: ${ans[k]}`));

  // 映射参数
  const price = { '500以内': [0, 50000], '500-1000': [50000, 100000], '1000-1500': [100000, 150000],
    '1500-2000(推荐)': [150000, 200000], '2000-3000': [200000, 300000], '3000以上': [300000, 999999] };
  const [pMin, pMax] = price[pick('预算区间')] || [150000, 200000];
  const fiveStar = parseInt((pick('五星武将') || '85').replace(/\D/g, ''), 10) || 85;
  const equip = parseInt((pick('稀世宝物') || '12').replace(/\D/g, ''), 10) || 12;
  const tag = `${pMin / 100}-${pMax / 100}`;
  const srv = pick('区服范围') || '';
  const specSrv = pick('指定服务器') || '';
  const core = pick('核心队伍') || '-';
  const prefs = pick('到手强度偏好') || '-';

  console.log('');
  console.log('===== 生成的找号参数 =====');
  console.log(`  价格区间: ${pMin} - ${pMax} (${tag} 元)`);
  console.log(`  五星≥: ${fiveStar}  |  宝≥: ${equip}`);
  console.log(`  区服: ${srv.includes('指定') ? '指定:' + (specSrv || '?') : '试师白名单'}`);
  console.log(`  偏好: ${core} | ${prefs}`);

  if (RUN) {
    console.log('');
    console.log('== 开始执行: 采集 + 报告 ==');
    const cmd = `powershell -ExecutionPolicy Bypass -File "${path.join(ROOT, 'scripts', 'collect.ps1')}" -PriceMin ${pMin} -PriceMax ${pMax} -FiveStar ${fiveStar} -Equip ${equip} -Tag ${tag}`;
    execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    execSync(`powershell -ExecutionPolicy Bypass -File "${path.join(ROOT, 'scripts', 'report.ps1')}" -Customer "${CUSTOMER}" -DataFile "${path.join(ROOT, 'data', 'accounts-final.json')}"`, { stdio: 'inherit', cwd: ROOT });
    console.log('== 完成, 报告已生成 ==');
  } else {
    console.log('');
    console.log('== 确认无误后运行(加 --run): ==');
    console.log(`node scripts/parse-questionnaire.js "${XLSX}" --run --customer ${CUSTOMER}`);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
