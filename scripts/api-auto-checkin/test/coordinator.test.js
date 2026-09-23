const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');

function setupCoordinator(initialState = { running: true, runId: 'run-1' }, initialResults = {}, options = {}) {
  const source = fs.readFileSync(path.join(srcDir, '60-coordinator.js'), 'utf8');
  const listeners = new Map();
  const timers = new Map();
  const opened = [];
  const toasts = [];
  let nextListenerId = 1;
  let nextTimerId = 1;
  let state = initialState;
  let results = initialResults;
  let job = null;
  let renderCount = 0;

  function fire(key, value, remote = true) {
    for (const listener of [...listeners.values()]) {
      if (listener.key === key) listener.callback(key, null, JSON.stringify(value), remote);
    }
  }

  function schedule(callback, delay, repeat = false) {
    const id = nextTimerId++;
    timers.set(id, { callback, delay, repeat });
    return id;
  }

  const globals = {
    getRunState: () => state,
    saveRunState: next => { state = next; fire('run', next, false); },
    getResults: () => results,
    saveResults: next => { results = next; fire('results', next, false); },
    getJob: () => job,
    saveJob: next => { job = next; },
    clearJob: () => { job = null; },
    renderPanel: () => { renderCount++; },
    isRecord: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    GM_addValueChangeListener: (key, callback) => {
      const id = nextListenerId++;
      listeners.set(id, { key, callback });
      if (key === 'results' && options.resultOnListen) results = options.resultOnListen;
      return id;
    },
    GM_removeValueChangeListener: id => listeners.delete(id),
    KEY_RESULTS: 'results',
    KEY_RUN: 'run',
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearInterval: id => timers.delete(id),
    getSettings: () => ({ gapMinMs: 0, gapMaxMs: 0, siteTimeoutMs: 90000, ...options.settings }),
    getSites: () => options.sites || [],
    sleep: async () => {},
    showToast: message => toasts.push(message),
    saveLastCheckInTime: () => {},
    GM_openInTab: url => {
      const handle = { url, closed: false, close() { handle.closed = true; } };
      opened.push(handle);
      return handle;
    }
  };

  const factory = new Function(...Object.keys(globals), `
      ${source}
      return {
        waitForSiteResult, isRunStateFresh, isJobFresh, ownsRun,
        pickClaimTimeout, pickClaimDeadline, forceStopRunState, heartbeatRunState,
        isHeartbeatOnlyChange, saveActiveRunState, finishCurrentSite, runBatchCheckIn,
        RUN_STATE_TTL_MS, RUN_HEARTBEAT_MS,
        CLAIM_HEARTBEAT_TIMEOUT_MS, JOB_CLAIM_WINDOW_MS
      };
    `
  );

  const module = factory(...Object.values(globals));

  return {
    module,
    setState(next) { state = next; },
    setResults(next) { results = next; },
    setJob(next) { job = next; },
    get state() { return state; },
    get results() { return results; },
    get job() { return job; },
    get renderCount() { return renderCount; },
    fire,
    fireTimers(delay) {
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.delay !== delay || !timers.has(id)) continue;
        if (!timer.repeat) timers.delete(id);
        timer.callback();
      }
    },
    opened,
    toasts,
    get listenerCount() { return listeners.size; },
    get timerCount() { return timers.size; }
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
  assert.equal(ctx.timerCount, 0);
});

test('本地手动结果和远程 worker 结果都立即解除等待', async () => {
  for (const remote of [false, true]) {
    const ctx = setupCoordinator();
    const pending = ctx.module.waitForSiteResult('a_com', 90000, 'run-1');
    const result = { status: 'success', runId: 'run-1', message: '签到完成' };
    ctx.fire('results', { a_com: result }, remote);
    assert.deepEqual(await pending, result);
    assert.equal(ctx.listenerCount, 0);
    assert.equal(ctx.timerCount, 0);
  }
});

test('旧轮次和其它站点的结果不能结束当前等待', async () => {
  const ctx = setupCoordinator();
  const pending = ctx.module.waitForSiteResult('a_com', 90000, 'run-1');
  ctx.fire('results', { a_com: { status: 'success', runId: 'run-old' } });
  ctx.fire('results', { b_com: { status: 'success', runId: 'run-1' } });
  assert.equal(ctx.listenerCount, 2);

  const result = { status: 'already', runId: 'run-1' };
  ctx.fire('results', { a_com: result });
  assert.deepEqual(await pending, result);
});

test('读取与注册监听之间落盘的结果不会漏掉', async () => {
  const result = { status: 'success', runId: 'run-1' };
  const ctx = setupCoordinator(undefined, {}, { resultOnListen: { a_com: result } });
  assert.deepEqual(await ctx.module.waitForSiteResult('a_com', 90000, 'run-1'), result);
  assert.equal(ctx.listenerCount, 0);
  assert.equal(ctx.timerCount, 0);
});

