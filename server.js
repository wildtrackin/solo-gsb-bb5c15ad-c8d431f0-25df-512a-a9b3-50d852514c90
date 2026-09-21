'use strict';
/**
 * server.js —— 折页阅读顺序校样 Web 服务
 *  - 静态托管 public/（原生 HTML/CSS/Canvas 前端）
 *  - /api/simulate：服务端重放方案（与浏览器共用同一份 foldEngine.js）
 *  - /api/plans* ：方案 JSON 持久化到 DATA_DIR（容器卷）
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./public/foldEngine.js');
const FP = require('./public/foldPath.js');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 模拟 ----------
app.post('/api/simulate', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const upto = req.body && Number.isInteger(req.body.upto)
      ? Math.max(0, Math.min(req.body.upto, plan.steps.length))
      : plan.steps.length;
    const { state, error } = E.replay(plan.rows, plan.cols, plan.labels, plan.steps, upto);
    res.json({
      ok: !error,
      upto,
      error: error || null,
      stacks: E.pageSequence(state).stacks,
      folded: E.pageSequence(state).folded,
      occupied: Object.keys(state.stacks).map((k) => {
        const [x, y] = k.split(',').map(Number);
        return {
          x, y, depth: state.stacks[k].length,
          panels: state.stacks[k].map((id) => {
            const p = state.panels[id];
            return {
              id, ox: p.ox, oy: p.oy, cx: p.cx, cy: p.cy,
              frame: p.frame,
              front: p.front, back: p.back
            };
          })
        };
      })
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 自动拼版 ----------
app.post('/api/impose', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const result = E.autoImpose(
      plan.rows, plan.cols, plan.labels, plan.steps,
      req.body && req.body.startPage,
      req.body && req.body.pageCount
    );
    if (!result.ok) {
      return res.json({
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          capacity: result.capacity,
          stepIndex: result.stepIndex,
          conflicts: result.conflicts,
          stackCount: result.stackCount
        }
      });
    }
    res.json({
      ok: true,
      startPage: result.startPage,
      pageCount: result.pageCount,
      capacity: result.capacity,
      blankTrailing: result.blankTrailing,
      labels: result.labels,
      slots: result.slots,
      overwrites: E.impositionOverwrite(plan.labels, result)
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 折手自动寻路 ----------
app.post('/api/fold-path', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const t = req.body && req.body.target;
    const target = t ? { cell: t.cell, face: t.face } : null;
    // 调用方可把上限调得更紧（如测试/交互预览），但永远不允许放宽 8 步 / 2 秒
    const opts = {};
    if (req.body && Number.isInteger(req.body.maxSteps)) opts.maxSteps = req.body.maxSteps;
    if (req.body && Number.isFinite(Number(req.body.timeLimitMs))) {
      opts.timeLimitMs = Number(req.body.timeLimitMs);
    }
    const r = FP.searchFoldPath(
      plan.rows, plan.cols, plan.labels, plan.steps, target, opts);
    if (!r.ok) {
      return res.json({
        ok: false,
        error: {
          status: r.status,
          code: r.code || r.status,
          message: r.message,
          stepIndex: r.stepIndex,
          conflicts: r.conflicts
        }
      });
    }
    res.json({
      ok: true,
      status: r.status,
      target: r.target,
      length: r.length,
      depth: r.depth,
      truncated: r.truncated,
      goalCount: r.goalCount,
      elapsedMs: r.elapsedMs,
      visited: r.visited,
      expanded: r.expanded,
      schemes: r.schemes,
      message: r.message || null
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 方案持久化 ----------
function planFile(id) { return path.join(DATA_DIR, `${id}.json`); }

app.get('/api/plans', (_req, res) => {
  const items = fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        const st = fs.statSync(path.join(DATA_DIR, f));
        return { id: f.replace(/\.json$/, ''), name: p.name || '未命名方案', rows: p.rows, cols: p.cols, steps: (p.steps || []).length, savedAt: st.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.savedAt - a.savedAt);
  res.json(items);
});

app.post('/api/plans', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const body = {
      name: plan.name, rows: plan.rows, cols: plan.cols,
      labels: plan.labels, steps: plan.steps,
      savedAt: new Date().toISOString()
    };
    let id = (req.body && typeof req.body.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(req.body.id))
      ? req.body.id : crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(planFile(id), JSON.stringify(body, null, 2));
    res.json({ ok: true, id, plan: body });
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

app.get('/api/plans/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ ok: false, error: { message: '非法 id' } });
  const f = planFile(id);
  if (!fs.existsSync(f)) return res.status(404).json({ ok: false, error: { message: '方案不存在' } });
  res.type('application/json').send(fs.readFileSync(f, 'utf8'));
});

app.delete('/api/plans/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ ok: false, error: { message: '非法 id' } });
  const f = planFile(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  res.json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`折页阅读顺序校样应用已启动： http://localhost:${PORT}`);
  });
}

module.exports = app;
