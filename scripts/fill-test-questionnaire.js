// ============================================================
// fill-test-questionnaire.js — 复制问卷模板并填入自测答案
// 用于全链路验证: 生成一份"已填写"的问卷, 供 parse-questionnaire.js 读取
// 阈值答案从 data/strategy-config.json 读取（单源，经 lib-config.js），避免与采集脚本漂移:
//   五星武将下限 = l2_list_filter.fiveStarMin
//   稀世宝物下限 = l1_pool.bargainLine.forgedGearMin（collect.ps1 的 duanzao 参数口径）
// 用法:
//   node scripts/fill-test-questionnaire.js                # 默认生成 docs/找号问卷-自测-{日期}.xlsx
//   node scripts/fill-test-questionnaire.js out.xlsx       # 指定输出文件
// ============================================================
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const cfg = require('./lib-config.js');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'docs', '找号需求问卷.xlsx');
const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT = process.argv[2] || path.join(ROOT, 'docs', `找号问卷-自测-${TODAY}.xlsx`);
const L2 = cfg.getL2();
const L1 = cfg.getL1();
const FIVE_STAR_MIN = L2.fiveStarMin;
const RARE_EQUIP_MIN = L1.bargainLine.forgedGearMin;

// 按问题包含关键字填答案(写入 Sheet1 的 C 列, 与 parse-questionnaire.js 读取位置一致)
const ANSWERS = [
  ['预算区间', '1500-2000(推荐)'],
  ['预算弹性', '可上浮10%'],
  ['区服范围', '试师号'],
  ['指定服务器', ''],
  ['核心队伍', '庞统蜀步;豹纹刀(曹彰);飞天王八'],
  ['强度档要求', '至少1支T0+'],
  ['到手强度偏好', '武将全+战法宝可缺(推荐)'],
  ['可接受补件', '宝物'],
  ['五星武将下限', String(FIVE_STAR_MIN)],
  ['S战法下限', ''],
  ['稀世宝物下限', String(RARE_EQUIP_MIN)],
  ['满红武将下限', ''],
  ['红度要求', '不要求'],
  ['用途', '主力号'],
  ['期望上战场时间', '立刻能打'],
  ['交付物', '3-5个候选加报告'],
  ['其他备注', '全链路自测'],
];

(async () => {
  if (!fs.existsSync(SRC)) { console.error('缺少模板:', SRC); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SRC);
  const ws = wb.getWorksheet(1);
  let hit = 0;
  ws.eachRow((row, rn) => {
    if (rn < 3) return;
    const q = row.getCell(1).value ? String(row.getCell(1).value).trim() : '';
    for (const [kw, val] of ANSWERS) {
      if (q.includes(kw)) { row.getCell(3).value = val; hit++; break; }
    }
  });
  await wb.xlsx.writeFile(OUT);
  console.log(`✅ 已生成自测问卷: ${OUT} (填写 ${hit}/${ANSWERS.length} 项, 五星≥${FIVE_STAR_MIN} 稀世≥${RARE_EQUIP_MIN}, config ${cfg.configFingerprint()})`);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
