// ===== 工作者：在被打开的站点页面上跑一次签到 =====
// 油猴的标签页数据能跨刷新和登录跳转保留，也不会被其它同域标签页继承。
function readWorkerTab() {
  return new Promise(resolve => {
    try {
      GM_getTab(tab => resolve(isRecord(tab) ? tab : {}));
    } catch (e) {
      resolve(null);   // 不支持标签页存储时仍能执行本页任务，手动继续作为兜底
    }
  });
}

function isWorkerJobActive(job, now = Date.now()) {
  return isCurrentJob(job) && now >= job.assignedAt && now < job.expiresAt;
}

async function claimWorkerJob(host) {
  const tab = await readWorkerTab();
  // 读取标签页数据期间任务可能已经改变，必须重新取共享任务。
  const job = getJob();
  if (job?.site?.domain !== host || !isWorkerJobActive(job)) return null;

  if (job.claimedAt) {
    return isSameJob(job, tab?.checkInJob) ? { ...job, resumed: true } : null;
  }
  if (!isJobFresh(job, host)) return null;

  if (tab) {
    try {
      GM_saveTab({
        ...tab,
        checkInJob: { runId: job.runId, assignedAt: job.assignedAt, site: { siteId: job.site.siteId } }
      });
    } catch (e) { /* 本页仍可继续，只是不支持跳转后接续 */ }
  }
  const claimed = { ...job, claimedAt: Date.now() };
  saveJob(claimed);
  return claimed;
}

async function runWorker(job) {
  const site = job.site;
  if (!reportResult(site.siteId, { status: 'checking', message: '签到中', siteName: site.siteName }, job)) return;

  try {
    const result = await checkInOnThisPage(site, {
      isActive: () => isWorkerJobActive(job),
      resumed: job.resumed === true,
      previousClick: job.click,
      beforeClick: click => {
        if (!isWorkerJobActive(job)) return false;
        // 点击前持久化，页面马上跳转时也不会在新页面重复点击。
        saveJob({ ...getJob(), click });
        return true;
      }
    });
    if (!result || !isWorkerJobActive(job)) return;

    // 站点名没被手动改过时，顺手从页面学一个
    const raw = getRawSites().find(s => s.domain === site.domain);
    if (canAutoUpdateName(raw)) {
      const name = readSiteNameFromPage(site.domain);
      if (name) {
        patchRawSite(site.domain, { name });
        result.siteName = name;
      }
    }
    result.siteName = result.siteName || site.siteName;

    if (!reportResult(site.siteId, result, job)) return;

    // 需要你亲自处理时，这个标签页会被保留下来。
    // 在页面上直接说明要做什么，并等你从面板点"切过来"。
    if (result.needsHuman || result.needsLogin) {
      showWorkerNotice(result);
    }
  } catch (error) {
    reportResult(site.siteId, {
      status: 'failed',
      message: error?.message || '签到过程出错',
      siteName: site.siteName
    }, job);
  }
}

// 在被保留的标签页上显示一条提示，说明卡在哪一步
function showWorkerNotice(result) {
  const text = result.needsHuman
    ? '签到助手：请完成页面上的人机验证，然后手动点一次签到'
    : '签到助手：请先登录，登录后回签到面板点 ↻ 重试这个站点';
  showStickyNotice(text);
}

function reportResult(siteId, result, job) {
  if (!isWorkerJobActive(job)) return false;
  const results = getResults();
  results[siteId] = { ...result, runId: job.runId, assignedAt: job.assignedAt, at: Date.now() };
  saveResults(results);
  return true;
}
