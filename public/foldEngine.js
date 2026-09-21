'use strict';
/**
 * foldEngine.js —— 纯逻辑折叠模拟引擎（无 DOM 依赖，可独立单元测试）
 *
 * 模型约定
 * --------
 * 1. 一张 rows × cols 的行列纸格，每格(leaf)为一片纸：
 *      front: 正面页码（纸张的 +z 面）
 *      back : 反面页码（纸张的 -z 面）
 *    页码均为字符串，空串表示该面空白。
 *
 * 2. 每个状态中，被占用的格位(cell)上叠放若干面片(panel，即折后叶子)。
 *    stack[cell] 自上而下排列：index 0 = 最上层。
 *
 * 3. 每个面片带一个 3×3 朝向标架 {x, y, n}，均为单位向量：
 *      x：面片自身“右”方向在世界坐标中的投影
 *      y：面片自身“下”方向在世界坐标中的投影
 *      n：面片正面法线
 *    初始为 {x:(1,0,0), y:(0,1,0), n:(0,0,1)}。
 *
 * 4. 折叠步骤 { axis:'v'|'h', line:number, dir:'l'|'r'|'u'|'d' }
 *      line=k：位于第 k-1 与第 k 列/行之间的网格线（1 ≤ k < 列数/行数）。
 *      dir：纸瓣翻转后“落向”的一侧——
 *      axis='v'：dir='r' 左瓣向右翻过竖线（移动 cx<line 的格），dir='l' 右瓣向左翻；
 *      axis='h'：dir='d' 上瓣向下翻（移动 cy<line 的格），dir='u' 下瓣向上翻。
 *    每次折叠都是 180°，移动侧格位镜像到另一侧并叠放。
 *
 * 拒绝规则（两类冲突，不执行折叠）
 *  --------
 *    contour   折线不在当前外轮廓上：移动侧为空，或移动侧镜像后出现悬空
 *              （目标格在当前外轮廓之外 / 折线跨度上没有成对的格位）。
 *    thickness 两侧厚度不一致：镜像落点的静止侧层数与移动侧层数不相等
 *              （包折、不等厚折法被拒绝，这正是印张折手要排查的情况）。
 */

// ---------- 小工具 ----------
function key(x, y) { return `${x},${y}`; }
function neg(a) {
  const nz = (v) => (v === 0 ? 0 : -v);   // 避免出现 -0
  return { x: nz(a.x), y: nz(a.y), z: nz(a.z) };
}

function initialState(rows, cols, labels) {
  rows = Math.max(1, Math.floor(rows));
  cols = Math.max(1, Math.floor(cols));
  const panels = {};
  const stacks = {};
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const id = key(x, y);
      const lab = (labels && labels[id]) || {};
      panels[id] = {
        id,
        ox: x, oy: y,
        cx: x, cy: y,                 // 当前所在格位
        front: lab.front != null ? String(lab.front) : '',
        back: lab.back != null ? String(lab.back) : '',
        frame: {
          x: { x: 1, y: 0, z: 0 },
          y: { x: 0, y: 1, z: 0 },
          n: { x: 0, y: 0, z: 1 }
        }
      };
      stacks[key(x, y)] = [id];
    }
  }
  return { rows, cols, panels, stacks };
}

function cloneState(s) {
  return {
    rows: s.rows,
    cols: s.cols,
    panels: Object.fromEntries(Object.entries(s.panels).map(([id, p]) =>
      [id, { ...p, frame: { x: { ...p.frame.x }, y: { ...p.frame.y }, n: { ...p.frame.n } } }])),
    stacks: Object.fromEntries(Object.entries(s.stacks).map(([k, arr]) => [k, arr.slice()]))
  };
}

/**
 * 坐标约定：格位使用 0 基索引，折线 line=k 是第 k-1 与第 k 列/行之间的网格线，
 * 因此关于该线的镜像为 i' = 2k - 1 - i（0→1，2→1，依此类推）。
 */
function reflectIndex(i, line) { return 2 * line - 1 - i; }

/**
 * 校验一次折叠。
 * @returns null 表示可执行；否则 { code:'contour'|'thickness', message, conflicts:[cellKey,...] }
 */
