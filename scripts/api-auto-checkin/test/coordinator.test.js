const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');

function setupCoordinator(initialState = { running: true, runId: 'run-1' }) {
  const source = fs.readFileSync(path.join(srcDir, '60-coordinator.js'), 'utf8');
  const listeners = new Map();
  let nextListenerId = 1;
  let state = initialState;

  const factory = new Function(
    'getRunState', 'getResults', 'GM_addValueChangeListener',
    'GM_removeValueChangeListener', 'KEY_RESULTS', 'KEY_RUN',
    'setTimeout', 'clearTimeout', 'Date', 'Math', `
      ${source}
      return { waitForSiteResult, isRunStateFresh, isJobFresh, ownsRun, RUN_STATE_TTL_MS };
    `
  );

  const module = factory(
    () => state,
    () => ({}),
    (key, callback) => {
      const id = nextListenerId++;
      listeners.set(id, { key, callback });
      return id;
    },
    id => listeners.delete(id),
    'results',
    'run',
    setTimeout,
    clearTimeout,
    Date,
    Math
  );

  return {
    module,
    setState(next) { state = next; },
    fire(key, value, remote = true) {
      for (const listener of [...listeners.values()]) {
        if (listener.key === key) listener.callback(key, null, JSON.stringify(value), remote);
      }
    },
    get listenerCount() { return listeners.size; }
  };
}

test('共享终止请求会立即解除站点结果等待', async () => {
  const ctx = setupCoordinator();
  const pending = ctx.module.waitForSiteResult('a_com', 10000, 'run-1');
  assert.equal(ctx.listenerCount, 2);

  const abortedState = { running: true, runId: 'run-1', abortRequestedAt: Date.now() };
  ctx.setState(abortedState);
  ctx.fire('run', abortedState);

  assert.deepEqual(await pending, { status: 'failed', message: '已中断', aborted: true });
  assert.equal(ctx.listenerCount, 0);
});

test('运行态只在有效时间窗口内阻止重复启动', () => {
  const { module: M } = setupCoordinator();
  const now = Date.now();
  assert.equal(M.isRunStateFresh({ running: true, updatedAt: new Date(now).toISOString() }, now), true);
  assert.equal(M.isRunStateFresh({
    running: true,
    updatedAt: new Date(now - M.RUN_STATE_TTL_MS - 1).toISOString()
  }, now), false);
  assert.equal(M.isRunStateFresh({ running: true, updatedAt: new Date(now + 1).toISOString() }, now), false);
  assert.equal(M.isRunStateFresh({ running: true }, now), false);
});

test('只有 runId 与共享运行态一致的协调者持有所有权', () => {
  const ctx = setupCoordinator({ running: true, runId: 'run-1' });
  assert.equal(ctx.module.ownsRun('run-1'), true);
  assert.equal(ctx.module.ownsRun('run-2'), false);

  ctx.setState({ running: false, runId: 'run-1' });
  assert.equal(ctx.module.ownsRun('run-1'), false);
});
