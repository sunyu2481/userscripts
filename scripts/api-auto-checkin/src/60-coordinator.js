// ===== 协调者：逐个开后台标签页，收结果 =====
// 只在你点"开始签到"的那个页面运行。

let coordinatorAborted = false;
let activeCoordinatorRunId = null;
let cancelCoordinatorWait = null;

// 协调者每 5 秒刷新一次 updatedAt。后台标签页的定时器会被浏览器降频到大约每分钟一次，
// TTL 留到 5 分钟，够扛几次漏拍，又不像早先的 15 分钟那样让人干等。
const RUN_STATE_TTL_MS = 300000;
const RUN_HEARTBEAT_MS = 5000;

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
  const state = getRunState();
  // 别抹掉别人刚写下的终止请求：进度推进和「终止」按钮可能落在同一瞬间，
  // 整对象覆盖会把 abortRequestedAt 丢掉，那一轮就再也停不下来了。
  const abortRequestedAt = state.runId === runId ? state.abortRequestedAt : undefined;
  saveRunState({
    running: true,
    runId,
    startedAt,
    ...(abortRequestedAt ? { abortRequestedAt } : {}),
    updatedAt: new Date().toISOString(),
    ...patch
  });
}

// 心跳：运行期间周期刷新 updatedAt，让其它页面据此判断协调者是否还活着
function heartbeatRunState(runId) {
  const state = getRunState();
  if (state.running === true && state.runId === runId) {
    saveRunState({ ...state, updatedAt: new Date().toISOString() });
  }
}

// 这次运行态写入是否只有心跳时间戳变了。
// 心跳每 5 秒一次且面板上看不出区别，旁观页面重绘它只会打断用户输入。
function isHeartbeatOnlyChange(oldValue, newValue) {
  try {
    const before = typeof oldValue === 'string' ? JSON.parse(oldValue) : oldValue;
    const after = typeof newValue === 'string' ? JSON.parse(newValue) : newValue;
    if (!isRecord(before) || !isRecord(after)) return false;
    // updatedAt 之外的字段全都没动，才算纯心跳
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    keys.delete('updatedAt');
    for (const key of keys) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return false;
    }
    return true;
  } catch (e) {
    return false;   // 解析不了就当有变化，照旧重绘
  }
}

