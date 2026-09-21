'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');
const P = require('../public/foldPath.js');

test('寻路：2×2 从初始格出发，每个目标封面都有 2 步最短方案且结果可回放', () => {
  for (const cell of ['0,0', '1,0', '0,1', '1,1']) {
    const r = P.searchFoldPath(2, 2, {}, [], { cell, face: 'back' });
    assert.equal(r.status, 'solved', `目标 ${cell}/back 应可解`);
    assert.equal(r.length, 2);
    // 两条等长方案对应两个不同终态（一条倒置落对角格、一条正立落邻格）
    assert.equal(r.schemes.length, 2);
    const finalKeys = new Set();
    for (const scheme of r.schemes) {
      assert.equal(scheme.steps.length, 2);
      assert.equal(scheme.cover.cell, cell);
      assert.equal(scheme.cover.face, 'back');
      finalKeys.add(scheme.finalCell + ':' + scheme.cover.upright);
      // 追加回放后确为单叠、封面正确
      const rep = E.replay(2, 2, {}, scheme.steps);
      assert.equal(rep.error, null);
      const ks = Object.keys(rep.state.stacks);
      assert.deepEqual(ks, [scheme.finalCell]);
      const top = rep.state.panels[rep.state.stacks[ks[0]][0]];
      assert.equal(`${top.ox},${top.oy}`, cell);
      assert.ok(top.frame.n.z < 0);
    }
    assert.equal(finalKeys.size, 2);
  }
});

test('寻路：初始平张正面均朝上——目标正面在 2×2 下无解（与反面目标区分）', () => {
  const back = P.searchFoldPath(2, 2, {}, [], { cell: '0,0', face: 'back' });
  assert.equal(back.status, 'solved');
  const front = P.searchFoldPath(2, 2, {}, [], { cell: '0,0', face: 'front' });
  assert.equal(front.status, 'no_solution');
  assert.deepEqual(front.schemes, []);
  assert.ok(front.visited > 1);
});

test('寻路：2×4 每个目标给出至多 3 条等长最短方案', () => {
  const r = P.searchFoldPath(2, 4, {}, [], { cell: '3,0', face: 'back' });
  assert.equal(r.status, 'solved');
  assert.equal(r.length, 3);
  assert.ok(r.schemes.length >= 2 && r.schemes.length <= 3);
  const lens = new Set(r.schemes.map((s) => s.steps.length));
  assert.deepEqual([...lens], [3]);
  // 各方案步骤序列互不相同，且都能合法回放成同一目标封面
  const sigs = new Set();
  for (const s of r.schemes) {
    sigs.add(s.steps.map((x) => x.axis + x.line + x.dir).join(','));
    const rep = E.replay(2, 4, {}, s.steps);
    assert.equal(rep.error, null);
    assert.equal(Object.keys(rep.state.stacks).length, 1);
    const top = rep.state.panels[Object.values(rep.state.stacks)[0][0]];
    assert.equal(`${top.ox},${top.oy}`, '3,0');
    assert.ok(top.frame.n.z < 0);
  }
  assert.equal(sigs.size, r.schemes.length);
});

test('寻路：4×4 在默认上限内 4 步求解，且方案被截断为 3 条', () => {
  const r = P.searchFoldPath(4, 4, {}, [], { cell: '3,2', face: 'back' });
  assert.equal(r.status, 'solved');
  assert.equal(r.length, 4);
  assert.equal(r.schemes.length, 3);
  assert.equal(r.truncated, true);
  assert.ok(r.elapsedMs <= 2000);
});

test('寻路：从“已有合法步骤的末态”继续搜索（2×2 先折一竖）', () => {
  const steps = [{ axis: 'v', line: 1, dir: 'r' }];
  // 末态两个叠层 @(1,0)/(1,1)，顶片面分别为 0,0 / 0,1 的反面，还差一折
  const r = P.searchFoldPath(2, 2, {}, steps, { cell: '1,1', face: 'back' });
  assert.equal(r.status, 'solved');
  assert.equal(r.length, 1);
  assert.deepEqual(r.schemes[0].steps, [{ axis: 'h', line: 1, dir: 'u' }]);
  // 目标若是当前顶片之一（已经朝上）但尚未单叠，则无法再保持为封面 → 无解；
  // 其余两格各由一条水平折收成单叠
  const r2 = P.searchFoldPath(2, 2, {}, steps, { cell: '0,0', face: 'back' });
  assert.equal(r2.status, 'no_solution');
  const r3 = P.searchFoldPath(2, 2, {}, steps, { cell: '1,0', face: 'back' });
  assert.equal(r3.status, 'solved');
  assert.equal(r3.length, 1);
  assert.deepEqual(r3.schemes[0].steps, [{ axis: 'h', line: 1, dir: 'd' }]);
});

test('寻路：末态已是目标单叠 → already（0 步）', () => {
  const steps = [{ axis: 'v', line: 1, dir: 'r' }];
  const r = P.searchFoldPath(1, 2, {}, steps, { cell: '0,0', face: 'back' });
  assert.equal(r.status, 'already');
  assert.equal(r.length, 0);
  assert.deepEqual(r.schemes[0].steps, []);
  assert.equal(r.schemes[0].finalCell, '1,0');
});