test('漏发变更事件时轮询能读到完成结果', async () => {
  const ctx = setupCoordinator();
  const pending = ctx.module.waitForSiteResult('a_com', 90000, 'run-1');
  const result = { status: 'success', runId: 'run-1' };
  ctx.setResults({ a_com: result });
  ctx.fireTimers(1000);
  assert.deepEqual(await pending, result);
  assert.equal(ctx.timerCount, 0);
});

test('后台定时器延迟时先读已落盘结果再判超时', async () => {
  const ctx = setupCoordinator();
  const pending = ctx.module.waitForSiteResult('a_com', 90000, 'run-1');
  const result = { status: 'success', runId: 'run-1' };
  ctx.setResults({ a_com: result });
  ctx.fireTimers(90000);
  assert.deepEqual(await pending, result);
  assert.equal(ctx.listenerCount, 0);
});

test('另一轮接管后立即结束旧等待并清理监听', async () => {
  const ctx = setupCoordinator();
  const pending = ctx.module.waitForSiteResult('a_com', 90000, 'run-1');
  ctx.setState({ running: true, runId: 'run-2' });
  ctx.fire('run', ctx.state);
  assert.equal((await pending).aborted, true);
  assert.equal(ctx.listenerCount, 0);
  assert.equal(ctx.timerCount, 0);
});

const batchSites = ['a', 'b'].map(name => ({
  siteId: `${name}_com`, domain: `${name}.com`, siteName: name,
  visitUrl: `https://${name}.com/checkin`, enabled: true
}));

test('手动完成后队列开下一站，跳过保留标签页且不算成功', async () => {
  const ctx = setupCoordinator({ running: false }, {}, {
    sites: batchSites, settings: { autoCloseTab: true }
  });
  const pending = ctx.module.runBatchCheckIn();
  await new Promise(setImmediate);
  assert.equal(ctx.opened.length, 1);
  assert.equal(ctx.job.runId, ctx.state.runId);
  assert.equal(ctx.job.expiresAt - ctx.job.assignedAt, 90000);
  const runId = ctx.state.runId;

  assert.equal(ctx.module.finishCurrentSite('run-old', 'a_com', 'success'), false);
  assert.equal(ctx.module.finishCurrentSite(runId, 'b_com', 'success'), false);
  assert.equal(ctx.module.finishCurrentSite(runId, 'a_com', 'failed'), false);
  assert.equal(ctx.module.finishCurrentSite(runId, 'a_com', 'success'), true);
  assert.equal(ctx.module.finishCurrentSite(runId, 'a_com', 'success'), false, '双击不能重复处理');
  await new Promise(setImmediate);

  assert.equal(ctx.opened.length, 2, '无需触发超时定时器就应打开下一站');
  assert.equal(ctx.results.a_com.status, 'success');
  assert.equal(ctx.results.a_com.manual, true);
  assert.equal(ctx.opened[0].closed, true);
  assert.equal(ctx.module.finishCurrentSite(runId, 'a_com', 'unknown'), false, '旧按钮不能跳过下一站');
  assert.equal(ctx.module.finishCurrentSite(runId, 'b_com', 'unknown'), true);
  await pending;

  assert.equal(ctx.results.b_com.status, 'unknown');
  assert.equal(ctx.results.b_com.skipped, true);
  assert.equal(ctx.opened[1].closed, false);
  assert.equal(ctx.state.running, false);
  assert.equal(ctx.job, null);
  assert.equal(ctx.listenerCount, 0);
  assert.equal(ctx.timerCount, 0);
});

test('真实超时会落盘失败结果，不会让面板残留签到中', async () => {
  const ctx = setupCoordinator({ running: false }, {}, { sites: batchSites.slice(0, 1) });
  const pending = ctx.module.runBatchCheckIn();
  await new Promise(setImmediate);
  ctx.setResults({ a_com: { status: 'checking', runId: ctx.state.runId } });
  ctx.fireTimers(90000);
  await pending;
  assert.equal(ctx.results.a_com.status, 'failed');
  assert.match(ctx.results.a_com.message, /超时/);
  assert.equal(ctx.job, null);
  assert.equal(ctx.timerCount, 0);
});

test('强制结束当前轮次不会被误报为另一页面接管', async () => {
  const ctx = setupCoordinator({ running: false }, {}, { sites: batchSites.slice(0, 1) });
  const pending = ctx.module.runBatchCheckIn();
  await new Promise(setImmediate);
  assert.equal(ctx.module.forceStopRunState(ctx.state.runId), true);
  await pending;
  assert.equal(ctx.state.aborted, true);
  assert.equal(ctx.toasts.at(-1), '已终止');
  assert.equal(ctx.timerCount, 0);
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