// 强制清除运行态：协调者页面已消失、无人收尾时，用户点一下来自救。
// expectedRunId 是防误杀的闸门：面板渲染时看到的那一轮才允许清。
// 点按钮到落地之间若已有新一轮起来（runId 变了），直接放手，
// 否则会把别人刚写入的运行态改成 aborted，新一轮启动即死。
function forceStopRunState(expectedRunId = null) {
  const state = getRunState();
  if (state.running !== true) return false;
  if (expectedRunId && state.runId !== expectedRunId) return false;

  saveRunState({
    ...state,
    running: false,
    aborted: true,
    abortRequestedAt: state.abortRequestedAt || Date.now(),
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  clearJob();
  const results = getResults();
  for (const [siteId, result] of Object.entries(results)) {
    if (result?.status === 'checking') {
      results[siteId] = { ...result, status: 'failed', message: '已强制结束' };
    }
  }
  saveResults(results);
  if (activeCoordinatorRunId) {
    coordinatorAborted = true;
    cancelCoordinatorWait?.();
  }
  renderPanel();
  return true;
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
const JOB_CLAIM_WINDOW_MS = 40000;
const CLAIM_HEARTBEAT_TIMEOUT_MS = 45000;   // 略大于认领窗口，给"标签加载→认领→写 checking"留余量

// 认领超时必须严格小于主超时，否则提前放弃毫无意义：两个 setTimeout 延迟相同时
// 按注册顺序执行，主超时先注册就先 settle，认领分支永远轮不到。
// 只让开一步，不折半——折半会在 60s 这类设置下提前放弃仍在正常加载的标签页。
function pickClaimTimeout(timeoutMs) {
  const main = Number(timeoutMs);
  if (!Number.isFinite(main) || main <= 0) return CLAIM_HEARTBEAT_TIMEOUT_MS;
  return Math.min(CLAIM_HEARTBEAT_TIMEOUT_MS, Math.max(1000, main - 1000));
}

// 派发任务时算出截止时间。协调者正常收尾会 clearJob，这个值只在协调者
// 中途死掉、任务残留时才真正起作用：那时窗口不该超过用户配置的站点超时，
// 否则超时设 5s 的人会在之后 40s 里被任意一次同域导航悄悄签掉一次。
function pickClaimDeadline(timeoutMs, now = Date.now()) {
  const main = Number(timeoutMs);
  const window = Number.isFinite(main) && main > 0
    ? Math.min(JOB_CLAIM_WINDOW_MS, main)
    : JOB_CLAIM_WINDOW_MS;
  return now + window;
}

function isJobFresh(job, host, now = Date.now()) {
  if (!job?.site?.domain) return false;
  if (job.site.domain !== host) return false;
  if (job.claimedAt) return false;   // 已经被认领过，不再重复
  const assignedAt = Number(job.assignedAt || 0);
  if (!assignedAt) return false;
  if (now < assignedAt) return false;   // 时钟倒退，不认
  // claimBy 由派发方写入，跟着站点超时走；旧任务没这个字段时退回固定窗口
  const claimBy = Number(job.claimBy || 0);
  if (claimBy) return now <= claimBy;
  return now - assignedAt <= JOB_CLAIM_WINDOW_MS;
}

// 等某个站点的结果写入，或超时
function waitForSiteResult(siteId, timeoutMs, runId = null) {
  return new Promise((resolve, reject) => {
    let listenerId = null;
    let runListenerId = null;
    let timer = null;
    let claimTimer = null;
    let settled = false;
    let sawWorker = false;

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
      if (claimTimer) clearTimeout(claimTimer);
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
    if (existing) {
      sawWorker = true;
      if (existing.status !== 'checking') {
        finish(existing);
        return;
      }
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
        if (result) {
          sawWorker = true;
          if (result.status !== 'checking') finish(result);
        }
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
      // 没等到 worker 写入任何结果（含 checking）就提前放弃，不干等满主超时
      claimTimer = setTimeout(() => {
        if (!sawWorker) finish({ status: 'failed', message: '标签页未在时限内认领任务，可能被浏览器后台限制' });
      }, pickClaimTimeout(timeoutMs));
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
  let heartbeatTimer = null;
  let lostOwnership = false;

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
      // 上一轮中断时留下的 checking 没人收尾，会一直显示“签到中”。
      // 本轮不重试它们，就地落为失败，别让面板挂着假进度。
      for (const [siteId, result] of Object.entries(kept)) {
        if (result?.status === 'checking') {
          kept[siteId] = { ...result, status: 'failed', message: '上一轮未完成' };
        }
      }
      saveResults(kept);
    } else {
      saveResults({});
    }

    renderPanel();

    // 进入站点循环前启动心跳：运行期间周期刷新 updatedAt，标记协调者仍存活
    heartbeatTimer = setInterval(() => heartbeatRunState(runId), RUN_HEARTBEAT_MS);

    for (let index = 0; index < targets.length; index++) {
      if (coordinatorAborted || isRunAbortRequested(runId)) {
        coordinatorAborted = true;
        break;
      }
      // 运行态已经不是自己的了：本页面曾被浏览器冻结、心跳断过，别的页面按过期
      // 重新起了一轮。这里必须收手——否则下面的 saveActiveRunState / saveJob 会把
      // 新协调者的任务覆盖掉，两边交替抢 job，worker 会认领到错站点。
      if (!ownsRun(runId)) {
        lostOwnership = true;
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
      const assignedAt = Date.now();
      saveJob({
        site,
        assignedAt,
        claimBy: pickClaimDeadline(settings.siteTimeoutMs, assignedAt)
      });
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
    clearInterval(heartbeatTimer);
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

  // 掉队的一轮不算完成：别写“上次签到时间”，也别用只跑了一半的结果做汇总，
  // 那会盖掉接管方正在写的进度。
  if (lostOwnership) {
    showToast('本页已掉队，签到已由另一个页面接管');
    return;
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
  // 判活标准跟面板一致：过期的运行态按"没有任务"处理，
  // 否则这里会给一个早已消失的协调者发终止请求，用户看着"正在终止"永远不动。
  if (!isRunStateFresh(state)) {
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
