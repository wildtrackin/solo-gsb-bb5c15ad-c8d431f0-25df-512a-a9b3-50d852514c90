'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 使用独立临时数据目录，避免污染开发环境
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-data-'));
process.env.DATA_DIR = tmpData;
const app = require('../server.js');

const STEPS = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpData, { recursive: true, force: true });
});

async function post(p, body) {
  const resp = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: resp.status, json: await resp.json() };
}

test('POST /api/impose：合法折帖返回连续页码、slots 与反向 labels', async () => {
  const { status, json } = await post('/api/impose', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, startPage: 1, pageCount: 8
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.capacity, 8);
  assert.equal(json.slots.length, 8);
  assert.deepEqual(json.slots.map((s) => s.page),
    ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.ok(json.slots.every((s) => /^\d+,\d+$/.test(s.origin) && (s.face === 'front' || s.face === 'back')));
});

test('POST /api/impose：短页数返回末尾空白槽位', async () => {
  const { json } = await post('/api/impose', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, startPage: 5, pageCount: 4
  });
  assert.equal(json.ok, true);
  assert.equal(json.blankTrailing, 4);
  const blanks = json.slots.filter((s) => s.blank);
  assert.equal(blanks.length, 4);
  assert.deepEqual(json.slots.filter((s) => !s.blank).map((s) => s.page), ['5', '6', '7', '8']);
});

test('POST /api/impose：未收成单叠 / 超容量均返回具体原因', async () => {
  let r = await post('/api/impose', {
    rows: 2, cols: 3, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }], startPage: 1, pageCount: 1
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'not_single_stack');

  r = await post('/api/impose', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, startPage: 1, pageCount: 99
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'too_many_pages');
  assert.ok(r.json.error.message.includes('8'));
});

test('POST /api/impose：非法折叠时返回步骤号与冲突', async () => {
  const r = await post('/api/impose', {
    rows: 1, cols: 3, labels: {},
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'v', line: 2, dir: 'l' }
    ],
    startPage: 1, pageCount: 1
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'thickness');
  assert.equal(r.json.error.stepIndex, 1);
  assert.deepEqual(r.json.error.conflicts, ['2,0', '1,0']);
});

test('POST /api/impose：overwrites 汇总现有非空标注', async () => {
  const r = await post('/api/impose', {
    rows: 2, cols: 2,
    labels: { '0,0': { front: '4', back: '5' } },
    steps: STEPS, startPage: 1, pageCount: 8
  });
  assert.equal(r.json.ok, true);
  assert.ok(Array.isArray(r.json.overwrites));
  const cells = new Set(r.json.overwrites.map((o) => o.cell));
  assert.ok(cells.has('0,0'));
  assert.ok(r.json.overwrites.every((o) => o.from && o.from !== o.to));
});

test('自动拼版标签写入后 /api/simulate 保留标签并回放为连续阅读顺序', async () => {
  const imp = await post('/api/impose', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, startPage: 1, pageCount: 8
  });
  const sim = await post('/api/simulate', {
    rows: 2, cols: 2, labels: imp.json.labels, steps: STEPS
  });
  assert.equal(sim.json.ok, true);
  assert.equal(sim.json.folded, true);
  assert.deepEqual(sim.json.stacks[0].sequence,
    ['1', '2', '3', '4', '5', '6', '7', '8']);
});

test('自动拼版标签经保存/载入往返后完整保留', async () => {
  const imp = await post('/api/impose', {
    rows: 1, cols: 2, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    startPage: 1, pageCount: 4
  });
  const saved = await post('/api/plans', {
    name: '拼版存档', rows: 1, cols: 2,
    labels: imp.json.labels,
    steps: [{ axis: 'v', line: 1, dir: 'r' }]
  });
  assert.equal(saved.json.ok, true);
  const loaded = await (await fetch(`${base}/api/plans/${saved.json.id}`)).json();
  assert.deepEqual(loaded.labels, imp.json.labels);
  assert.deepEqual(loaded.labels['0,0'], { front: '4', back: '1' });
});

// ---------- 折手自动寻路 ----------
test('POST /api/find-path：2×2 反面封面返回等长最短方案（≤3 条）', async () => {
  const r = await post('/api/find-path', {
    rows: 2, cols: 2, labels: {}, steps: [],
    target: { cell: '1,0', face: 'back' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.solved, true);
  assert.equal(r.json.depth, 2);
  assert.ok(r.json.solutions.length >= 2 && r.json.solutions.length <= 3);
  for (const sol of r.json.solutions) {
    assert.equal(sol.steps.length, 2);
    assert.equal(sol.topPanel, '1,0');
    assert.equal(sol.coverFace, 'back');
  }
});

test('POST /api/find-path：无解返回 solved:false / no_solution', async () => {
  const r = await post('/api/find-path', {
    rows: 2, cols: 2, labels: {}, steps: [],
    target: { cell: '0,0', face: 'front' }
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.solved, false);
  assert.equal(r.json.reason, 'no_solution');
  assert.ok(r.json.message.includes('无解'));
});

test('POST /api/find-path：非法方案返回 400；超过 4×4 返回 grid_too_large', async () => {
  const bad = await post('/api/find-path', {
    rows: 2, cols: 2, steps: [{ axis: 'z' }],
    target: { cell: '0,0', face: 'front' }
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'bad_plan');

  const big = await post('/api/find-path', {
    rows: 3, cols: 5, labels: {}, steps: [],
    target: { cell: '0,0', face: 'back' }
  });
  assert.equal(big.status, 200);
  assert.equal(big.json.ok, false);
  assert.equal(big.json.error.code, 'grid_too_large');
});

test('POST /api/find-path：前缀非法折叠返回 bad_prefix 与步号', async () => {
  const r = await post('/api/find-path', {
    rows: 1, cols: 3, labels: {},
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'v', line: 2, dir: 'l' }
    ],
    target: { cell: '0,0', face: 'back' }
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'bad_prefix');
  assert.equal(r.json.error.stepIndex, 1);
});

test('POST /api/find-path：服务端把时间预算钳制到 2 秒以内，超限返回 limit_exceeded', async () => {
  const r = await post('/api/find-path', {
    rows: 4, cols: 4, labels: {}, steps: [],
    target: { cell: '0,0', face: 'front' },
    options: { timeoutMs: 1, maxDepth: 8 }
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.solved, false);
  assert.equal(r.json.reason, 'limit_exceeded');

  // 超出上限的 5000ms 会被钳制为 2000（4×4 空间在 2 秒内可穷尽 → no_solution）
  const r2 = await post('/api/find-path', {
    rows: 4, cols: 4, labels: {}, steps: [],
    target: { cell: '0,0', face: 'front' },
    options: { timeoutMs: 5000 }
  });
  assert.equal(r2.json.reason, 'no_solution');
});

test('POST /api/find-path：返回方案追加后经 /api/simulate 回放为目标单叠', async () => {
  const found = await post('/api/find-path', {
    rows: 1, cols: 2, labels: {}, steps: [],
    target: { cell: '0,0', face: 'back' }
  });
  const steps = found.json.solutions[0].steps;
  const sim = await post('/api/simulate', { rows: 1, cols: 2, labels: {}, steps });
  assert.equal(sim.json.ok, true);
  assert.equal(sim.json.folded, true);
  assert.equal(sim.json.occupied[0].panels[0].ox, 0);
  assert.ok(sim.json.occupied[0].panels[0].frame.n.z < 0);
});
