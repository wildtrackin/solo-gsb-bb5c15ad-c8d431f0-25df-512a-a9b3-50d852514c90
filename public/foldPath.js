'use strict';
/**
 * foldPath.js —— 折手自动寻路（无 DOM 依赖，可独立单元测试）
 *
 * 在一份“现有步骤已合法回放”的末态之上，枚举现有引擎允许的折线与方向
 * （即 foldEngine.validateFold 判定合法的 180° 折叠），用 BFS 搜索把纸
 * 收成“单叠、且指定原始纸格的正面/反面朝上作为封面”的最短后续步骤。
 *
 * 关键约定
 * --------
 * 1. 只支持不超过 4×4 的网格（rows ≤ 4 且 cols ≤ 4）。
 * 2. 搜索上限：默认最多 8 个后续步骤、2 秒墙钟；命中任一上限而未搜到
 *    结果时返回 status:'limit'（搜索超限），与 status:'no_solution'
 *    （枚举完可达状态仍无解）分别提示。
 * 3. 状态键（stateKey）必须完整区分搜索结果：
 *      - 各格叠层顺序（stack 内面板 id 自上而下的排列）；
 *      - 每个面片的朝向（3×3 标架 x/y/n）；
 *      - 面片相对位置（叠层所在格位由 stacks 的键给出）。
 *    只看“封面是谁”会把目标结果不同（内页顺序/朝向不同）的状态误合并。
 * 4. BFS 按层（步数）展开：同一深度上先按固定的折线/方向枚举顺序收集
 *    目标方案，因此返回的 schemes 天然等长且为最短，最多保留 3 条。
 */