function validateFold(state, step) {
  const { axis, line, dir } = step;
  const dirOk = axis === 'v' ? (dir === 'l' || dir === 'r') : (dir === 'u' || dir === 'd');
  if (!dirOk) {
    return { code: 'contour', message: '折叠方向与折线方向不匹配', conflicts: [] };
  }
  if (axis === 'v' && (line <= 0 || line >= state.cols || !Number.isInteger(line))) {
    return { code: 'contour', message: `竖直折线 x=${line} 超出当前网格 [0, ${state.cols}]`, conflicts: [] };
  }
  if (axis === 'h' && (line <= 0 || line >= state.rows || !Number.isInteger(line))) {
    return { code: 'contour', message: `水平折线 y=${line} 超出当前网格 [0, ${state.rows}]`, conflicts: [] };
  }

  // 方向 = 纸瓣翻动后落向的一侧：
  //   dir='r'（向右折）移动左瓣(cx<line)；dir='l' 移动右瓣(cx>line)；
  //   dir='d'（向下折）移动上瓣(cy<line)；dir='u' 移动下瓣(cy>line)。
  const sideByDir = { r: 'l', l: 'r', d: 'u', u: 'd' };
  const movingSide = sideByDir[dir];
  const occupied = new Set(Object.keys(state.stacks));
  const moving = [];
  for (const cell of occupied) {
    const [cx, cy] = cell.split(',').map(Number);
    const side = axis === 'v' ? (cx < line ? 'l' : 'r')
                              : (cy < line ? 'u' : 'd');
    if (side !== movingSide) continue;
    const tx = axis === 'v' ? reflectIndex(cx, line) : cx;
    const ty = axis === 'h' ? reflectIndex(cy, line) : cy;
    moving.push({ from: cell, fx: cx, fy: cy, to: key(tx, ty), tx, ty, depth: state.stacks[cell].length });
  }

  if (moving.length === 0) {
    return { code: 'contour', message: '折线该侧没有面片，折线不在当前外轮廓上', conflicts: [] };
  }

  // —— 外轮廓检查 ——
  // 每个移动格镜像后的落点必须是当前已占用格位：要么压到静止瓣格位，
  // 要么与另一移动格配对（等宽对折时瓣内两列镜像到同一格列）。
  // 只要有移动格镜像到空格位，就是越过当前外轮廓的悬空折（包含宽瓣
  // 越过静止块边缘、折线位于纸片内部缝隙等情况）。
  const contourConflicts = new Set();
  const movingFrom = new Set(moving.map((m) => m.from));
  for (const m of moving) {
    const targetIsMoving = movingFrom.has(m.to);
    const targetIsStill = occupied.has(m.to) && !targetIsMoving;
    if (!targetIsMoving && !targetIsStill) {
      contourConflicts.add(m.from);
      contourConflicts.add(m.to);
    }
  }
  if (contourConflicts.size) {
    return {
      code: 'contour',
      message: '折线不在当前外轮廓上：移动纸格镜像后落到轮廓之外（悬空纸格）',
      conflicts: [...contourConflicts]
    };
  }

  // —— 厚度一致性检查 ——
  // 移动格压到静止格位时，两侧层数必须相等（等厚折帖）；
  // 落点只是另一移动格（瓣内配对）时，配对两侧都是同一移动瓣，不做对比。
  const thicknessConflicts = new Set();
  let mismatch = false;
  for (const m of moving) {
    if (movingFrom.has(m.to)) continue;
    const stillDepth = state.stacks[m.to].length;
    if (stillDepth !== m.depth) {
      mismatch = true;
      thicknessConflicts.add(m.from);
      thicknessConflicts.add(m.to);
    }
  }
  if (mismatch) {
    return {
      code: 'thickness',
      message: '折线两侧厚度不一致：目标格层数与移动格层数不相等（疑似包折/不等厚折）',
      conflicts: [...thicknessConflicts]
    };
  }
  return null;
}

