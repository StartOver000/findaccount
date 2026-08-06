// ============================================================
// make-questionnaire.js — 生成带下拉框的找号需求问卷 xlsx
// Sheet1: 问卷(核心队伍下拉 = T0+/T0- 队伍)
// Sheet2: 队伍强度排行榜(供客户查看完整榜单)
// 用法: node scripts/make-questionnaire.js
// 输出: docs/找号需求问卷.xlsx
// ============================================================
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', '找号需求问卷.xlsx');

// ---- 解析队伍强度排行榜.md → 分档队伍 ----
function parseRank() {
  const md = fs.readFileSync(path.join(ROOT, 'docs', '队伍强度排行榜.md'), 'utf-8');
  const tiers = { 'T0+': [], 'T0-': [], 'T1': [], 'T2-': [] };
  const summary = {};
  for (const line of md.split(/\r?\n/)) {
    const sm = line.match(/^\|\s*(T0\+|T0-|T1|T2-)\s*\|\s*(.+?)\s*\|\s*$/);
    if (sm) summary[sm[1]] = sm[2].split('、').map(name => name.trim()).filter(Boolean);
  }
  let cur = null;
  for (const line of md.split(/\r?\n/)) {   // 兼容 CRLF 行尾
    const tm = line.match(/^##\s+(T0\+|T0-|T1|T2-)\s*$/);
    if (tm) { cur = tm[1]; continue; }
    // 其他二级标题结束当前档位，避免后续附录被误算进上一档。
    if (/^##\s+/.test(line)) { cur = null; continue; }
    const hm = line.match(/^###\s+(.+)$/);
    if (hm && cur && tiers[cur]) {
      let raw = hm[1].trim();
      // 仅按正文档位和明确的已降级标记归类。
      const target = /已降级/.test(raw) ? 'T2-' : cur;
      let name = raw.split('：').pop().trim().replace(/（.+?）/g, '').trim();
      if (name) tiers[target].push(name);
    }
  }
  // 速览是当前确认过的完整名单；详细章节缺失时也能保持下拉和 XLSX 同步。
  for (const tier of Object.keys(summary)) tiers[tier] = summary[tier];
  return tiers;
}
const tiers = parseRank();
const coreOptions = [...tiers['T0+'], ...tiers['T0-']].join(';');

// [问题, 选项(分号分隔, 空=手填), 类型, 是否必填]
const QUESTIONS = [
  ['预算区间(必填)', '500以内;500-1000;1000-1500;1500-2000(推荐);2000-3000;3000以上', 'single', true],
  ['预算弹性', '严格卡死;可上浮10%;可上浮20%;不设上限', 'single', false],
  ['区服范围(必填)', '试师号;备战区;指定服务器;不限制', 'single', true],
  ['指定服务器(仅当区服选指定)', '例如 X5836', 'text', false],
  ['核心队伍(多选)', coreOptions, 'multi', false],
  ['强度档要求', '至少1支T0+;至少2支T0级;T1为主即可;越多越好', 'single', false],
  ['到手强度偏好', '武将全+战法宝可缺(推荐);到手即战力;只缺宝物;都要齐', 'single', false],
  ['可接受补件(多选)', '宝物;战法;都可以;完全不补', 'multi', false],
  ['五星武将下限', '', 'num', false],
  ['S战法下限', '', 'num', false],
  ['稀世宝物下限', '', 'num', false],
  ['满红武将下限', '', 'num', false],
  ['红度要求', '不要求;核心武将2红以上;吃红度队伍要高红', 'single', false],
  ['用途', '主力号;开荒号;小号;收藏体验', 'single', false],
  ['期望上战场时间', '立刻能打;1-2周内可补宝;不着急慢慢养', 'single', false],
  ['交付物(多选)', '3-5个候选加报告;单个最优加落地清单;协助下单', 'multi', false],
  ['其他备注', '', 'text', false],
];

(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('问卷');

  // 表头
  ws.getRow(1).values = ['问题', '选项(说明)', '答案(点右边下拉选择)', '备注'];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  head.alignment = { vertical: 'middle', horizontal: 'center' };

  ws.columns = [{ width: 26 }, { width: 46 }, { width: 30 }, { width: 20 }];

  // 提示行(第2行)
  ws.getCell('A2').value = '填写说明: 带"必填"必须选,其他可留空(按推荐值);选择题点答案格右边下拉箭头;多选填多个用顿号、隔开;完整队伍强度榜见底部 Sheet2「队伍强度榜」';
  ws.getCell('A2').font = { color: { argb: 'FFC00000' }, italic: true };
  ws.mergeCells('A2:D2');

  let r = 3;
  for (const [q, opts, type, required] of QUESTIONS) {
    ws.getCell(`A${r}`).value = q;
    ws.getCell(`B${r}`).value = (q === '核心队伍(多选)') ? 'T0+和T0-队伍(完整榜单见Sheet2):' + opts : opts;
    ws.getCell(`C${r}`).value = '';
    ws.getCell(`D${r}`).value = '';
    ws.getCell(`A${r}`).font = { bold: true, color: required ? { argb: 'FFC00000' } : { argb: 'FF000000' } };
    ws.getCell(`C${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    ws.getCell(`C${r}`).border = required
      ? { bottom: { style: 'thick', color: { argb: 'FFC00000' } }, top: { style: 'thick', color: { argb: 'FFC00000' } }, left: { style: 'thick', color: { argb: 'FFC00000' } }, right: { style: 'thick', color: { argb: 'FFC00000' } } }
      : { bottom: { style: 'thin' }, top: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };

    if (type === 'single' || type === 'multi') {
      const list = opts.split(';').map(s => s.trim());
      ws.getCell(`C${r}`).dataValidation = {
        type: 'list', allowBlank: true, showErrorMessage: type === 'single',
        formulae: [`"${list.join(',')}"`],
        errorTitle: '请从列表选择', error: '请点击单元格右侧下拉选择选项',
      };
    } else if (type === 'num') {
      ws.getCell(`C${r}`).dataValidation = {
        type: 'whole', allowBlank: true, showErrorMessage: true,
        operator: 'greaterThanOrEqual', formulae: [0],
        errorTitle: '请输入数字', error: '请输入大于等于0的整数',
      };
    }
    r++;
  }
  ws.views = [{ state: 'frozen', ySplit: 2 }];

  // ---- Sheet2: 队伍强度排行榜 ----
  const ws2 = wb.addWorksheet('队伍强度榜');
  const tierOrder = ['T0+', 'T0-', 'T1', 'T2-'];
  const tierColor = { 'T0+': 'FFC00000', 'T0-': 'FFED7D31', 'T1': 'FF4472C4', 'T2-': 'FF808080' };
  // 表头: 分档 + 队伍数
  tierOrder.forEach((t, i) => {
    const cell = ws2.getCell(1, i + 1);
    cell.value = `${t} (${tiers[t].length}支)`;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tierColor[t] } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  ws2.columns = tierOrder.map(() => ({ width: 20 }));
  // 队伍名(每档一列)
  const maxLen = Math.max(...tierOrder.map(t => tiers[t].length));
  for (let i = 0; i < maxLen; i++) {
    tierOrder.forEach((t, c) => {
      if (i < tiers[t].length) ws2.getCell(i + 2, c + 1).value = tiers[t][i];
    });
  }
  ws2.getCell('A1').comment = 'T0+=顶级; T0-=一线; T1=主流; T2-=已降级';
  ws2.views = [{ state: 'frozen', ySplit: 1 }];

  await wb.xlsx.writeFile(OUT);
  console.log('✅ 问卷已生成:', OUT);
  console.log(`   Sheet1 问卷(${QUESTIONS.length}题, 核心队伍下拉${coreOptions.split(';').length}支T0+/T0-队伍)`);
  console.log(`   Sheet2 队伍强度榜: T0+${tiers['T0+'].length} / T0-${tiers['T0-'].length} / T1${tiers['T1'].length} / T2-${tiers['T2-'].length}`);
})();
