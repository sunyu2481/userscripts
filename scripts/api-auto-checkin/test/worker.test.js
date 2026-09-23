const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');

function createSharedState() {
  const assignedAt = Date.now();
  return {
    state: { running: true, runId: 'run-1', currentSiteId: 'a_com' },
    job: {
      runId: 'run-1', assignedAt, claimBy: assignedAt + 40000, expiresAt: assignedAt + 90000,
      site: { siteId: 'a_com', domain: 'a.com', siteName: '甲站', visitUrl: 'https://a.com/checkin' }
    },
    results: {}
  };
}

function setupWorker({ shared = createSharedState(), tab = { data: {} }, checkIn, tabUnavailable = false } = {}) {
  const source = ['50-worker.js', '60-coordinator.js']
    .map(name => fs.readFileSync(path.join(srcDir, name), 'utf8')).join('\n');
  const notices = [];
  const globals = {
    getJob: () => structuredClone(shared.job),
    saveJob: value => { shared.job = structuredClone(value); },
    getRunState: () => structuredClone(shared.state),
    getResults: () => structuredClone(shared.results),
    saveResults: value => { shared.results = structuredClone(value); },
    isRecord: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    GM_getTab: callback => {
      if (tabUnavailable) throw new Error('没有标签页存储');
      queueMicrotask(() => callback(structuredClone(tab.data)));
    },
    GM_saveTab: value => { tab.data = structuredClone(value); },
    checkInOnThisPage: checkIn || (async () => ({ status: 'success', message: '签到成功' })),
    getRawSites: () => [],
    canAutoUpdateName: () => false,
    showStickyNotice: message => notices.push(message),
    renderPanel: () => {}
  };
  const module = new Function(...Object.keys(globals), `
    ${source}
    return { claimWorkerJob, runWorker, reportResult, isWorkerJobActive, finishCurrentSite };
  `)(...Object.values(globals));
  return { module, shared, tab, notices };
}

test('原标签页在登录跳转后可接续，超过首次认领窗口仍受整体超时保护', async () => {
  const first = setupWorker({ tab: { data: { unrelated: '保留' } } });
  const claimed = await first.module.claimWorkerJob('a.com');
  assert.ok(claimed.claimedAt);
  assert.equal(first.shared.job.claimedAt, claimed.claimedAt);
  assert.equal(first.tab.data.unrelated, '保留');

  first.shared.job.claimBy = Date.now() - 1;
  const returnedPage = setupWorker({ shared: first.shared, tab: first.tab });
  const resumed = await returnedPage.module.claimWorkerJob('a.com');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.assignedAt, claimed.assignedAt);
  await returnedPage.module.runWorker(resumed);
  assert.equal(first.shared.results.a_com.status, 'success');
  assert.equal(first.shared.results.a_com.runId, claimed.runId);
  assert.equal(await returnedPage.module.claimWorkerJob('a.com'), null, '已完成的任务不再接续');
});

test('其它同域标签页和异域页面不能接走已认领任务', async () => {
  const first = setupWorker();
  await first.module.claimWorkerJob('a.com');
  const otherTab = setupWorker({ shared: first.shared });
  assert.equal(await otherTab.module.claimWorkerJob('a.com'), null);
  const sameTabOtherHost = setupWorker({ shared: first.shared, tab: first.tab });
  assert.equal(await sameTabOtherHost.module.claimWorkerJob('login.example.com'), null);
});

test('过期、终止、完成及已被替换的任务都不能因刷新复活', async () => {
  const changes = [
    shared => { shared.job.expiresAt = Date.now() - 1; },
    shared => { shared.state.abortRequestedAt = Date.now(); },
    shared => { shared.state.running = false; },
    shared => { shared.results.a_com = { status: 'unknown', skipped: true }; },
    shared => { shared.job.assignedAt++; },
    shared => { shared.job.runId = shared.state.runId = 'run-2'; },
    shared => { shared.state.currentSiteId = 'b_com'; }
  ];
  for (const change of changes) {
    const first = setupWorker();
    await first.module.claimWorkerJob('a.com');
    change(first.shared);
    const returnedPage = setupWorker({ shared: first.shared, tab: first.tab });
    assert.equal(await returnedPage.module.claimWorkerJob('a.com'), null);
  }
});

