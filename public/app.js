'use strict';
/* global FoldEngine */

const E = FoldEngine;
const CELL = 88;
const PAD = 64;

// ---------- 应用状态 ----------
const app = {
  plan: { name: '未命名方案', rows: 0, cols: 0, labels: {}, steps: [] },
  upto: 0,                  // 当前回放到第几步
  replay: null,             // { state, error }
  loadedId: null,
  hitCells: [],             // 画布可点击格位
  hitHandles: [],           // 画布折叠手柄
  hoverHandle: null,
  editingCell: null,
  playTimer: null,
  imposition: { eligible: null, result: null, sig: null },  // 自动拼版状态
  pathfind: { result: null, sig: null, gridKey: null }       // 折手自动寻路状态
};

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

// ---------- 初始化 ----------
function init() {
  $('createGridBtn').addEventListener('click', createGrid);
  document.querySelectorAll('button.fold').forEach((b) =>
    b.addEventListener('click', () => addStepFromForm(b.dataset.dir)));
  $('axisSelect').addEventListener('change', refreshLineSelect);

  $('firstBtn').addEventListener('click', () => setUpto(0));
  $('prevBtn').addEventListener('click', () => setUpto(app.upto - 1));
  $('nextBtn').addEventListener('click', () => setUpto(app.upto + 1));
  $('playBtn').addEventListener('click', togglePlay);
  $('stepSlider').addEventListener('input', (e) => setUpto(Number(e.target.value)));

  $('delStepBtn').addEventListener('click', truncateSteps);
  $('clearStepsBtn').addEventListener('click', () => {
    if (!app.plan.steps.length) return;
    app.plan.steps = [];
    setUpto(0, true);
  });

  $('saveBtn').addEventListener('click', savePlan);
  $('exportBtn').addEventListener('click', exportPlan);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importPlan);
  $('loadListBtn').addEventListener('click', loadList);
  $('deletePlanBtn').addEventListener('click', deleteLoaded);

  $('editorCancel').addEventListener('click', () => $('cellEditor').hidden = true);
  $('editorOk').addEventListener('click', commitEditor);

  $('imposePreviewBtn').addEventListener('click', previewImposition);
  $('imposeConfirmBtn').addEventListener('click', confirmImposition);
  $('imposeCancelBtn').addEventListener('click', closeImposition);
  $('imposeStart').addEventListener('input', renderImposition);
  $('imposeCount').addEventListener('input', renderImposition);

  $('pathSearchBtn').addEventListener('click', runPathfind);

  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('mousemove', onCanvasMove);
  canvas.addEventListener('mouseleave', () => { app.hoverHandle = null; draw(); });
  $('planName').addEventListener('input', (e) => { app.plan.name = e.target.value; });

  // 默认演示网格
  createGrid();
}

// ---------- 网格 / 方案 ----------
function createGrid() {
  const rows = clampInt($('rowsInput').value, 1, 12, 2);
  const cols = clampInt($('colsInput').value, 1, 12, 2);
  app.plan = { name: $('planName').value || '未命名方案', rows, cols, labels: {}, steps: [] };
  app.loadedId = null;
  setUpto(0, true);
  refreshLineSelect();
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function refreshLineSelect() {
  const axis = $('axisSelect').value;
  const n = axis === 'v' ? app.plan.cols : app.plan.rows;
  const sel = $('lineSelect');
  sel.innerHTML = '';
  if (n < 2) {
    const o = document.createElement('option');
    o.textContent = '（该方向只有一格，无折线）';
    o.value = '';
    sel.appendChild(o);
    return;
  }
  for (let k = 1; k < n; k++) {
    const o = document.createElement('option');
    o.value = String(k);
    o.textContent = axis === 'v'
      ? `第 ${k} 条竖线（第 ${k} 与 ${k + 1} 列之间）`
      : `第 ${k} 条横线（第 ${k} 与 ${k + 1} 行之间）`;
    sel.appendChild(o);
  }
}

function addStepFromForm(dir) {
  const axis = $('axisSelect').value;
  const line = Number($('lineSelect').value);
  if (!line) {
    showFoldError({ code: 'contour', message: '当前网格该方向没有可用折线。', conflicts: [] });
    return;
  }
  const compatible = axis === 'v' ? (dir === 'l' || dir === 'r') : (dir === 'u' || dir === 'd');
  if (!compatible) {
    showFoldError({ code: 'contour', message: '折叠方向与折线不匹配：竖线只能左/右折，横线只能上/下折。', conflicts: [] });
    return;
  }
  requestStep({ axis, line, dir });
}

/**
 * 尝试追加一步：先在当前回放状态校验。
 * 若当前不在最新步，则先把回放推进到最新再校验（步骤只追加在末尾）。
 */
function requestStep(step) {
  // 校验基于“已应用此前所有步骤”的状态
  const base = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  const err = E.validateFold(base, step);
  if (err) {
    showFoldError(err);
    flashConflict(err);
    return;
  }
  app.plan.steps.push(step);
  clearFoldError();
  setUpto(app.plan.steps.length, true);
}

function flashConflict(err) {
  // 冲突以“应用全部已添加步骤后”的状态为底图显示
  const state = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  app.replay = { state, error: err };
  draw();
  renderControls();
  renderSteps();
  renderImposition();
  renderPathfind();
}

function truncateSteps() {
  app.plan.steps = app.plan.steps.slice(0, app.upto);
  setUpto(app.plan.steps.length, true);
}

// ---------- 回放 ----------
function setUpto(n, force) {
  const max = app.plan.steps.length;
  n = Math.max(0, Math.min(max, n));
  if (!force && n === app.upto && app.replay) return;
  app.upto = n;
  stopPlay();
  render();
}

function rerunReplay() {
  if (!app.plan.rows) { app.replay = null; return; }
  app.replay = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps, app.upto);
}

