// ===== 协调者：逐个开后台标签页，收结果 =====
// 只在你点"开始签到"的那个页面运行。

let coordinatorAborted = false;

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

function pickGap(settings) {
  const min = Math.max(0, Number(settings.gapMinMs) || 0);
  const max = Math.max(min, Number(settings.gapMaxMs) || min);
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
  return now - assignedAt <= JOB_CLAIM_WINDOW_MS;
}

// 等某个站点的结果写入，或超时
function waitForSiteResult(siteId, timeoutMs) {
  return new Promise((resolve) => {
    let listenerId = null;
    let timer = null;

    function finish(result) {
      if (listenerId !== null) {
        try { GM_removeValueChangeListener(listenerId); } catch (e) { /* 已移除 */ }
        listenerId = null;
      }
      if (timer) clearTimeout(timer);
      resolve(result);
    }

    // 先查一次，避免结果早于监听写入
    const existing = getResults()[siteId];
    if (existing && existing.status !== 'checking') {
      finish(existing);
      return;
    }

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

    timer = setTimeout(() => {
      finish({ status: 'failed', message: '处理超时，站点可能加载太慢' });
    }, timeoutMs);
  });
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

  coordinatorAborted = false;

  // 清空上一轮结果。
  // 单站点重试只清该站点，别抹掉其它站点已有的结果。
  if (siteIds) {
    const kept = getResults();
    for (const siteId of siteIds) delete kept[siteId];
    saveResults(kept);
  } else {
    saveResults({});
  }

  saveRunState({
    running: true,
    total: targets.length,
    current: 0,
    startedAt: new Date().toISOString()
  });
  renderPanel();

  const collected = {};

  for (let index = 0; index < targets.length; index++) {
    if (coordinatorAborted) break;

    const site = targets[index];
    saveRunState({
      running: true,
      total: targets.length,
      current: index + 1,
      currentSiteId: site.siteId,
      startedAt: new Date().toISOString()
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
      collected[site.siteId] = { status: 'failed', message: `打开标签页失败: ${e.message}` };
      saveResults({ ...getResults(), ...collected });
      clearJob();
      continue;
    }

    const result = await waitForSiteResult(site.siteId, settings.siteTimeoutMs);
    collected[site.siteId] = result;

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
      await sleep(pickGap(settings));
    }
  }

  clearJob();
  saveLastCheckInTime(new Date().toISOString());
  saveRunState({ running: false, finishedAt: new Date().toISOString() });
  renderPanel();

  const summary = summarizeResults(collected);
  const remaining = getOpenedTabCount();
  showToast(remaining > 0
    ? `${summary.text}。${remaining} 个标签页留着供你核对`
    : summary.text);
}

function abortBatchCheckIn() {
  coordinatorAborted = true;
  clearJob();

  const results = getResults();
  for (const [siteId, result] of Object.entries(results)) {
    if (result?.status === 'checking') {
      results[siteId] = { ...result, status: 'failed', message: '已中断' };
    }
  }
  saveResults(results);
  saveRunState({ running: false, finishedAt: new Date().toISOString() });
  renderPanel();
  showToast('已终止');
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