test('等待标签页数据期间被终止的任务不会执行', async () => {
  const ctx = setupWorker();
  const pending = ctx.module.claimWorkerJob('a.com');
  ctx.shared.state.abortRequestedAt = Date.now();
  assert.equal(await pending, null);
  assert.equal(ctx.shared.job.claimedAt, undefined);
});

test('点击记录跨页面保留，旧页面迟到的失败不能覆盖新页面的完成结果', async () => {
  let finishOriginal;
  const click = { clickedText: '领取奖励', initialAlreadyTexts: ['历史已签到'], initialToastTexts: [] };
  const first = setupWorker({
    checkIn: async (site, options) => {
      assert.equal(options.beforeClick(click), true);
      return new Promise(resolve => { finishOriginal = resolve; });
    }
  });
  const claimed = await first.module.claimWorkerJob('a.com');
  const originalWork = first.module.runWorker(claimed);
  assert.deepEqual(first.shared.job.click, click);

  const returnedPage = setupWorker({
    shared: first.shared, tab: first.tab,
    checkIn: async (site, options) => {
      assert.equal(options.resumed, true);
      assert.deepEqual(options.previousClick, click);
      return { status: 'already', message: '今日已签到' };
    }
  });
  await returnedPage.module.runWorker(await returnedPage.module.claimWorkerJob('a.com'));
  finishOriginal({ status: 'failed', message: '旧页面已失效' });
  await originalWork;
  assert.equal(first.shared.results.a_com.status, 'already');
});

test('手动完成或跳过后，旧 worker 停止点击且不覆盖人工结论', async () => {
  for (const status of ['success', 'unknown']) {
    let controls;
    let finish;
    const ctx = setupWorker({
      checkIn: (site, options) => {
        controls = options;
        return new Promise(resolve => { finish = resolve; });
      }
    });
    const claimed = await ctx.module.claimWorkerJob('a.com');
    const pending = ctx.module.runWorker(claimed);
    assert.equal(ctx.shared.results.a_com.status, 'checking');
    assert.equal(ctx.module.finishCurrentSite('run-1', 'a_com', status), true);
    const manual = structuredClone(ctx.shared.results.a_com);

    assert.equal(controls.isActive(), false);
    assert.equal(controls.beforeClick({ clickedText: '签到' }), false);
    assert.equal(ctx.shared.job.click, undefined);
    finish({ status: 'failed', message: '迟到的结果' });
    await pending;
    assert.deepEqual(ctx.shared.results.a_com, manual);
  }
});

test('超时与新一轮接管后旧 worker 不再回写', async () => {
  for (const change of [
    (shared, claimed) => { shared.job.expiresAt = claimed.expiresAt = Date.now() - 1; },
    shared => { shared.state.runId = 'run-2'; }
  ]) {
    let finish;
    const ctx = setupWorker({ checkIn: () => new Promise(resolve => { finish = resolve; }) });
    const claimed = await ctx.module.claimWorkerJob('a.com');
    const pending = ctx.module.runWorker(claimed);
    change(ctx.shared, claimed);
    const before = structuredClone(ctx.shared.results);
    finish({ status: 'success', message: '迟到的成功' });
    await pending;
    assert.deepEqual(ctx.shared.results, before);
  }
});

test('缺少标签页存储时本页仍能签到，刷新不能冒领已认领任务', async () => {
  const ctx = setupWorker({ tabUnavailable: true });
  const claimed = await ctx.module.claimWorkerJob('a.com');
  assert.ok(claimed);
  assert.equal(await ctx.module.claimWorkerJob('a.com'), null);
  await ctx.module.runWorker(claimed);
  assert.equal(ctx.shared.results.a_com.status, 'success');
});