function togglePlay() {
  if (app.playTimer) { stopPlay(); return; }
  if (app.upto >= app.plan.steps.length) setUpto(0);
  $('playBtn').textContent = '⏸';
  app.playTimer = setInterval(() => {
    if (app.upto >= app.plan.steps.length) { stopPlay(); return; }
    setUpto(app.upto + 1);
  }, 800);
}
function stopPlay() {
  if (app.playTimer) clearInterval(app.playTimer);
  app.playTimer = null;
  $('playBtn').textContent = '▶';
}

// ---------- 渲染 ----------
function render() {
  rerunReplay();
  draw();
  renderSteps();
  renderSequence();
  renderControls();
  renderImposition();
  renderPathfind();
}

function renderControls() {
  const max = app.plan.steps.length;
  const slider = $('stepSlider');
  slider.max = String(max);
  slider.value = String(app.upto);
  $('stepLabel').textContent = `第 ${app.upto} / ${max} 步`;
  $('delStepBtn').disabled = app.upto === 0;
  $('clearStepsBtn').disabled = max === 0;
  $('prevBtn').disabled = app.upto === 0;
  $('nextBtn').disabled = app.upto >= max;
  $('canvasHint').textContent = app.plan.rows
    ? '点击纸格编辑正反面页码；点击网格边缘箭头添加折叠。红色虚线手柄表示该折非法。'
    : '先在左侧创建行列纸格。';

  const badge = $('statusBadge');
  if (app.replay && app.replay.error) {
    badge.className = 'badge err';
    badge.textContent = '冲突：' + (app.replay.error.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓');
  } else if (app.replay) {
    const info = E.pageSequence(app.replay.state);
    if (info.folded) { badge.className = 'badge ok'; badge.textContent = '已收成单叠'; }
    else { badge.className = 'badge idle'; badge.textContent = `${info.stacks.length} 个叠层`; }
  } else { badge.className = 'badge idle'; badge.textContent = ''; }
}

function renderSteps() {
  const ol = $('stepList');
  ol.innerHTML = '';
  if (!app.plan.steps.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '尚无步骤';
    ol.appendChild(li);
    return;
  }
  const dirText = { l: '◀ 向左折', r: '▶ 向右折', u: '▲ 向上折', d: '▼ 向下折' };
  // 逐步重放以标记非法步
  let st = E.initialState(app.plan.rows, app.plan.cols, app.plan.labels);
  app.plan.steps.forEach((s, i) => {
    const err = E.validateFold(st, s);
    const li = document.createElement('li');
    const pos = s.axis === 'v' ? `竖线 ${s.line}` : `横线 ${s.line}`;
    li.textContent = `${i + 1}. ${pos}，${dirText[s.dir]}`;
    if (err) {
      li.classList.add('bad');
      li.textContent += '（非法）';
    }
    if (i < app.upto && !err) li.classList.add('current');
    li.addEventListener('click', () => setUpto(i + 1));
    ol.appendChild(li);
    if (!err) st = E.applyFold(st, s);
  });
}

function renderSequence() {
  const box = $('sequenceBox');
  const foldState = $('foldState');
  box.innerHTML = '';
  if (!app.replay) {
    box.innerHTML = '<span class="muted">完成折叠后在此输出页码序列。</span>';
    foldState.textContent = '';
    return;
  }
  const { stacks, folded } = E.pageSequence(app.replay.state);
  stacks.forEach((grp, gi) => {
    if (stacks.length > 1) {
      const tag = document.createElement('div');
      tag.style.cssText = 'width:100%;font-size:12px;color:var(--muted)';
      tag.textContent = `叠层 @格(${grp.cell})，厚 ${grp.depth} 片`;
      box.appendChild(tag);
    }
    grp.sequence.forEach((label, i) => {
      if (i > 0) {
        const ar = document.createElement('span');
        ar.className = 'seq-arrow';
        ar.textContent = '→';
        box.appendChild(ar);
      }
      // 正立信息：封面到封底序列前半为各叶上面、后半为各叶下面
      const leafCount = grp.leaves.length;
      const leaf = grp.leaves[i < leafCount ? i : 2 * leafCount - 1 - i];
      const up = leaf && (i < leafCount ? leaf.upper.upright : leaf.lower.upright);
      const span = document.createElement('span');
      span.className = 'seq-page' + (label == null ? ' blank' : '') + (up ? '' : ' inverted');
      span.innerHTML = label == null
        ? '空白<span class="small">blank</span>'
        : escapeHtml(label) + (up ? '' : '<span class="small">⟲ 倒排</span>');
      span.title = up ? '页码正立' : '页码倒置 180°';
      box.appendChild(span);
    });
    if (gi < stacks.length - 1) {
      const gap = document.createElement('div');
      gap.style.cssText = 'width:100%;height:2px';
      box.appendChild(gap);
    }
  });
  foldState.textContent = folded
    ? '所有面片已收成单叠：上方序列即为从封面到封底的完整阅读顺序。'
    : `当前仍有 ${stacks.length} 个分离叠层，继续折叠直到单叠即可得到全书顺序。`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Canvas 绘制 ----------
function originXY(x, y) {
  return { x: PAD + x * CELL, y: PAD + y * CELL };
}

function draw() {
  app.hitCells = [];
  app.hitHandles = [];
  if (!app.plan.rows) {
    sizeCanvas(1, 1);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const w = app.plan.cols * CELL + PAD * 2;
  const h = app.plan.rows * CELL + PAD * 2;
  sizeCanvas(w, h);
  ctx.clearRect(0, 0, w, h);

  // 原始网格淡线
  ctx.save();
  ctx.strokeStyle = '#eef1f5';
  ctx.lineWidth = 1;
  for (let x = 0; x <= app.plan.cols; x++) {
    line(PAD + x * CELL, PAD, PAD + x * CELL, PAD + app.plan.rows * CELL);
  }
  for (let y = 0; y <= app.plan.rows; y++) {
    line(PAD, PAD + y * CELL, PAD + app.plan.cols * CELL, PAD + y * CELL);
  }
  ctx.restore();

  const state = app.replay ? app.replay.state : null;
  const err = app.replay ? app.replay.error : null;
  const conflicts = new Set(err ? err.conflicts : []);
  const movingCells = app.hoverHandle ? previewMoving(app.hoverHandle) : new Set();

  if (state) {
    for (const [cellKey, ids] of Object.entries(state.stacks)) {
      const [cx, cy] = cellKey.split(',').map(Number);
      drawStack(cx, cy, ids, state, conflicts.has(cellKey), movingCells.has(cellKey));
    }
  }

  drawFoldHandles();
}

function sizeCanvas(w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.aspectRatio = `${w} / ${h}`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function line(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawStack(cx, cy, ids, state, conflict, moving) {
  const { x, y } = originXY(cx, cy);
  const depth = ids.length;

  // 叠层阴影面片
  for (let i = depth - 1; i >= 1; i--) {
    roundRect(x + i * 2.5, y - i * 2.5, CELL - 8, CELL - 8, 6);
    ctx.fillStyle = '#f3ecd6';
    ctx.fill();
    ctx.strokeStyle = '#d8c795';
    ctx.stroke();
  }

  // 顶面片
  const top = state.panels[ids[0]];
  const { side, upright } = E.visibleFace(top);
  const label = top[side];
  roundRect(x, y, CELL - 8, CELL - 8, 6);
  ctx.fillStyle = conflict ? '#fde0dd' : moving ? '#dbeafe' : '#fdfaf1';
  ctx.fill();
  ctx.lineWidth = conflict ? 2.5 : moving ? 2 : 1.2;
  ctx.strokeStyle = conflict ? '#d64545' : moving ? '#2f6fed' : '#b99e5e';
  ctx.stroke();

  // 页码（朝向：倒置旋转 180°）
  ctx.save();
  ctx.translate(x + (CELL - 8) / 2, y + (CELL - 8) / 2);
  if (!upright) ctx.rotate(Math.PI);
  ctx.fillStyle = '#1f2933';
  ctx.font = 'bold 26px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label === '' ? '·' : label, 0, 2);
  ctx.restore();

  // 面别与厚度徽标
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = side === 'front' ? '#2f6fed' : '#7b4ed0';
  ctx.fillText(side === 'front' ? '正面↑' : '反面↑', x + 6, y + 13);
  if (depth > 1) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#b99e5e';
    roundRect(x + CELL - 34, y + 3, 24, 15, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#8a6d2f';
    ctx.textAlign = 'center';
    ctx.fillText(`×${depth}`, x + CELL - 22, y + 14);
  }
  if (!upright) {
    ctx.fillStyle = '#d64545';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('⟲倒', x + CELL - 12, y + CELL - 13);
  }

  app.hitCells.push({ x, y, w: CELL - 8, h: CELL - 8, cell: `${cx},${cy}` });
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- 折叠手柄 ----------
function allPossibleSteps() {
  const out = [];
  for (let k = 1; k < app.plan.cols; k++) {
    out.push({ axis: 'v', line: k, dir: 'r' });   // 左瓣向右落
    out.push({ axis: 'v', line: k, dir: 'l' });   // 右瓣向左落
  }
  for (let k = 1; k < app.plan.rows; k++) {
    out.push({ axis: 'h', line: k, dir: 'd' });
    out.push({ axis: 'h', line: k, dir: 'u' });
  }
  return out;
}

function drawFoldHandles() {
  if (!app.replay) return;
  const baseState = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  for (const step of allPossibleSteps()) {
    const err = E.validateFold(baseState, step);
    drawHandle(step, !!err, app.hoverHandle && app.hoverHandle.axis === step.axis
      && app.hoverHandle.line === step.line && app.hoverHandle.dir === step.dir);
  }
}

function handleRect(step) {
  const s = 18;
  const gap = 3;
  if (step.axis === 'v') {
    const gx = PAD + step.line * CELL;
    const y = 20;
    // 左按钮 ◀(dir=l)，右按钮 ▶(dir=r)，居中于网格线
    const x = step.dir === 'l' ? gx - s - gap / 2 : gx + gap / 2;
    return { x, y, w: s, h: s };
  }
  const gy = PAD + step.line * CELL;
  const x = 20;
  // 上按钮 ▲(dir=u)，下按钮 ▼(dir=d)，居中于网格线
  const y = step.dir === 'u' ? gy - s - gap / 2 : gy + gap / 2;
  return { x, y, w: s, h: s };
}

function drawHandle(step, invalid, hovered) {
  const r = handleRect(step);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = invalid ? '#fdecea' : hovered ? '#c5d8fb' : '#eaf1fe';
  ctx.fill();
  ctx.lineWidth = hovered ? 2 : 1;
  ctx.setLineDash(invalid ? [3, 2] : []);
  ctx.strokeStyle = invalid ? '#d64545' : '#2f6fed';
  ctx.stroke();
  ctx.setLineDash([]);

  // 指示线沿网格线画一段淡色虚线（非法为红）
  if (step.axis === 'v') {
    const gx = PAD + step.line * CELL;
    ctx.strokeStyle = invalid ? 'rgba(214,69,69,.5)' : 'rgba(47,111,237,.35)';
    ctx.setLineDash([4, 4]);
    line(gx, PAD - 4, gx, PAD + app.plan.rows * CELL + 4);
    ctx.setLineDash([]);
  } else {
    const gy = PAD + step.line * CELL;
    ctx.strokeStyle = invalid ? 'rgba(214,69,69,.5)' : 'rgba(47,111,237,.35)';
    ctx.setLineDash([4, 4]);
    line(PAD - 4, gy, PAD + app.plan.cols * CELL + 4, gy);
    ctx.setLineDash([]);
  }

  // 箭头：dir 表示落向
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  ctx.fillStyle = invalid ? '#d64545' : '#2f6fed';
  ctx.beginPath();
  const t = 5;
  if (step.dir === 'r') { ctx.moveTo(cx - t, cy - t); ctx.lineTo(cx + t, cy); ctx.lineTo(cx - t, cy + t); }
  if (step.dir === 'l') { ctx.moveTo(cx + t, cy - t); ctx.lineTo(cx - t, cy); ctx.lineTo(cx + t, cy + t); }
  if (step.dir === 'd') { ctx.moveTo(cx - t, cy - t); ctx.lineTo(cx, cy + t); ctx.lineTo(cx + t, cy - t); }
  if (step.dir === 'u') { ctx.moveTo(cx - t, cy + t); ctx.lineTo(cx, cy - t); ctx.lineTo(cx + t, cy + t); }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  app.hitHandles.push({ ...r, step });
}

function previewMoving(handle) {
  const set = new Set();
  if (!app.replay) return set;
  const state = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  const { axis, line, dir } = handle;
  const movingSide = { r: 'l', l: 'r', d: 'u', u: 'd' }[dir];
  for (const cell of Object.keys(state.stacks)) {
    const [cx, cy] = cell.split(',').map(Number);
    const side = axis === 'v' ? (cx < line ? 'l' : 'r') : (cy < line ? 'u' : 'd');
    if (side === movingSide) set.add(cell);
  }
  return set;
}

// ---------- 画布交互 ----------
function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    x: (e.clientX - rect.left) * (canvas.width / dpr) / rect.width,
    y: (e.clientY - rect.top) * (canvas.height / dpr) / rect.height
  };
}

function hitAt(p) {
  for (const h of app.hitHandles) {
    if (p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h) return { type: 'handle', h };
  }
  for (const c of app.hitCells) {
    if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) return { type: 'cell', c };
  }
  return null;
}

function onCanvasClick(e) {
  const hit = hitAt(canvasPoint(e));
  if (!hit) return;
  if (hit.type === 'handle') requestStep(hit.h.step);
  else openEditor(hit.c.cell);
}

function onCanvasMove(e) {
  const hit = hitAt(canvasPoint(e));
  const hh = hit && hit.type === 'handle' ? hit.h.step : null;
  const changed = JSON.stringify(hh || {}) !== JSON.stringify(app.hoverHandle || {});
  app.hoverHandle = hh;
  canvas.style.cursor = hit ? 'pointer' : 'default';
  if (changed) draw();
}

// ---------- 纸格编辑器 ----------
function openEditor(cellKey) {
  if (!app.replay) return;
  const state = app.replay.state;
  const ids = state.stacks[cellKey];
  if (!ids) return;
  app.editingCell = cellKey;
  const box = $('editorRows');
  box.innerHTML = '';
  $('editorOrigin').textContent = `当前格 (${cellKey})，叠 ${ids.length} 片`;

  const wrap = document.createElement('div');
  wrap.className = 'leaves-edit';
  ids.forEach((id) => {
    const p = state.panels[id];
    const key = E.key(p.ox, p.oy);
    const cur = app.plan.labels[key] || { front: '', back: '' };
    const row = document.createElement('div');
    row.className = 'leaf-row';
    row.dataset.key = key;
    row.innerHTML = `
      <div>
        <div class="tag">原格 (${key}) · 正面页码</div>
        <input data-face="front" type="text" maxlength="8" value="${escapeHtml(cur.front || '')}" />
      </div>
      <div>
        <div class="tag">原格 (${key}) · 反面页码</div>
        <input data-face="back" type="text" maxlength="8" value="${escapeHtml(cur.back || '')}" />
      </div>`;
    wrap.appendChild(row);
  });
  box.appendChild(wrap);
  $('cellEditor').hidden = false;
}

function commitEditor() {
  document.querySelectorAll('#editorRows .leaf-row').forEach((row) => {
    const key = row.dataset.key;
    const front = row.querySelector('input[data-face="front"]').value.trim();
    const back = row.querySelector('input[data-face="back"]').value.trim();
    if (front || back) app.plan.labels[key] = { front, back };
    else delete app.plan.labels[key];
  });
  $('cellEditor').hidden = true;
  render();
}

// ---------- 自动拼版 ----------
/** 方案几何签名：网格、标注或折叠步骤变化后旧预览即失效（回放到不同步不影响）。 */
function planSignature() {
  return JSON.stringify({
    r: app.plan.rows, c: app.plan.cols,
    l: app.plan.labels, s: app.plan.steps
  });
}

function readImposeInputs() {
  return { start: Number($('imposeStart').value), count: Number($('imposeCount').value) };
}

/** 渲染拼版卡片：可用状态、禁用原因、预览内容。 */
function renderImposition() {
  if (!app.plan.rows) {
    app.imposition.eligible = null;
    $('imposePreviewBtn').disabled = true;
    $('imposeStatus').textContent = '先在左侧创建行列纸格并完成折叠。';
    $('imposeStatus').className = 'hint';
    $('imposePreview').hidden = true;
    app.imposition.result = null;
    return;
  }
  const elig = E.impositionEligibility(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps);
  app.imposition.eligible = elig;

  const countInput = $('imposeCount');
  if (elig.ok) {
    countInput.max = String(elig.capacity);
    if (!countInput.placeholder) countInput.placeholder = String(elig.capacity);
    $('imposePreviewBtn').disabled = false;
    $('imposeStatus').textContent = `可拼版：容量 ${elig.capacity} 面（${app.plan.rows}×${app.plan.cols} 格 × 正反 2 面）。`;
    $('imposeStatus').className = 'hint impose-status-ok';
  } else {
    countInput.removeAttribute('max');
    $('imposePreviewBtn').disabled = true;
    const why = elig.code === 'not_single_stack'
      ? `未收成单叠：${elig.message}`
      : `禁用生成：${elig.message}`;
    $('imposeStatus').textContent = why;
    $('imposeStatus').className = 'hint impose-status-err';
    closeImposition();
    return;
  }

  // 旧预览的方案已被改动 → 作废
  if (app.imposition.result && app.imposition.sig !== planSignature()) {
    closeImposition();
  }
  if (app.imposition.result) renderImpositionPreview(app.imposition.result);
}

function closeImposition() {
  app.imposition.result = null;
  app.imposition.sig = null;
  $('imposePreview').hidden = true;
}

/** 点击“生成预览”：仅计算并展示，绝不直接改写当前标注。 */
function previewImposition() {
  const { start, count } = readImposeInputs();
  const result = E.autoImpose(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps, start, count);
  if (!result.ok) {
    closeImposition();
    $('imposeStatus').textContent = '禁用生成：' + result.message;
    $('imposeStatus').className = 'hint impose-status-err';
    return;
  }
  app.imposition.result = result;
  app.imposition.sig = planSignature();
  $('imposePreview').hidden = false;
  renderImpositionPreview(result);
}

function faceText(face) {
  return face === 'front'
    ? '<span class="imp-face-front">正面</span>'
    : '<span class="imp-face-back">反面</span>';
}

function renderImpositionPreview(result) {
  // 摘要
  const blankNote = result.blankTrailing > 0
    ? `；末尾 ${result.blankTrailing} 个槽位为空白（已标明所属纸格与面）`
    : '';
  $('imposeSummary').innerHTML =
    `将向封面→封底共 <b>${result.capacity}</b> 个阅读槽位填入页码 ` +
    `<b>${result.startPage}–${result.startPage + result.pageCount - 1}</b>` +
    `（${result.pageCount} 页）${blankNote}。预览不会改动当前标注，确认后才批量写入。`;

  // 覆盖汇总（现有标注非空时）
  const overwrites = E.impositionOverwrite(app.plan.labels, result);
  const ovBox = $('imposeOverwrite');
  if (overwrites.length) {
    ovBox.hidden = false;
    const faceName = { front: '正面', back: '反面' };
    const lines = overwrites.map((o) => {
      const target = o.blanked ? '<b>空白</b>' : `“${escapeHtml(o.to)}”`;
      return `格(${o.cell}) ${faceName[o.face]}：“${escapeHtml(o.from)}” → ${target}`;
    });
    ovBox.innerHTML = `⚠ 确认后将覆盖 ${overwrites.length} 处现有标注：<br>${lines.join('<br>')}`;
  } else {
    ovBox.hidden = true;
    ovBox.textContent = '';
  }

  // 槽位表
  const tbody = $('imposeRows');
  tbody.innerHTML = '';
  result.slots.forEach((s, i) => {
    const tr = document.createElement('tr');
    if (s.blank) tr.className = 'blank-slot';
    if (i === 0) tr.classList.add('slot-cover');
    if (i === result.slots.length - 1) tr.classList.add('slot-backcover');
    const posName = i === 0 ? '槽 1（封面）'
      : i === result.slots.length - 1 ? `槽 ${i + 1}（封底）`
      : `槽 ${i + 1}`;
    const pageCell = s.blank
      ? '<span class="muted">空白</span>'
      : `<span class="imp-page">${escapeHtml(s.page)}</span>`;
    const upright = s.upright
      ? '正立'
      : '<span class="imp-inv" title="页码倒置 180°">⟲ 倒排</span>';
    tr.innerHTML =
      `<td>${posName}</td>` +
      `<td>${pageCell}</td>` +
      `<td>格(${s.origin}) · ${faceText(s.face)}</td>` +
      `<td>${upright}</td>`;
    tbody.appendChild(tr);
  });
}

/** 用户确认后批量写入（仅在此刻改写 labels）。 */
function confirmImposition() {
  const result = app.imposition.result;
  if (!result || app.imposition.sig !== planSignature()) return;
  const overwrites = E.impositionOverwrite(app.plan.labels, result);
  if (overwrites.length) {
    const faceName = { front: '正面', back: '反面' };
    const detail = overwrites.map((o) =>
      `格(${o.cell}) ${faceName[o.face]} “${o.from}”→${o.blanked ? '空白' : '“' + o.to + '”'}`).join('\n');
    if (!confirm(`以下 ${overwrites.length} 处现有标注将被覆盖：\n${detail}\n\n确认写入自动拼版页码？`)) return;
  }
  app.plan.labels = JSON.parse(JSON.stringify(result.labels));
  closeImposition();
  setUpto(app.upto, true);
  $('saveMsg').textContent =
    `已按自动拼版写入 ${result.pageCount} 个页码（${result.blankTrailing} 个尾部槽位留空），记得保存方案。`;
}

// ---------- 折手自动寻路 ----------
/**
 * 寻路基于“方案全部步骤回放”的末态；只要方案几何（网格/标注/步骤）变化，
 * 旧结果即作废。寻路起点与回放到第几步（upto）无关。
 */
function pathfindSignature() {
  return JSON.stringify({
    r: app.plan.rows, c: app.plan.cols,
    l: app.plan.labels, s: app.plan.steps
  });
}

/** 重建“封面原格”下拉（仅在网格尺寸变化时重建，保留用户选择）。 */
function refreshPathCells() {
  const key = `${app.plan.rows}x${app.plan.cols}`;
  if (app.pathfind.gridKey === key) return;
  app.pathfind.gridKey = key;
  const sel = $('pathCell');
  const prev = sel.value;
  sel.innerHTML = '';
  if (!app.plan.rows) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '（先创建网格）';
    sel.appendChild(o);
    return;
  }
  for (let y = 0; y < app.plan.rows; y++) {
    for (let x = 0; x < app.plan.cols; x++) {
      const id = `${x},${y}`;
      const lab = app.plan.labels[id] || {};
      const f = lab.front || '', b = lab.back || '';
      const o = document.createElement('option');
      o.value = id;
      o.textContent = `原格(${id})` + (f || b ? `  正:${f || '空'} / 反:${b || '空'}` : '');
      sel.appendChild(o);
    }
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderPathfind() {
  refreshPathCells();
  const btn = $('pathSearchBtn');
  const status = $('pathStatus');
  if (!app.plan.rows) {
    btn.disabled = true;
    status.className = 'hint';
    status.textContent = '先在左侧创建行列纸格。';
    $('pathResults').hidden = true;
    app.pathfind.result = null;
    return;
  }
  if (app.plan.rows > 4 || app.plan.cols > 4) {
    btn.disabled = true;
    status.className = 'hint path-status-err';
    status.textContent = `自动寻路仅支持不超过 4×4 的网格（当前为 ${app.plan.rows}×${app.plan.cols}）。`;
    $('pathResults').hidden = true;
    app.pathfind.result = null;
    return;
  }
  // 末态合法性：当前方案全部步骤必须可回放
  const full = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps);
  if (full.error) {
    btn.disabled = true;
    status.className = 'hint path-status-err';
    status.textContent = `当前方案第 ${full.error.stepIndex + 1} 步非法（${
      full.error.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓'}），请先修正后再寻路。`;
    $('pathResults').hidden = true;
    app.pathfind.result = null;
    return;
  }
  btn.disabled = false;
  if (!app.pathfind.result) {
    status.className = 'hint';
    status.textContent = '从当前方案全部步骤的末态开始搜索；搜索不会改动当前步骤。';
    $('pathResults').hidden = true;
  } else if (app.pathfind.sig !== pathfindSignature() || app.pathfind.target !== `${$('pathCell').value}|${$('pathFace').value}`) {
    // 方案或目标变化后旧结果作废
    app.pathfind.result = null;
    renderPathfind();
    return;
  } else {
    renderPathResults(app.pathfind.result);
  }
}

/** 点击搜索：先显示“搜索中”，下一帧再执行同步 BFS（≤2s），避免界面无反馈。 */
function runPathfind() {
  if (!app.plan.rows || app.plan.rows > 4 || app.plan.cols > 4) return;
  if (!$('pathCell').value) return;
  const btn = $('pathSearchBtn');
  btn.disabled = true;
  $('pathStatus').className = 'hint';
  $('pathStatus').textContent = '搜索中…（最多 8 步、2 秒）';
  $('pathResults').hidden = true;
  setTimeout(doPathfindSearch, 20);
}

function doPathfindSearch() {
  const target = { cell: $('pathCell').value, face: $('pathFace').value };
  const status = $('pathStatus');
  let result;
  try {
    result = E.findFoldPath(
      app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps,
      target, { maxDepth: 8, timeoutMs: 2000 });
  } catch (e) {
    result = { ok: false, code: 'bad_prefix', message: e.message };
  }
  $('pathSearchBtn').disabled = false;
  if (!result.ok) {
    status.className = 'hint path-status-err';
    status.textContent = '无法搜索：' + result.message;
    app.pathfind.result = null;
    $('pathResults').hidden = true;
    return;
  }
  app.pathfind.result = result;
  app.pathfind.sig = pathfindSignature();
  app.pathfind.target = `${target.cell}|${target.face}`;
  renderPathResults(result);
}

function renderPathResults(result) {
  const status = $('pathStatus');
  const box = $('pathResults');
  box.innerHTML = '';
  if (!result.solved) {
    box.hidden = true;
    status.className = 'hint path-status-err';
    if (result.reason === 'no_solution') {
      status.textContent = `无解：${result.message}`;
    } else {
      status.textContent = `搜索超限：${result.message}`;
    }
    return;
  }
  box.hidden = false;
  status.className = 'hint path-status-ok';
  const faceName = result.solutions[0].coverFace === 'front' ? '正面' : '反面';
  status.textContent =
    `找到 ${result.solutions.length} 条等长最短方案：各需 ${result.depth} 个后续步骤` +
    `，封面 = 原格(${result.solutions[0].topPanel}) 的${faceName}朝上（共枚举 ${result.searched.states} 个状态）。`;

  result.solutions.forEach((sol, i) => {
    const card = document.createElement('div');
    card.className = 'path-sol';
    const head = document.createElement('div');
    head.className = 'path-sol-head';
    const title = document.createElement('b');
    title.textContent = `方案 ${i + 1}（${sol.steps.length} 步）`;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `收成于格(${sol.finalCell})`;
    const addBtn = document.createElement('button');
    addBtn.className = 'primary';
    addBtn.textContent = '追加到当前步骤并回放';
    addBtn.addEventListener('click', () => appendPathSolution(sol));
    head.append(title, meta, addBtn);
    card.appendChild(head);

    const ol = document.createElement('ol');
    ol.className = 'path-step-list';
    sol.steps.forEach((st, j) => {
      const li = document.createElement('li');
      li.textContent = `第 ${app.plan.steps.length + j + 1} 步：${E.describeStep(st)}`;
      ol.appendChild(li);
    });
    card.appendChild(ol);
    box.appendChild(card);
  });
}

/** 把任一搜索方案追加为后续步骤，进入既有回放流程（末态）。 */
function appendPathSolution(sol) {
  if (!app.pathfind.result || app.pathfind.sig !== pathfindSignature()) return;
  for (const st of sol.steps) {
    const base = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
    if (E.validateFold(base, st)) return;   // 理论上不会发生（方案由合法路径给出）
    app.plan.steps.push({ axis: st.axis, line: st.line, dir: st.dir });
  }
  app.pathfind.result = null;   // 末态已变，旧结果作废
  clearFoldError();
  setUpto(app.plan.steps.length, true);
  $('saveMsg').textContent = '已把自动寻路方案追加到当前步骤，可继续编辑或保存。';
}

// ---------- 错误提示 ----------
function showFoldError(err) {
  const box = $('foldError');
  box.hidden = false;
  box.textContent =
    (err.code === 'thickness' ? '⛔ 拒绝执行：两侧厚度不一致。' : '⛔ 拒绝执行：折线不在当前外轮廓。')
    + '\n' + err.message
    + (err.conflicts.length ? `\n冲突纸格：${[...new Set(err.conflicts)].join('、')}（画布中红底标出）` : '');
}
function clearFoldError() { $('foldError').hidden = true; }

// ---------- 存取 ----------
function planPayload() {
  return {
    name: $('planName').value || '未命名方案',
    rows: app.plan.rows,
    cols: app.plan.cols,
    labels: app.plan.labels,
    steps: app.plan.steps
  };
}

function applyPlan(plan, id) {
  const p = E.normalizePlan(plan);
  app.plan = p;
  app.loadedId = id || null;
  $('planName').value = p.name;
  $('rowsInput').value = p.rows;
  $('colsInput').value = p.cols;
  refreshLineSelect();
  setUpto(p.steps.length, true);
  $('deletePlanBtn').hidden = !id;
  $('saveMsg').textContent = id ? `已载入服务器存档 ${id}` : '已载入 JSON 文件';
}

async function savePlan() {
  if (!app.plan.rows) { $('saveMsg').textContent = '请先创建网格。'; return; }
  try {
    const resp = await fetch('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...planPayload(), id: app.loadedId || undefined })
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error.message);
    app.loadedId = data.id;
    $('deletePlanBtn').hidden = false;
    $('saveMsg').textContent = `已保存：${data.id}（${new Date().toLocaleTimeString()}）`;
  } catch (e) {
    $('saveMsg').textContent = '保存失败：' + e.message;
  }
}

function exportPlan() {
  if (!app.plan.rows) { $('saveMsg').textContent = '请先创建网格。'; return; }
  const blob = new Blob([JSON.stringify(planPayload(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fold-plan-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importPlan(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyPlan(JSON.parse(reader.result), null);
    } catch (err) {
      alert('方案 JSON 无法载入：\n' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

async function loadList() {
  const ul = $('planList');
  ul.hidden = false;
  ul.innerHTML = '<li class="muted">加载中…</li>';
  try {
    const resp = await fetch('/api/plans');
    const items = await resp.json();
    ul.innerHTML = '';
    if (!items.length) {
      ul.innerHTML = '<li class="muted">服务器上还没有存档</li>';
      return;
    }
    items.forEach((it) => {
      const li = document.createElement('li');
      const info = document.createElement('span');
      info.textContent = `${it.name}（${it.rows}×${it.cols}，${it.steps} 步）`;
      const btn = document.createElement('button');
      btn.textContent = '载入';
      btn.addEventListener('click', async () => {
        const r = await fetch(`/api/plans/${it.id}`);
        applyPlan(await r.json(), it.id);
      });
      li.append(info, btn);
      ul.appendChild(li);
    });
  } catch (e) {
    ul.innerHTML = `<li class="muted">读取失败：${e.message}</li>`;
  }
}

async function deleteLoaded() {
  if (!app.loadedId) return;
  if (!confirm('确定删除服务器上的该存档？')) return;
  await fetch(`/api/plans/${app.loadedId}`, { method: 'DELETE' });
  app.loadedId = null;
  $('deletePlanBtn').hidden = true;
  $('saveMsg').textContent = '已删除存档（本地方案仍保留）';
}

init();

// 暴露给自动化检查（浏览器中无害）
if (typeof window !== 'undefined') {
  window.__foldApp = Object.assign(app, {
    requestStep, setUpto, createGrid, render, getFoldError: () => $('foldError'),
    previewImposition, confirmImposition, closeImposition, renderImposition,
    readImposeInputs, runPathfind, doPathfindSearch, appendPathSolution, renderPathfind
  });
}