/** 执行折叠（调用前先 validateFold）。返回新状态。 */
function applyFold(state, step) {
  const bad = validateFold(state, step);
  if (bad) {
    const e = new Error(bad.message);
    e.code = bad.code;
    e.conflicts = bad.conflicts;
    throw e;
  }
  const { axis, line, dir } = step;
  const movingSide = { r: 'l', l: 'r', d: 'u', u: 'd' }[dir];
  const next = cloneState(state);

  // 收集移动侧
  const movers = [];
  for (const cell of Object.keys(next.stacks)) {
    const [cx, cy] = cell.split(',').map(Number);
    const side = axis === 'v' ? (cx < line ? 'l' : 'r')
                              : (cy < line ? 'u' : 'd');
    if (side !== movingSide) continue;
    movers.push({ cell, cx, cy });
  }

  for (const m of movers) {
    const ids = next.stacks[m.cell];
    const tx = axis === 'v' ? reflectIndex(m.cx, line) : m.cx;
    const ty = axis === 'h' ? reflectIndex(m.cy, line) : m.cy;
    const toCell = key(tx, ty);

    // 翻转 180°：面片标架分量取负
    for (const id of ids) {
      const p = next.panels[id];
      if (axis === 'v') {
        p.frame.x = neg(p.frame.x);
        p.frame.n = neg(p.frame.n);
      } else {
        p.frame.y = neg(p.frame.y);
        p.frame.n = neg(p.frame.n);
      }
      p.cx = tx; p.cy = ty;
    }
    delete next.stacks[m.cell];

    // 翻面后整个移动叠自身倒序，再整体压到静止叠上方
    const flipped = ids.slice().reverse();
    const still = next.stacks[toCell] || [];
    next.stacks[toCell] = flipped.concat(still);
  }
  return next;
}

/**
 * 重放方案到指定步数。
 * @returns { state, error:null | {stepIndex, code, message, conflicts} }
 */
function replay(rows, cols, labels, steps, upto) {
  let state = initialState(rows, cols, labels);
  if (upto == null) upto = steps.length;
  for (let i = 0; i < upto; i++) {
    const err = validateFold(state, steps[i]);
    if (err) return { state, error: { stepIndex: i, ...err } };
    state = applyFold(state, steps[i]);
  }
  return { state, error: null };
}

/**
 * 取某面片“朝上”（法线朝向观察者，世界 +z）的面及正立信息。
 * @returns { side:'front'|'back', upright:boolean }
 *   印刷约定：正反面按书页长边翻转排版（上下边对齐），两面字形的
 *   “下”方向都随面片标架 frame.y 走；从上方阅读时 frame.y 指向屏幕下方为正立。
 */
function visibleFace(p) {
  const nUp = p.frame.n.z > 0;                 // 正面法线朝观察者
  const side = nUp ? 'front' : 'back';
  return { side, upright: p.frame.y.y > 0 };
}

/**
 * 判定某面从纸张外侧正视（世界 +y 为页首方向）时是否正立。
 * 正反面上下边对齐排版，字形“下”方向都随 frame.y：投影指向屏幕下方即正立，
 * 反向即页码倒置 180°（典型的水平折朝向错误可被检出）。
 */
function faceUpright(p) {
  return p.frame.y.y > 0;
}

/**
 * 输出叠层“从封面到封底”的页码序列。
 * 折帖为骑马钉式嵌套叶序：自上而下逐片取朝上页面，到达最内片后
 * 再自下而上取各片朝下页面。
 *   序列 = [leaf1上, leaf2上, …, leafN上, leafN下, …, leaf2下, leaf1下]
 *
 * @returns {
 *   stacks: [{ cell, leaves:[{panelId, upper, lower}], sequence:[...] }],
 *   folded: boolean   // 是否已收成单叠
 * }
 */
function pageSequence(state) {
  const out = [];
  for (const [cell, ids] of Object.entries(state.stacks)) {
    const leaves = [];
    for (const id of ids) {
      const p = state.panels[id];
      const upperSide = p.frame.n.z > 0 ? 'front' : 'back';
      const lowerSide = upperSide === 'front' ? 'back' : 'front';
      const mk = (side) => {
        const label = p[side] === '' ? null : p[side];
        return { face: side, label, upright: faceUpright(p) };
      };
      leaves.push({ panelId: id, upper: mk(upperSide), lower: mk(lowerSide) });
    }
    const sequence = leaves.map((l) => l.upper.label)
      .concat(leaves.slice().reverse().map((l) => l.lower.label));
    out.push({ cell, leaves, sequence, depth: ids.length });
  }
  out.sort((a, b) => b.depth - a.depth || a.cell.localeCompare(b.cell));
  return { stacks: out, folded: out.length === 1 };
}