test('寻路：现有步骤非法 → replay_conflict，附步数号与冲突格', () => {
  const r = P.searchFoldPath(1, 3, {}, [
    { axis: 'v', line: 1, dir: 'r' },
    { axis: 'v', line: 2, dir: 'l' }   // 厚度冲突
  ], { cell: '0,0', face: 'back' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'replay_conflict');
  assert.equal(r.code, 'thickness');
  assert.equal(r.stepIndex, 1);
  assert.deepEqual(r.conflicts, ['2,0', '1,0']);
});

test('寻路：网格超过 4×4 / 非法网格 → bad_grid', () => {
  assert.equal(P.searchFoldPath(5, 4, {}, [], { cell: '0,0', face: 'back' }).status, 'bad_grid');
  assert.equal(P.searchFoldPath(4, 5, {}, [], { cell: '0,0', face: 'back' }).status, 'bad_grid');
  assert.equal(P.searchFoldPath(0, 2, {}, [], { cell: '0,0', face: 'back' }).status, 'bad_grid');
});

test('寻路：目标纸格越界 / 朝向非法 → bad_target', () => {
  assert.equal(P.searchFoldPath(2, 2, {}, [], { cell: '2,0', face: 'back' }).status, 'bad_target');
  assert.equal(P.searchFoldPath(2, 2, {}, [], { cell: 'x', face: 'back' }).status, 'bad_target');
  assert.equal(P.searchFoldPath(2, 2, {}, [], { cell: '0,0', face: 'sideways' }).status, 'bad_target');
});

test('寻路：maxSteps 上限内无解且未超时 → no_solution；调小步数可制造 no_solution', () => {
  // 4×4 收成单叠至少 4 折：只给 3 步且状态空间会被枚举完 → no_solution
  const r = P.searchFoldPath(4, 4, {}, [], { cell: '3,2', face: 'back' },
    { maxSteps: 3, timeLimitMs: 2000 });
  assert.equal(r.status, 'no_solution');
  assert.equal(r.truncated, false);
});

test('寻路：时间上限为 0 且非已满足目标 → limit（搜索超限，与无解区分）', () => {
  const r = P.searchFoldPath(4, 4, {}, [], { cell: '3,2', face: 'back' },
    { maxSteps: 8, timeLimitMs: 0 });
  assert.equal(r.status, 'limit');
  assert.deepEqual(r.schemes, []);
});

test('寻路：调用方放宽上限也会被夹紧到 8 步 / 2000ms', () => {
  const r = P.searchFoldPath(2, 2, {}, [], { cell: '0,0', face: 'back' },
    { maxSteps: 99, timeLimitMs: 99999 });
  assert.equal(r.status, 'solved');
  assert.ok(r.elapsedMs <= 2000);
});

test('状态键：叠层顺序/朝向/相对位置不同的状态不会被误合并', () => {
  // 同一 2×2 网格，v1r 与 v1l 后均为两个 2 层叠，但位置与顶片相反；
  // 再叠加水平折，验证含完整标架与格位的键彼此不同。
  const s0 = E.initialState(2, 2);
  const a = E.applyFold(s0, { axis: 'v', line: 1, dir: 'r' });
  const b = E.applyFold(s0, { axis: 'v', line: 1, dir: 'l' });
  const ad = E.applyFold(a, { axis: 'h', line: 1, dir: 'd' });
  const au = E.applyFold(a, { axis: 'h', line: 1, dir: 'u' });
  const keys = new Set([P.stateKey(a), P.stateKey(b), P.stateKey(ad), P.stateKey(au)]);
  assert.equal(keys.size, 4);
  // 相同状态键相等（克隆不改语义）
  assert.equal(P.stateKey(a), P.stateKey(E.cloneState(a)));
});

test('状态键：封面相同但内页朝向不同的终态被区分（防止误合并的核心场景）', () => {
  // 2×4 的两条 3 步方案都把 (3,0) 的反面送到封面，但后续叠层顺序/朝向不同
  const s0 = E.initialState(2, 4);
  const planA = [
    { axis: 'v', line: 2, dir: 'r' }, { axis: 'v', line: 3, dir: 'r' },
    { axis: 'h', line: 1, dir: 'd' }];
  const planB = [
    { axis: 'v', line: 2, dir: 'r' }, { axis: 'h', line: 1, dir: 'u' },
    { axis: 'v', line: 3, dir: 'l' }];
  const sA = planA.reduce((s, st) => E.applyFold(s, st), s0);
  const sB = planB.reduce((s, st) => E.applyFold(s, st), s0);
  assert.equal(Object.keys(sA.stacks).length, 1);
  assert.equal(Object.keys(sB.stacks).length, 1);
  const topA = sA.panels[sA.stacks[Object.keys(sA.stacks)[0]][0]];
  const topB = sB.panels[sB.stacks[Object.keys(sB.stacks)[0]][0]];
  assert.equal(`${topA.ox},${topA.oy}`, '3,0');
  assert.equal(`${topB.ox},${topB.oy}`, '3,0');
  // 封面相同，但完整状态键必须不同（upright 一个倒置一个正立，内页顺序也不同）
  assert.notEqual(P.stateKey(sA), P.stateKey(sB));
});

test('isGoalState：单叠 + 指定原片面朝上，二者缺一不可', () => {
  const s1 = E.applyFold(E.initialState(2, 2), { axis: 'v', line: 1, dir: 'r' });
  assert.equal(P.isGoalState(s1, '0,0', 'back'), false);   // 尚未单叠
  const s2 = E.applyFold(s1, { axis: 'h', line: 1, dir: 'd' });
  assert.equal(P.isGoalState(s2, '1,0', 'back'), true);
  assert.equal(P.isGoalState(s2, '1,0', 'front'), false);  // 面别不符
  assert.equal(P.isGoalState(s2, '0,0', 'back'), false);   // 顶片不是目标格
});
