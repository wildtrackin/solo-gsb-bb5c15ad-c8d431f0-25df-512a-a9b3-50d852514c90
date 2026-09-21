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
