// ===== 入口 =====
function getHostname() {
  try {
    return location.hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

// 当前域名在不在站点列表里
function isKnownSite(host) {
  return getRawSites().some(site => site.domain === host);
}

function registerMenuCommands(known) {
  GM_registerMenuCommand('打开签到面板', () => togglePanel(true));

  GM_registerMenuCommand('开始签到（全部启用站点）', () => {
    togglePanel(true);
    runBatchCheckIn().catch(error => showToast(`出错了: ${error.message}`));
  });

  GM_registerMenuCommand('关闭本轮打开的标签页', () => {
    const closed = closeAllOpenedTabs();
    showToast(closed > 0
      ? `已关闭 ${closed} 个标签页`
      : '没有可关的标签页（只有发起签到的那个页面能关）');
  });

  if (known) {
    GM_registerMenuCommand('只签当前站点', () => {
      togglePanel(true);
      const site = getSites().find(s => s.domain === getHostname());
      if (site) {
        runBatchCheckIn([site.siteId]).catch(error => showToast(`出错了: ${error.message}`));
      }
    });
  } else {
    GM_registerMenuCommand('把当前页面加为签到页', () => {
      togglePanel(true);
      handleAddSite(location.href, false);
    });
  }
}

async function main() {
  const host = getHostname();
  if (!host) return;

  const known = isKnownSite(host);

  // hook 必须在 document-start 装，否则抓不到页面早期发出的签到请求
  if (known) installNetworkHooks();

  await waitForBodyReady();
  registerMenuCommands(known);

  // 不在列表里的站点：只留菜单入口，不做任何自动动作
  if (!known) return;

  // 认领任务：域名对得上，且任务是刚派出来的。
  // 时间窗口用来排除你手上其它同域标签页——它们如果稍后发生导航，
  // 那时任务早已被清掉或超出窗口，不会重复签到。
  // 已知站点一律监听聚焦请求：面板上点"切过来"时，
  // 由这个页面自己调 window.focus()，而不是新开一个标签页
  watchFocusRequests(host);

  const job = getJob();
  if (isJobFresh(job, host)) {
    // 立刻标记已认领，防止同域的另一个页面也把这个任务执行一遍
    saveJob({ ...job, claimedAt: Date.now() });
    await runWorker(job);
    return;
  }

  // 没被派活：批量进行中时显示面板跟进度。
  // 用 isRunStateFresh 而非裸 running：陈旧的运行态不值得为它弹面板。
  if (isRunStateFresh(getRunState())) {
    togglePanel(true);
    watchSharedState();
  }
}

// 让非协调者页面也能看到进度更新
function watchSharedState() {
  try {
    GM_addValueChangeListener(KEY_RESULTS, (name, oldValue, newValue, remote) => {
      if (remote && panelVisible) renderPanel();
    });
    GM_addValueChangeListener(KEY_RUN, (name, oldValue, newValue, remote) => {
      if (!remote || !panelVisible) return;
      // 协调者每 5 秒心跳一次，只动 updatedAt。那种写入没有可见变化，
      // 重绘它等于每 5 秒清空一次用户正在输入的“添加站点”输入框。
      if (isHeartbeatOnlyChange(oldValue, newValue)) return;
      renderPanel();
    });
  } catch (e) { /* 不支持就靠手动刷新 */ }
}

function waitForBodyReady() {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.documentElement, { childList: true });
    setTimeout(() => {
      observer.disconnect();
      resolve();
    }, 8000);
  });
}

main().catch((error) => {
  console.error('[签到助手] 初始化失败:', error);
});