(function () {
const MAX_GRID = 4;
const MAX_STEPS_LIMIT = 8;
const TIME_LIMIT_MS = 2000;
const MAX_SCHEMES = 3;

// 与 foldEngine.js 同目录：Node 下直接 require；浏览器中取其挂载的全局
const E = (typeof require === 'function')
  ? require('./foldEngine.js')
  : (typeof window !== 'undefined' ? window.FoldEngine : null);


/**
 * 枚举当前引擎允许尝试的折线与方向（网格边界内的所有 v/h 折线 × 两个落向）。
 * 合法性仍由引擎的 validateFold 在搜索时逐个判定。
 */
function candidateFolds(rows, cols) {
  const out = [];
  for (let k = 1; k < cols; k++) {
    out.push({ axis: 'v', line: k, dir: 'r' });
    out.push({ axis: 'v', line: k, dir: 'l' });
  }
  for (let k = 1; k < rows; k++) {
    out.push({ axis: 'h', line: k, dir: 'd' });
    out.push({ axis: 'h', line: k, dir: 'u' });
  }
  return out;
}

/**
 * 完整折叠状态键：
 *   格位(相对位置) → 自上而下的面板 id 序列；
 *   每个面板附朝向标架（frame.x / frame.y / frame.n 的 9 个分量）。
 * 标架分量始终为 -1/0/1，直接取分量即唯一编码，足以区分正反面与正/倒置。
 */
function stateKey(state) {
  const parts = [];
  const cells = Object.keys(state.stacks).sort();
  for (const cell of cells) {
    const seg = [cell];
    for (const id of state.stacks[cell]) {
      const p = state.panels[id];
      seg.push(id +
        '(' + p.frame.x.x + ',' + p.frame.x.y + ',' + p.frame.x.z +
        '|' + p.frame.y.x + ',' + p.frame.y.y + ',' + p.frame.y.z +
        '|' + p.frame.n.x + ',' + p.frame.n.y + ',' + p.frame.n.z + ')');
    }
    parts.push(seg.join('='));
  }
  return parts.join(';');
}

function isGoalState(state, targetCell, targetFace) {
  const cells = Object.keys(state.stacks);
  if (cells.length !== 1) return false;
  const cell = cells[0];
  const ids = state.stacks[cell];
  const top = state.panels[ids[0]];
  return E_key(top) === targetCell &&
    (top.frame.n.z > 0 ? 'front' : 'back') === targetFace;
}

// 面板 id 即“原始列,原始行”，与 foldEngine.key 保持一致
function E_key(p) { return `${p.ox},${p.oy}`; }

/**
 * 自动寻路主入口。
 *
 * @param rows,cols,labels,steps  当前方案（steps 为已确认的合法回放步骤）
 * @param target { cell:'x,y', face:'front'|'back' }  最终朝上封面
 * @param opts   { maxSteps=8, timeLimitMs=2000 }（均做上限夹紧）
 * @returns
 *   失败（前置条件）：{ ok:false, status:'bad_grid'|'bad_target'|
 *                       'replay_conflict'|'bad_limit', message, ... }
 *   搜索结果：{
 *     ok:true, status:'solved'|'no_solution'|'limit'|'already',
 *     target, length, schemes:[{ steps:[{axis,line,dir}], cover:{cell,face,upright},
 *                                finalCell }],   // 至多 3 条、等长、最短
 *     depth, visited, expanded, truncated, elapsedMs
 *   }
 */
function searchFoldPath(rows, cols, labels, steps, target, opts) {
  rows = Number(rows); cols = Number(cols);
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
    return { ok: false, status: 'bad_grid', message: '尚未创建合法的行列纸格（行数、列数都须为正整数）。' };
  }
  if (rows > MAX_GRID || cols > MAX_GRID) {
    return {
      ok: false, status: 'bad_grid',
      code: 'grid_too_large',
      message: `折手自动寻路仅支持不超过 ${MAX_GRID}×${MAX_GRID} 的网格，当前为 ${rows}×${cols}。`
    };
  }

  let maxSteps = opts && opts.maxSteps != null ? Number(opts.maxSteps) : MAX_STEPS_LIMIT;
  let timeLimitMs = opts && opts.timeLimitMs != null ? Number(opts.timeLimitMs) : TIME_LIMIT_MS;
  if (!Number.isInteger(maxSteps) || maxSteps < 0 || !Number.isFinite(timeLimitMs) || timeLimitMs < 0) {
    return { ok: false, status: 'bad_limit', message: '搜索上限参数非法（步数须为非负整数、毫秒须为非负数）。' };
  }
  const startAt = Date.now();
  maxSteps = Math.min(maxSteps, MAX_STEPS_LIMIT);
  const deadline = startAt + Math.min(timeLimitMs, TIME_LIMIT_MS);

  const cell = target && target.cell;
  const face = target && target.face;
  if (typeof cell !== 'string' || !/^\d+,\d+$/.test(cell)) {
    return { ok: false, status: 'bad_target', message: '请指定一个原始纸格作为最终封面（格式 “列,行”）。' };
  }
  const [tx, ty] = cell.split(',').map(Number);
  if (tx < 0 || tx >= cols || ty < 0 || ty >= rows) {
    return { ok: false, status: 'bad_target', message: `目标纸格 (${cell}) 不在当前 ${rows}×${cols} 网格内。` };
  }
  if (face !== 'front' && face !== 'back') {
    return { ok: false, status: 'bad_target', message: "封面朝向须为 'front'（正面）或 'back'（反面）。" };
  }

  const stepsArr = Array.isArray(steps) ? steps : [];
  const replay = E.replay(rows, cols, labels || {}, stepsArr);
  if (replay.error) {
    return {
      ok: false, status: 'replay_conflict',
      code: replay.error.code,
      stepIndex: replay.error.stepIndex,
      conflicts: replay.error.conflicts,
      message: `当前方案存在非法折叠（第 ${replay.error.stepIndex + 1} 步：${replay.error.message}），请先修正后再寻路。`
    };
  }

  const base = replay.state;
  const baseMeta = () => coverMeta(base);
  if (isGoalState(base, cell, face)) {
    return {
      ok: true, status: 'already',
      target: { cell, face }, length: 0,
      schemes: [{ steps: [], cover: baseMeta(), finalCell: onlyCell(base) }],
      depth: 0, visited: 1, expanded: 0, truncated: false,
      elapsedMs: 0,
      message: '当前末态已经是该纸格该面朝上的单叠，无需追加步骤。'
    };
  }

  const cands = candidateFolds(rows, cols);
  // BFS 节点只保留寻路所需：状态 + 父节点 + 入边；完整状态键负责去重。
  const visited = new Map();   // key -> node（首次到达即最短）
  let visitedCount = 0;
  let expanded = 0;
  let timedOut = false;

  const root = { state: base, parent: null, step: null, depth: 0 };
  visited.set(stateKey(base), root);
  visitedCount = 1;

  let frontier = [root];
  const schemes = [];
  let foundDepth = -1;
  let goalCount = 0;   // 该深度上命中的全部目标状态数（用于判断展示是否被截断）

  for (let depth = 1; depth <= maxSteps; depth++) {
    if (Date.now() > deadline) { timedOut = true; break; }
    const next = [];
    let goalHit = false;

    for (const node of frontier) {
      if (Date.now() > deadline) { timedOut = true; break; }
      expanded++;
      for (const step of cands) {
        if (E.validateFold(node.state, step)) continue;
        const ns = E.applyFold(node.state, step);
        const k = stateKey(ns);
        if (visited.has(k)) continue;
        const child = { state: ns, parent: node, step, depth };
        visited.set(k, child);
        visitedCount++;
        if (isGoalState(ns, cell, face)) {
          goalHit = true;
          goalCount++;
          if (schemes.length < MAX_SCHEMES) schemes.push(buildScheme(child));
        } else {
          next.push(child);
        }
      }
      if (timedOut) break;
    }

    if (goalHit) { foundDepth = depth; break; }
    if (timedOut) break;
    frontier = next;
    if (!frontier.length) break;
  }

  const elapsedMs = Math.max(0, Date.now() - startAt);

  if (schemes.length) {
    return {
      ok: true, status: 'solved',
      target: { cell, face },
      length: foundDepth,
      schemes,
      truncated: goalCount > schemes.length,
      goalCount,
      depth: foundDepth,
      visited: visitedCount, expanded,
      elapsedMs
    };
  }

  if (timedOut) {
    return {
      ok: true, status: 'limit',
      target: { cell, face },
      schemes: [],
      length: null,
      depth: maxSteps,
      visited: visitedCount, expanded,
      truncated: true,
      elapsedMs,
      message: `搜索超限：已在 ${maxSteps} 步 / 2 秒上限内枚举 ${visitedCount} 个状态仍未确认方案，可尝试更换目标封面或先手动折几步。`
    };
  }

  return {
    ok: true, status: 'no_solution',
    target: { cell, face },
    schemes: [],
    length: null,
    depth: maxSteps,
    visited: visitedCount, expanded,
    truncated: false,
    elapsedMs,
    message: `无解：从当前末态出发，在引擎允许的 ${maxSteps} 步折叠内无法把该纸格的${face === 'front' ? '正面' : '反面'}收成朝上封面的单叠。`
  };
}

function onlyCell(state) {
  const ks = Object.keys(state.stacks);
  return ks.length === 1 ? ks[0] : null;
}

/** 取单叠顶片面的封面信息（格、面、是否正立）。 */
function coverMeta(state) {
  const fc = onlyCell(state);
  if (!fc) return null;
  const top = state.panels[state.stacks[fc][0]];
  const vf = E_visibleFace(top);
  return { cell: `${top.ox},${top.oy}`, face: vf.side, upright: vf.upright };
}

function E_visibleFace(p) {
  return { side: p.frame.n.z > 0 ? 'front' : 'back', upright: p.frame.y.y > 0 };
}

/** 沿父链还原步骤序列（根→叶），并附上封面/落点信息。 */
function buildScheme(node) {
  const stepsRev = [];
  let cur = node;
  while (cur && cur.step) {
    stepsRev.push(cur.step);
    cur = cur.parent;
  }
  const steps = stepsRev.reverse().map((s) => ({ axis: s.axis, line: s.line, dir: s.dir }));
  return {
    steps,
    cover: coverMeta(node.state),
    finalCell: onlyCell(node.state)
  };
}

const api = {
  searchFoldPath,
  candidateFolds,
  stateKey,
  isGoalState,
  MAX_GRID,
  MAX_STEPS_LIMIT,
  TIME_LIMIT_MS,
  MAX_SCHEMES
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.FoldPath = api;
})();