/**
 * 自动拼版
 * --------
 * 仅当方案“全部步骤可合法回放且收成单叠”时才可用：
 * 按最终封面→封底的阅读槽位（pageSequence 单叠序列）依次写入连续页码，
 * 再反向映射到每个原始纸格（ox,oy）的正面/反面，得到一份新的 labels。
 *
 * - startPage：成品起始页码（≥1 整数）；
 * - pageCount：成品页数（≥1 且不超过纸格总面数 2×rows×cols）；
 * - 序列末尾的剩余槽位留空白（pageCount < 容量时），
 *   空白槽位仍会在 slots 中返回，并标明所属原始纸格与面。
 */

/** 计算自动拼版前置状态：网格合法 + 全步回放无冲突 + 收成单叠。 */
function impositionEligibility(rows, cols, labels, steps) {
  rows = Number(rows); cols = Number(cols);
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
    return {
      ok: false,
      code: 'bad_grid',
      message: '尚未创建合法的行列纸格（行数、列数都须为正整数）。',
      capacity: 0
    };
  }
  const r = replay(rows, cols, labels || {}, Array.isArray(steps) ? steps : []);
  if (r.error) {
    const e = r.error;
    return {
      ok: false,
      code: e.code === 'thickness' ? 'thickness' : 'contour',
      stepIndex: e.stepIndex,
      conflicts: e.conflicts,
      message: `存在非法折叠（第 ${e.stepIndex + 1} 步：${e.message}），无法自动拼版。`,
      capacity: 2 * rows * cols
    };
  }
  const info = pageSequence(r.state);
  if (!info.folded) {
    return {
      ok: false,
      code: 'not_single_stack',
      message: `折叠后仍有 ${info.stacks.length} 个分离叠层，尚未收成单叠，无法确定唯一阅读顺序。`,
      stackCount: info.stacks.length,
      capacity: 2 * rows * cols
    };
  }
  return { ok: true, state: r.state, info, capacity: 2 * rows * cols };
}

/**
 * 生成自动拼版结果（不改写任何现有标注）。
 * @returns 成功 {
 *   ok:true, startPage, pageCount, capacity, blankTrailing,
 *   labels: { "x,y": {front,back} },   // 两面皆空的纸格被省略
 *   slots: [{ slot, panelId, origin:"x,y", face:'front'|'back',
 *             page:String|null, blank, upright, position:'upper'|'lower' }]
 * }
 * 失败 { ok:false, code, message, ... }
 */
function autoImpose(rows, cols, labels, steps, startPage, pageCount) {
  const elig = impositionEligibility(rows, cols, labels, steps);
  if (!elig.ok) return elig;

  startPage = Number(startPage);
  pageCount = Number(pageCount);
  if (!Number.isInteger(startPage) || startPage < 1) {
    return { ok: false, code: 'bad_start', message: '起始页码须为不小于 1 的整数。', capacity: elig.capacity };
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return { ok: false, code: 'bad_count', message: '成品页数须为不小于 1 的整数。', capacity: elig.capacity };
  }
  if (pageCount > elig.capacity) {
    return {
      ok: false,
      code: 'too_many_pages',
      message: `成品页数 ${pageCount} 超出纸格总面数（容量 ${elig.capacity} 面 = ${rows}×${cols} 格 × 正反 2 面）。`,
      capacity: elig.capacity
    };
  }

  const grp = elig.info.stacks[0];
  const leafCount = grp.leaves.length;
  const slots = [];
  // 正向：封面起自上而下各叶“朝上”面；到达最内片后反向取各叶“朝下”面
  for (let i = 0; i < leafCount; i++) {
    const leaf = grp.leaves[i];
    slots.push({
      slot: slots.length, leafIndex: i, position: 'upper',
      panelId: leaf.panelId, face: leaf.upper.face,
      upright: !!leaf.upper.upright
    });
  }
  for (let i = leafCount - 1; i >= 0; i--) {
    const leaf = grp.leaves[i];
    slots.push({
      slot: slots.length, leafIndex: i, position: 'lower',
      panelId: leaf.panelId, face: leaf.lower.face,
      upright: !!leaf.lower.upright
    });
  }

  // 生成连续页码，超出成品页数的末尾槽位留空白
  slots.forEach((s) => {
    if (s.slot < pageCount) {
      s.page = String(startPage + s.slot);
      s.blank = false;
    } else {
      s.page = null;
      s.blank = true;
    }
  });

  // 反向映射到原始纸格正面/反面
  const next = {};
  const panels = elig.state.panels;
  for (const s of slots) {
    const p = panels[s.panelId];
    const origin = key(p.ox, p.oy);
    s.origin = origin;
    if (!next[origin]) next[origin] = { front: '', back: '' };
    next[origin][s.face] = s.blank ? '' : s.page;
  }

  // 与现有标注惯例一致：两面皆空的纸格不写入 labels
  const labelsOut = {};
  for (const [k, v] of Object.entries(next)) {
    if (v.front !== '' || v.back !== '') labelsOut[k] = { front: v.front, back: v.back };
  }

  return {
    ok: true,
    startPage,
    pageCount,
    capacity: elig.capacity,
    blankTrailing: Math.max(0, elig.capacity - pageCount),
    labels: labelsOut,
    slots
  };
}

