'use strict';
/*
 * 轻量 DOM 桩：在无浏览器环境下加载 public/app.js，
 * 驱动“建格→标注→合法/非法折叠→回放→顺序→存取载荷”主流程冒烟。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const FE = require('../public/foldEngine.js');

function makeEl(id) {
  const listeners = {};
  const el = {
    id, hidden: false, value: '', textContent: '', innerHTML: '',
    style: { cssText: '' }, className: '', disabled: false,
    dataset: {}, files: [], max: '0',
    width: 0, height: 0,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatch(t, ev = {}) { (listeners[t] || []).forEach((fn) => fn(ev)); },
    appendChild() {}, append() {}, querySelector() { return makeEl('q'); },
    querySelectorAll() { return []; },
    removeAttribute() {}, setAttribute() {},
    options: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    getContext: () => ({
      setTransform() {}, clearRect() {}, save() {}, restore() {},
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
      arcTo() {}, closePath() {}, fillText() {}, translate() {}, rotate() {},
      rect() {}, set fillStyle(v) {}, get fillStyle() { return ''; },
      set strokeStyle(v) {}, get strokeStyle() { return ''; },
      set lineWidth(v) {}, get lineWidth() { return 1; },
      set font(v) {}, get font() { return ''; },
      set textAlign(v) {}, set textBaseline(v) {},
      setLineDash() {}
    }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
  };
  // 桩保真：设置 innerHTML 时同步一份去标签的 textContent（app 常用 innerHTML、断言看 textContent）
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); el.textContent = html.replace(/<[^>]*>/g, ''); }
  });
  return el;
}

const ids = ['rowsInput', 'colsInput', 'createGridBtn', 'axisSelect', 'lineSelect',
  'foldError', 'saveBtn', 'exportBtn', 'importBtn', 'importFile', 'loadListBtn',
  'deletePlanBtn', 'planList', 'saveMsg', 'firstBtn', 'prevBtn', 'playBtn', 'nextBtn',
  'stepSlider', 'stepLabel', 'statusBadge', 'board', 'canvasHint', 'stepList',
  'delStepBtn', 'clearStepsBtn', 'orientInfo', 'sequenceBox', 'foldState',
  'cellEditor', 'editorOrigin', 'editorRows', 'editorCancel', 'editorOk', 'planName',
  'imposeStart', 'imposeCount', 'imposePreviewBtn', 'imposeStatus', 'imposePreview',
  'imposeSummary', 'imposeOverwrite', 'imposeRows', 'imposeCancelBtn', 'imposeConfirmBtn',
  'pathCell', 'pathFace', 'pathSearchBtn', 'pathStatus', 'pathResults'];
const els = Object.fromEntries(ids.map((id) => [id, makeEl(id)]));
els.rowsInput.value = '2';
els.colsInput.value = '2';
els.planName.value = '冒烟方案';
els.axisSelect.value = 'v';

const foldBtns = ['l', 'r', 'u', 'd'].map((dir) => {
  const b = makeEl('fold-' + dir);
  b.dataset.dir = dir;
  return b;
});

const win = { devicePixelRatio: 1, addEventListener() {} };
const sandbox = {
  console,
  window: win,
  document: {
    getElementById: (id) => els[id],
    querySelectorAll: (sel) => sel === 'button.fold' ? foldBtns : [],
    createElement: () => makeEl('dyn')
  },
  fetch: async () => ({ json: async () => ({ ok: false }) }),
  Blob: class {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  FileReader: class { readAsText() {} },
  alert() {}, confirm() { return false; },
  setTimeout, clearInterval, setInterval: () => 1
};
vm.createContext(sandbox);
// foldEngine 通过 window.FoldEngine 暴露；让 window 也成为全局对象的一部分
sandbox.window.FoldEngine = undefined;

vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'foldEngine.js'), 'utf8'), sandbox);
vm.runInContext('var FoldEngine = window.FoldEngine;', sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), sandbox);
const ui = sandbox.window.__foldApp;

// init() 已在 app.js 末尾执行：默认创建了 2×2 网格
assert.equal(ui.plan.rows, 2);
assert.equal(ui.plan.cols, 2);

// 模拟添加合法竖折（左瓣向右落）
ui.plan.labels = {
  '0,0': { front: '4', back: '5' }, '1,0': { front: '6', back: '3' },
  '0,1': { front: '8', back: '1' }, '1,1': { front: '7', back: '2' }
};
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
assert.equal(ui.plan.steps.length, 1);
assert.equal(els.foldError.hidden, true);

// 非法折：水平方向用左右方向不匹配，由表单分支处理；直接给厚度冲突
// 先加合法水平折，再试图重复 -> contour
ui.requestStep({ axis: 'h', line: 1, dir: 'd' });
assert.equal(ui.plan.steps.length, 2);
ui.requestStep({ axis: 'h', line: 1, dir: 'd' }); // 上瓣已空
assert.equal(ui.plan.steps.length, 2, '非法步骤不应入列');
assert.equal(els.foldError.hidden, false);

// 回放与阅读顺序
ui.setUpto(0);
assert.equal(ui.upto, 0);
ui.setUpto(2);
const seq = FE.pageSequence(ui.replay.state).stacks[0].sequence;
assert.deepEqual(seq, ['3', '4', '1', '7', '2', '8', '5', '6']);
assert.ok(/单叠|阅读顺序/.test(els.foldState.textContent), '折叠状态已渲染');

// 厚度冲突场景（1×3）
els.rowsInput.value = '1'; els.colsInput.value = '3';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
ui.requestStep({ axis: 'v', line: 2, dir: 'l' });
assert.equal(ui.plan.steps.length, 1, '厚度冲突步应被拒绝');
assert.ok(els.foldError.textContent.includes('厚度不一致'));
assert.ok(ui.replay.error.code === 'thickness');
assert.deepEqual(ui.replay.error.conflicts, ['2,0', '1,0']);

// ---------- 自动拼版 ----------
// 非法折叠场景：生成被禁用。被拒绝的折法不会写入步骤，因此这里直接置入
// 一条非法步骤（等价于导入含非法折叠的方案）后重渲染。
ui.plan.steps.push({ axis: 'v', line: 2, dir: 'l' });   // 1 层压向 2 层：厚度冲突
ui.render();
assert.equal(ui.imposition.eligible.ok, false);
assert.equal(ui.imposition.eligible.code, 'thickness');
assert.equal(els.imposePreviewBtn.disabled, true);
assert.ok(els.imposeStatus.textContent.includes('禁用生成'));
ui.plan.steps.pop();   // 恢复为只有合法首步的状态

// 未收成单叠场景（2×3 只折一次）
els.rowsInput.value = '2'; els.colsInput.value = '3';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
assert.equal(ui.imposition.eligible.ok, false);
assert.equal(ui.imposition.eligible.code, 'not_single_stack');
assert.equal(els.imposePreviewBtn.disabled, true);

// 合法 2×2 折帖：v1 右折 + h1 下折，收成 8 面单叠
els.rowsInput.value = '2'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
ui.requestStep({ axis: 'h', line: 1, dir: 'd' });
assert.equal(ui.imposition.eligible.ok, true);
assert.equal(ui.imposition.eligible.capacity, 8);
assert.equal(els.imposePreviewBtn.disabled, false);

// 页数超出容量：引擎拒绝，不出预览
els.imposeStart.value = '1';
els.imposeCount.value = '9';
els.imposePreviewBtn.dispatch('click');
assert.equal(ui.imposition.result, null);
assert.ok(els.imposeStatus.textContent.includes('超出纸格总面数'));
assert.equal(els.imposePreview.hidden, true);

// 生成预览：不得直接改动当前标注
els.imposeCount.value = '8';
els.imposePreviewBtn.dispatch('click');
assert.ok(ui.imposition.result && ui.imposition.result.ok);
assert.deepEqual(ui.plan.labels, {}, '预览阶段标注不得被修改');
assert.equal(els.imposePreview.hidden, false);
assert.equal(ui.imposition.result.blankTrailing, 0);

// 确认写入后：阅读序列为连续 1..8，反向映射正确（1×2 例与手工标注一致）
els.imposeConfirmBtn.dispatch('click');
const imposedSeq = FE.pageSequence(ui.replay.state).stacks[0].sequence;
assert.deepEqual(imposedSeq, ['1', '2', '3', '4', '5', '6', '7', '8']);
assert.deepEqual(ui.plan.labels['0,1'], { front: '6', back: '3' });

// 部分页数 4：末尾 4 槽空白，被空白的面在预览中可定位
ui.plan.labels = {};
ui.render();
els.imposeCount.value = '4';
els.imposePreviewBtn.dispatch('click');
assert.equal(ui.imposition.result.blankTrailing, 4);
const blankSlots = ui.imposition.result.slots.filter((s) => s.blank);
assert.equal(blankSlots.length, 4);
assert.ok(blankSlots.every((s) => s.origin && s.face));

// 现有标注非空：确认前覆盖汇总非空（confirm 在桩中返回 false，不会误写入）
ui.plan.labels = { '0,0': { front: '99', back: '98' } };
ui.render();
els.imposePreviewBtn.dispatch('click');
assert.equal(els.imposeOverwrite.hidden, false);
assert.ok(els.imposeOverwrite.textContent.includes('0,0'));
els.imposeConfirmBtn.dispatch('click');
assert.equal(ui.plan.labels['0,0'].front, '99', '未确认时不得覆盖现有标注');

// 确认后旧预览作废：再改回干净标注、重新确认（绕过 confirm 直接调用）
ui.plan.labels = {};
ui.render();
els.imposeCount.value = '8';
els.imposePreviewBtn.dispatch('click');
ui.confirmImposition();   // 无现有标注，不弹确认框
assert.deepEqual(FE.pageSequence(ui.replay.state).stacks[0].sequence,
  ['1', '2', '3', '4', '5', '6', '7', '8']);

// ---------- 折手自动寻路 ----------
// 干净 2×2：寻路按钮可用，目标 (1,0) 反面 → 2 步最短，给出 ≤3 条等长方案
els.rowsInput.value = '2'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
assert.equal(ui.plan.rows, 2);
assert.equal(els.pathSearchBtn.disabled, false);
els.pathCell.value = '1,0';
els.pathFace.value = 'back';
ui.doPathfindSearch();
assert.ok(ui.pathfind.result && ui.pathfind.result.solved, '寻路应成功');
assert.equal(ui.pathfind.result.depth, 2);
assert.ok(ui.pathfind.result.solutions.length >= 2);
assert.ok(ui.pathfind.result.solutions.length <= 3);
for (const sol of ui.pathfind.result.solutions) assert.equal(sol.steps.length, 2);
assert.ok(/最短/.test(els.pathStatus.textContent));
assert.equal(els.pathResults.hidden, false);

// 追加任一方案到当前步骤：进入末态回放，收成单叠、封面正确
const firstSol = ui.pathfind.result.solutions[0];
const before = ui.plan.steps.length;
ui.appendPathSolution(firstSol);
assert.equal(ui.plan.steps.length, before + 2);
assert.equal(ui.upto, ui.plan.steps.length);
const finalCells = Object.keys(ui.replay.state.stacks);
assert.equal(finalCells.length, 1);
const topPanel = ui.replay.state.panels[ui.replay.state.stacks[finalCells[0]][0]];
assert.equal(topPanel.ox + ',' + topPanel.oy, '1,0');
assert.ok(topPanel.frame.n.z < 0);
assert.equal(ui.pathfind.result, null, '追加后旧寻路结果作废');

// 无解目标（正面封面）：状态文字提示“无解”，不展示方案
els.rowsInput.value = '2'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
els.pathCell.value = '0,0';
els.pathFace.value = 'front';
ui.doPathfindSearch();
assert.equal(ui.pathfind.result.solved, false);
assert.equal(ui.pathfind.result.reason, 'no_solution');
assert.ok(els.pathStatus.textContent.includes('无解'));
assert.equal(els.pathResults.hidden, true);

// 超过 4×4：搜索按钮禁用并给出原因
els.rowsInput.value = '3'; els.colsInput.value = '5';
els.createGridBtn.dispatch('click');
assert.equal(ui.plan.cols, 5, '输入框 5 在 1..12 范围内应被接受');
ui.renderPathfind();
assert.equal(els.pathSearchBtn.disabled, true);
assert.ok(els.pathStatus.textContent.includes('4×4'));

// 前缀非法折叠时寻路禁用
els.rowsInput.value = '1'; els.colsInput.value = '3';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
ui.requestStep({ axis: 'v', line: 2, dir: 'l' });   // 厚度冲突，被拒绝
assert.equal(ui.plan.steps.length, 1);
// 只有 1 步合法，末态合法可寻路；制造一个真正的非法前缀：直接塞入非法步
ui.plan.steps.push({ axis: 'v', line: 2, dir: 'l' });
ui.renderPathfind();
assert.equal(els.pathSearchBtn.disabled, true);
assert.ok(/非法/.test(els.pathStatus.textContent));

console.log('前端冒烟流程全部通过');
