// ===== 协调者：逐个开后台标签页，收结果 =====
// 只在你点"开始签到"的那个页面运行。

let coordinatorAborted = false;
let activeCoordinatorRunId = null;
let cancelCoordinatorWait = null;

const RUN_STATE_TTL_MS = 15 * 60 * 1000;

function createRunId(now = Date.now()) {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRunStateFresh(state, now = Date.now()) {
  if (state?.running !== true) return false;
  const timestamp = Date.parse(state.updatedAt || state.startedAt || '');
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= 0 && age <= RUN_STATE_TTL_MS;
}

function isRunAbortRequested(runId, state = getRunState()) {
  return Boolean(runId && state?.runId === runId && state.abortRequestedAt);
}

function ownsRun(runId, state = getRunState()) {
  return Boolean(runId && state?.running === true && state.runId === runId);
}

function saveActiveRunState(runId, startedAt, patch = {}) {
  saveRunState({
    running: true,
    runId,
    startedAt,
    updatedAt: new Date().toISOString(),
    ...patch
  });
}

// 本轮开过的标签页。GM_openInTab 返回的句柄是活对象，
// 存不进 GM_setValue，只能留在协调者页面的内存里。
// 代价是刷新协调者页面后就没法一键关闭了，只能手动关。
const openedTabs = new Map();

function rememberOpenedTab(siteId, siteName, handle) {
  openedTabs.set(siteId, { siteName, handle, at: Date.now() });
}

function closeRememberedTab(siteId) {
  const entry = openedTabs.get(siteId);
  if (!entry) return false;
  openedTabs.delete(siteId);
  try {
    entry.handle.close();
    return true;
  } catch (e) {
    return false;   // 你已经手动关了
  }
}

function getOpenedTabCount() {
  return openedTabs.size;
}

// 关掉本轮开的全部标签页
function closeAllOpenedTabs() {
  let closed = 0;
  for (const siteId of [...openedTabs.keys()]) {
    if (closeRememberedTab(siteId)) closed++;
  }
  return closed;
}

// 需要你亲自处理的标签页不该被自动关掉
function shouldKeepTabOpen(result) {
  return result?.needsHuman === true || result?.needsLogin === true;
}

function pickGap(settings = {}) {
  const rawMin = Number(settings.gapMinMs);
  const rawMax = Number(settings.gapMaxMs);
  const min = Number.isFinite(rawMin) ? Math.max(0, rawMin) : 0;
  const max = Number.isFinite(rawMax) ? Math.max(min, rawMax) : min;
  if (max === min) return min;
  return min + Math.random() * (max - min);
}

// 任务有效期：协调者派出任务后，新标签页应当在这段时间内加载并认领。
// 超出就不认，避免陈旧任务被无关的页面导航捡走。
const JOB_CLAIM_WINDOW_MS = 30000;

function isJobFresh(job, host, now = Date.now()) {
  if (!job?.site?.domain) return false;
  if (job.site.domain !== host) return false;
  if (job.claimedAt) return false;   // 已经被认领过，不再重复
  const assignedAt = Number(job.assignedAt || 0);
  if (!assignedAt) return false;
  const age = now - assignedAt;
  return age >= 0 && age <= JOB_CLAIM_WINDOW_MS;
}

// 等某个站点的结果写入，或超时
function waitForSiteResult(siteId, timeoutMs, runId = null) {
  return new Promise((resolve, reject) => {
    let listenerId = null;
    let runListenerId = null;
    let timer = null;
    let settled = false;

    function cleanup() {
      if (listenerId !== null) {
        try { GM_removeValueChangeListener(listenerId); } catch (e) { /* 已移除 */ }
        listenerId = null;
      }
      if (runListenerId !== null) {
        try { GM_removeValueChangeListener(runListenerId); } catch (e) { /* 已移除 */ }
        runListenerId = null;
      }
      if (timer) clearTimeout(timer);
      if (cancelCoordinatorWait === cancel) cancelCoordinatorWait = null;
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function cancel() {
      finish({ status: 'failed', message: '已中断', aborted: true });
    }

    if (runId && isRunAbortRequested(runId)) {
      cancel();
      return;
    }

    // 先查一次，避免结果早于监听写入
    const existing = getResults()[siteId];
    if (existing && existing.status !== 'checking') {
      finish(existing);
      return;
    }

    try {
      listenerId = GM_addValueChangeListener(KEY_RESULTS, (name, oldValue, newValue, remote) => {
        if (!remote) return;
        let parsed = null;
        try {
          parsed = typeof newValue === 'string' ? JSON.parse(newValue) : newValue;
        } catch (e) {
          return;
        }
        const result = parsed?.[siteId];
        if (result && result.status !== 'checking') finish(result);
      });

      if (runId) {
        runListenerId = GM_addValueChangeListener(KEY_RUN, (name, oldValue, newValue) => {
          let state = null;
          try {
            state = typeof newValue === 'string' ? JSON.parse(newValue) : newValue;
          } catch (e) {
            return;
          }
          if (isRunAbortRequested(runId, state)) cancel();
        });
        cancelCoordinatorWait = cancel;
        if (isRunAbortRequested(runId)) cancel();
      }

      if (settled) return;
      timer = setTimeout(() => {
        finish({ status: 'failed', message: '处理超时，站点可能加载太慢' });
      }, timeoutMs);
    } catch (error) {
      fail(error);
    }
  });
}

async function waitForBatchGap(ms, runId) {
  const deadline = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < deadline) {
    if (isRunAbortRequested(runId)) return false;
    await sleep(Math.min(500, deadline - Date.now()));
  }
  return !isRunAbortRequested(runId);
}

async function runBatchCheckIn(siteIds = null) {
  const settings = getSettings();
  const targets = getSites().filter(site =>
    site.enabled && (!siteIds || siteIds.includes(site.siteId))
  );

  if (targets.length === 0) {
    showToast(siteIds ? '这个站点已被禁用' : '没有启用的站点');
    return;
  }

  if (isRunStateFresh(getRunState())) {
    showToast('已有签到任务正在运行');
    return;
  }

  coordinatorAborted = false;
  const runId = createRunId();
  const startedAt = new Date().toISOString();
  activeCoordinatorRunId = runId;
  const collected = {};

  try {
    // 多个页面可能在同一瞬间都读到“空闲”。先各自写入 runId，短暂让出事件循环，
    // 再确认最终所有权；只有最后仍持有共享状态的页面可以继续。
    saveActiveRunState(runId, startedAt, { total: targets.length, current: 0 });
    await sleep(50 + Math.random() * 100);
    if (!ownsRun(runId)) {
      showToast('已有签到任务正在运行');
      return;
    }

    // 清空上一轮结果。
    // 单站点重试只清该站点，别抹掉其它站点已有的结果。
    if (siteIds) {
      const kept = getResults();
      for (const siteId of siteIds) delete kept[siteId];
      saveResults(kept);
    } else {
      saveResults({});
    }

    renderPanel();

    for (let index = 0; index < targets.length; index++) {
      if (coordinatorAborted || isRunAbortRequested(runId)) {
        coordinatorAborted = true;
        break;
      }

      const site = targets[index];
      saveActiveRunState(runId, startedAt, {
        total: targets.length,
        current: index + 1,
        currentSiteId: site.siteId
      });
      // 任务只在派出后的短时间内有效。这样同域其它已打开的标签页即便
      // 之后发生导航，也不会认领到这个任务、重复签到。
      // 不往 URL 上加任何标记：站点可能用 hash 路由（如 /#/checkin），
      // 动了 URL 就会把路由改坏。
      saveJob({ site, assignedAt: Date.now() });
      renderPanel();

      let handle = null;
      try {
        handle = GM_openInTab(site.visitUrl, {
          active: false,
          insert: true,
          setParent: true
        });
      } catch (e) {
        const reason = e?.message || String(e || '未知错误');
        collected[site.siteId] = { status: 'failed', message: `打开标签页失败: ${reason}` };
        saveResults({ ...getResults(), ...collected });
        clearJob();
        continue;
      }

      const result = await waitForSiteResult(site.siteId, settings.siteTimeoutMs, runId);
      collected[site.siteId] = result;
      if (result.aborted || isRunAbortRequested(runId)) coordinatorAborted = true;

      // 默认把标签页留着，让你能自己核对签到结果。
      // 攒下句柄，之后用面板上的「关闭标签页」一次性关掉。
      if (handle) {
        rememberOpenedTab(site.siteId, site.siteName, handle);
      }
      if (settings.autoCloseTab === true && !shouldKeepTabOpen(result)) {
        closeRememberedTab(site.siteId);
      }

      clearJob();
      renderPanel();

      if (index < targets.length - 1 && !coordinatorAborted) {
        const completedGap = await waitForBatchGap(pickGap(settings), runId);
        if (!completedGap) coordinatorAborted = true;
      }
    }
  } finally {
    cancelCoordinatorWait = null;
    activeCoordinatorRunId = null;
    const state = getRunState();
    if (state.runId === runId) {
      clearJob();
      saveRunState({
        running: false,
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        aborted: coordinatorAborted
      });
    }
    renderPanel();
  }

  if (coordinatorAborted) {
    showToast('已终止');
    return;
  }

  saveLastCheckInTime(new Date().toISOString());
  const summary = summarizeResults(collected);
  const remaining = getOpenedTabCount();
  showToast(remaining > 0
    ? `${summary.text}。${remaining} 个标签页留着供你核对`
    : summary.text);
}

function abortBatchCheckIn() {
  const state = getRunState();
  if (state.running !== true) {
    showToast('当前没有运行中的任务');
    return false;
  }

  saveRunState({
    ...state,
    abortRequestedAt: Date.now(),
    updatedAt: new Date().toISOString()
  });

  if (!state.runId || state.runId === activeCoordinatorRunId) {
    coordinatorAborted = true;
    cancelCoordinatorWait?.();
  }

  const results = getResults();
  for (const [siteId, result] of Object.entries(results)) {
    if (result?.status === 'checking') {
      results[siteId] = { ...result, status: 'failed', message: '已中断' };
    }
  }
  saveResults(results);
  renderPanel();
  showToast('正在终止');
  return true;
}

function summarizeResults(results) {
  const values = Object.values(results || {});
  const success = values.filter(r => r?.status === 'success').length;
  const already = values.filter(r => r?.status === 'already').length;
  const unknown = values.filter(r => r?.status === 'unknown').length;
  const failed = values.filter(r => r?.status === 'failed' || r?.status === 'invalid').length;

  const parts = [];
  if (success) parts.push(`成功 ${success}`);
  if (already) parts.push(`已签 ${already}`);
  if (unknown) parts.push(`待确认 ${unknown}`);
  if (failed) parts.push(`失败 ${failed}`);

  return {
    success, already, unknown, failed,
    text: parts.length ? `签到完成：${parts.join('，')}` : '签到完成'
  };
}
