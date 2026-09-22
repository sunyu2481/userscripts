const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');

function setupCoordinator(initialState = { running: true, runId: 'run-1' }, initialResults = {}) {
  const source = fs.readFileSync(path.join(srcDir, '60-coordinator.js'), 'utf8');
  const listeners = new Map();
  let nextListenerId = 1;
  let state = initialState;
  let results = initialResults;
  let job = null;
  let renderCount = 0;

  const factory = new Function(
    'getRunState', 'saveRunState', 'getResults', 'saveResults', 'clearJob',
    'renderPanel', 'isRecord', 'GM_addValueChangeListener',
    'GM_removeValueChangeListener', 'KEY_RESULTS', 'KEY_RUN',
    'setTimeout', 'clearTimeout', 'Date', 'Math', `
      ${source}
      return {
        waitForSiteResult, isRunStateFresh, isJobFresh, ownsRun,
        pickClaimTimeout, pickClaimDeadline, forceStopRunState, heartbeatRunState,
        isHeartbeatOnlyChange, saveActiveRunState,
        RUN_STATE_TTL_MS, RUN_HEARTBEAT_MS,
        CLAIM_HEARTBEAT_TIMEOUT_MS, JOB_CLAIM_WINDOW_MS
      };
    `
  );

  const module = factory(
    () => state,
    next => { state = next; },
    () => results,
    next => { results = next; },
    () => { job = null; },
    () => { renderCount++; },
    value => value !== null && typeof value === 'object' && !Array.isArray(value),
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
    setResults(next) { results = next; },
    get state() { return state; },
    get results() { return results; },
    get job() { return job; },
    get renderCount() { return renderCount; },
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

test('认领超时严格小于主超时，否则提前放弃永远轮不到', () => {
  const { module: M } = setupCoordinator();

  // 主超时很大：取认领窗口上限
  assert.equal(M.pickClaimTimeout(90000), M.CLAIM_HEARTBEAT_TIMEOUT_MS);

  // 主超时小于上限时必须严格更小。两个 setTimeout 延迟相同会按注册顺序执行，
  // 主超时先注册就先 settle，取等号等于这条分支从不触发。
  for (const main of [5000, 30000, M.CLAIM_HEARTBEAT_TIMEOUT_MS, 60000]) {
    const claim = M.pickClaimTimeout(main);
    assert.ok(claim < main, `主超时 ${main}ms 时认领超时 ${claim}ms 必须更小`);
    assert.ok(claim > 0, `主超时 ${main}ms 时认领超时必须为正`);
  }

  // 但也不能过早放弃：标签页在认领窗口内加载完却已被判失败，就是白丢一次签到。
  // 45s 以上的设置都该保住完整的认领窗口上限。
  for (const main of [46000, 60000, 90000, 600000]) {
    assert.equal(M.pickClaimTimeout(main), M.CLAIM_HEARTBEAT_TIMEOUT_MS,
      `主超时 ${main}ms 时不该缩短认领等待`);
  }

  // 脏输入退回上限，而不是 0 或 NaN
  for (const bad of [0, -1, NaN, undefined, null, 'abc']) {
    assert.equal(M.pickClaimTimeout(bad), M.CLAIM_HEARTBEAT_TIMEOUT_MS);
  }
});

test('任务认领窗口不超过用户配置的站点超时', () => {
  const { module: M } = setupCoordinator();
  const now = 1000000;

  // 超时设得比固定窗口小：窗口跟着缩，否则协调者死后残留任务会在
  // 之后几十秒里被任意一次同域导航捡走，悄悄多签一次
  assert.equal(M.pickClaimDeadline(5000, now), now + 5000);
  assert.equal(M.pickClaimDeadline(30000, now), now + 30000);

  // 超时大于固定窗口：仍以固定窗口为上限
  assert.equal(M.pickClaimDeadline(90000, now), now + M.JOB_CLAIM_WINDOW_MS);
  assert.equal(M.pickClaimDeadline(600000, now), now + M.JOB_CLAIM_WINDOW_MS);

  // 脏输入退回固定窗口
  for (const bad of [0, -1, NaN, undefined, null]) {
    assert.equal(M.pickClaimDeadline(bad, now), now + M.JOB_CLAIM_WINDOW_MS);
  }
});

test('认领判定优先用任务自带的截止时间', () => {
  const { module: M } = setupCoordinator();
  const now = 1000000;
  const site = { domain: 'a.com' };

  // claimBy 在未来：认
  assert.equal(M.isJobFresh({ site, assignedAt: now - 3000, claimBy: now + 1000 }, 'a.com', now), true);
  // claimBy 已过：不认，即便还在固定 40s 窗口内
  assert.equal(M.isJobFresh({ site, assignedAt: now - 6000, claimBy: now - 1000 }, 'a.com', now), false);
  // 短超时的实际效果：5s 的任务过了 6s 就不该再被认领
  assert.equal(
    M.isJobFresh({ site, assignedAt: now - 6000, claimBy: M.pickClaimDeadline(5000, now - 6000) }, 'a.com', now),
    false
  );

  // 没有 claimBy 的旧任务退回固定窗口
  assert.equal(M.isJobFresh({ site, assignedAt: now - 1000 }, 'a.com', now), true);
  assert.equal(M.isJobFresh({ site, assignedAt: now - M.JOB_CLAIM_WINDOW_MS - 1 }, 'a.com', now), false);

  // 认领过的、域名不符的、时钟倒退的一律不认
  assert.equal(M.isJobFresh({ site, assignedAt: now, claimBy: now + 1000, claimedAt: now }, 'a.com', now), false);
  assert.equal(M.isJobFresh({ site, assignedAt: now, claimBy: now + 1000 }, 'b.com', now), false);
  assert.equal(M.isJobFresh({ site, assignedAt: now + 5000, claimBy: now + 9000 }, 'a.com', now), false);
});

test('强制结束只清面板当时看到的那一轮', () => {
  const ctx = setupCoordinator(
    { running: true, runId: 'run-1', updatedAt: new Date().toISOString() },
    { a_com: { status: 'checking' } }
  );

  // runId 对不上：点按钮到落地之间已经起了新一轮，必须放手
  assert.equal(ctx.module.forceStopRunState('run-old'), false);
  assert.equal(ctx.state.running, true, '不该动别人的运行态');
  assert.equal(ctx.results.a_com.status, 'checking', '不该动别人的结果');

  // runId 对得上：清运行态，checking 落为失败
  assert.equal(ctx.module.forceStopRunState('run-1'), true);
  assert.equal(ctx.state.running, false);
  assert.equal(ctx.state.aborted, true);
  assert.equal(ctx.results.a_com.status, 'failed');
  assert.equal(ctx.job, null, '必须清掉派出的任务');

  // 已经停了就不重复清
  assert.equal(ctx.module.forceStopRunState('run-1'), false);
});

test('纯心跳写入不触发旁观页面重绘', () => {
  const { module: M } = setupCoordinator();
  const base = { running: true, runId: 'run-1', current: 1, total: 3, updatedAt: '2026-01-01T00:00:00.000Z' };

  // 只有 updatedAt 变：面板上看不出区别，重绘只会清空用户正在输入的框
  assert.equal(M.isHeartbeatOnlyChange(
    JSON.stringify(base),
    JSON.stringify({ ...base, updatedAt: '2026-01-01T00:00:05.000Z' })
  ), true);

  // 进度推进、终止请求、运行结束都必须重绘
  for (const patch of [{ current: 2 }, { abortRequestedAt: 123 }, { running: false }]) {
    assert.equal(M.isHeartbeatOnlyChange(
      JSON.stringify(base),
      JSON.stringify({ ...base, ...patch, updatedAt: '2026-01-01T00:00:05.000Z' })
    ), false, `${JSON.stringify(patch)} 必须触发重绘`);
  }

  // 解析不了就当有变化，宁可多绘不可漏绘
  assert.equal(M.isHeartbeatOnlyChange('{bad', '{bad'), false);
  assert.equal(M.isHeartbeatOnlyChange(null, JSON.stringify(base)), false);
});

test('推进进度不会抹掉同一瞬间写下的终止请求', () => {
  const ctx = setupCoordinator({
    running: true,
    runId: 'run-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    abortRequestedAt: 4242
  });

  // 「终止」按钮和进度推进可能落在同一瞬间。整对象覆盖会丢掉
  // abortRequestedAt，那一轮就再也停不下来。
  ctx.module.saveActiveRunState('run-1', '2026-01-01T00:00:00.000Z', { current: 2, total: 3 });
  assert.equal(ctx.state.abortRequestedAt, 4242, '终止请求必须保留');
  assert.equal(ctx.state.current, 2);

  // 换了一轮就不该继承上一轮的终止请求
  ctx.module.saveActiveRunState('run-2', '2026-01-01T00:01:00.000Z', { current: 1, total: 3 });
  assert.equal(ctx.state.abortRequestedAt, undefined, '新一轮不继承旧终止请求');
});

test('心跳只刷新自己那一轮的时间戳', () => {
  const ctx = setupCoordinator({ running: true, runId: 'run-1', updatedAt: '2026-01-01T00:00:00.000Z' });

  // 不是自己的那一轮：不许碰
  ctx.module.heartbeatRunState('run-2');
  assert.equal(ctx.state.updatedAt, '2026-01-01T00:00:00.000Z');

  // 已经停了：不许把 running 状态复活
  ctx.setState({ running: false, runId: 'run-1', updatedAt: '2026-01-01T00:00:00.000Z' });
  ctx.module.heartbeatRunState('run-1');
  assert.equal(ctx.state.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(ctx.state.running, false);
});
