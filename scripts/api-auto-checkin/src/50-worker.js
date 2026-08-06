// ===== 工作者：在被打开的站点页面上跑一次签到 =====
async function runWorker(job) {
  const site = job.site;
  reportResult(site.siteId, { status: 'checking', message: '签到中', siteName: site.siteName });

  try {
    const result = await checkInOnThisPage(site);

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

    reportResult(site.siteId, result);

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
    });
  }
}

// 在被保留的标签页上显示一条提示，说明卡在哪一步
function showWorkerNotice(result) {
  const text = result.needsHuman
    ? '签到助手：请完成页面上的人机验证，然后手动点一次签到'
    : '签到助手：请先登录，登录后回签到面板点 ↻ 重试这个站点';
  showStickyNotice(text);
}

function reportResult(siteId, result) {
  const results = getResults();
  results[siteId] = { ...result, at: Date.now() };
  saveResults(results);
}