/**
 * 汇总“现有标注 → 自动拼版结果”之间会被覆盖/清空的位置。
 * @returns [{ cell, face, from:string, to:string, blanked:boolean }]
 *   仅包含现有标注非空、且写入后内容发生变化的面。
 */
function impositionOverwrite(labels, result) {
  const out = [];
  if (!result || !result.ok) return out;
  const next = result.labels;
  for (const [cell, v] of Object.entries(labels || {})) {
    for (const face of ['front', 'back']) {
      const from = v && v[face] != null ? String(v[face]) : '';
      if (from === '') continue;
      const to = (next[cell] && next[cell][face]) || '';
      if (from !== to) {
        out.push({ cell, face, from, to, blanked: to === '' });
      }
    }
  }
  return out;
}

/** 方案校验/规整（载入 JSON 时使用） */
function normalizePlan(plan) {
  const errors = [];
  const rows = Number(plan.rows);
  const cols = Number(plan.cols);
  if (!Number.isInteger(rows) || rows < 1 || rows > 20) errors.push('rows 必须为 1..20 的整数');
  if (!Number.isInteger(cols) || cols < 1 || cols > 20) errors.push('cols 必须为 1..20 的整数');
  const labels = {};
  if (plan.labels && typeof plan.labels === 'object') {
    for (const [k, v] of Object.entries(plan.labels)) {
      const m = /^(\d+),(\d+)$/.exec(k);
      if (!m) { errors.push(`标签键 "${k}" 非法`); continue; }
      const [x, y] = [Number(m[1]), Number(m[2])];
      if (x < 0 || x >= cols || y < 0 || y >= rows) { errors.push(`标签 ${k} 超出网格`); continue; }
      labels[k] = {
        front: v && v.front != null ? String(v.front) : '',
        back: v && v.back != null ? String(v.back) : ''
      };
    }
  }
  const steps = [];
  if (plan.steps != null && !Array.isArray(plan.steps)) errors.push('steps 必须为数组');
  if (Array.isArray(plan.steps)) {
    plan.steps.forEach((st, i) => {
      const axis = st && (st.axis === 'v' || st.axis === 'h') ? st.axis : null;
      const line = Number(st && st.line);
      const dir = st && ['l', 'r', 'u', 'd'].includes(st.dir) ? st.dir : null;
      if (!axis || !Number.isInteger(line) || !dir) {
        errors.push(`步骤 ${i + 1} 非法（需 axis:v/h, line:整数, dir:l/r/u/d）`);
        return;
      }
      steps.push({ axis, line, dir });
    });
  }
  if (errors.length) {
    const e = new Error('方案格式错误：\n - ' + errors.join('\n - '));
    e.errors = errors;
    throw e;
  }
  return {
    name: plan.name ? String(plan.name) : '未命名方案',
    rows, cols, labels, steps
  };
}

const api = {
  initialState, cloneState, validateFold, applyFold,
  replay, visibleFace, pageSequence, normalizePlan, key,
  impositionEligibility, autoImpose, impositionOverwrite
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.FoldEngine = api;
