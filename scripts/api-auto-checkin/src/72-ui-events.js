// ===== 面板事件 =====
let panelRefreshTimer = null;
let stalePanelPainted = false;

function bindPanelEvents(panel, body) {
  // 惰性创建面板重绘定时器：运行期间每 2s 刷新进度。
  // 只创建一次；空闲时不重绘，避免清空正在输入的“添加站点”输入框。
  if (panelRefreshTimer === null) {
    panelRefreshTimer = setInterval(() => {
      if (!panelVisible) return;
      const state = getRunState();
      if (state.running !== true) {
        stalePanelPainted = false;
        return;
      }
      if (isRunStateFresh(state)) {
        stalePanelPainted = false;
        renderPanel();
        return;
      }
      // running 还挂着但心跳停了。本页无从区分"协调者页面已关"和"协调者只是被
      // 浏览器冻结"，所以绝不碰共享状态——那会终止另一个页面正跑着的一轮。
      // 只重绘一次：renderPanel 按过期算出 running=false，开始按钮就此解锁，
      // 用户可以直接开新一轮（掉队的旧协调者由 ownsRun 自己收手）。
      // 之后停手不再重绘，否则每 2s 清空一次正在输入的“添加站点”输入框。
      if (!stalePanelPainted) {
        stalePanelPainted = true;
        renderPanel();
      }
    }, 2000);
  }

  body.querySelector('[data-act="start"]')?.addEventListener('click', () => {
    runBatchCheckIn().catch(error => showToast(`出错了: ${error.message}`));
  });

  body.querySelector('[data-act="abort"]')?.addEventListener('click', abortBatchCheckIn);

  const forceStopBtn = body.querySelector('[data-act="force-stop"]');
  forceStopBtn?.addEventListener('click', () => {
    // 只清渲染这个按钮时看到的那一轮，别误杀期间新起的运行态
    const cleared = forceStopRunState(forceStopBtn.dataset.runId || null);
    showToast(cleared ? '已强制结束' : '这一轮已经结束了');
    renderPanel();
  });

  function submitNewSite() {
    handleAddSite(
      body.querySelector('[data-role="new-site"]')?.value,
      body.querySelector('[data-role="new-visit"]')?.checked === true,
      body.querySelector('[data-role="new-name"]')?.value
    );
  }

  body.querySelector('[data-act="add"]')?.addEventListener('click', submitNewSite);

  for (const role of ['new-site', 'new-name']) {
    body.querySelector(`[data-role="${role}"]`)?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitNewSite();
    });
  }

  body.querySelector('[data-act="toggle-settings"]')?.addEventListener('click', () => {
    settingsExpanded = !settingsExpanded;
    renderPanel();
  });

  body.querySelector('[data-role="gap-min"]')?.addEventListener('change', (event) => {
    saveSettings({ gapMinMs: Math.max(0, Number(event.target.value) || 0) * 1000 });
    renderPanel();
  });

  body.querySelector('[data-role="gap-max"]')?.addEventListener('change', (event) => {
    saveSettings({ gapMaxMs: Math.max(0, Number(event.target.value) || 0) * 1000 });
    renderPanel();
  });

  body.querySelector('[data-role="extra-words"]')?.addEventListener('change', (event) => {
    saveSettings({ extraButtonWords: String(event.target.value || '').trim() });
    showToast('已保存，下次签到生效');
  });

  body.querySelector('[data-role="auto-close"]')?.addEventListener('change', (event) => {
    saveSettings({ autoCloseTab: event.target.checked === true });
  });

  body.querySelector('[data-act="close-tabs"]')?.addEventListener('click', () => {
    const closed = closeAllOpenedTabs();
    showToast(closed > 0 ? `已关闭 ${closed} 个标签页` : '标签页都已经关了');
    renderPanel();
  });

  body.querySelector('[data-act="export"]')?.addEventListener('click', handleExport);
  body.querySelector('[data-act="import"]')?.addEventListener('click', handleImport);

  for (const link of body.querySelectorAll('[data-act="focus-tab"]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const siteId = link.closest('.gm-msg')?.previousElementSibling?.dataset?.site;
      const site = getSites().find(s => s.siteId === siteId);
      if (!site) {
        showToast('找不到对应站点');
        return;
      }
      handleFocusSiteTab(site);
    });
  }

  for (const link of body.querySelectorAll('[data-act="teach"]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const siteId = link.closest('.gm-msg')?.previousElementSibling?.dataset?.site;
      handleTeachButtonWords(siteId);
    });
  }

  for (const row of body.querySelectorAll('.gm-site')) {
    const siteId = row.dataset.site;

    row.querySelector('[data-act="toggle"]')?.addEventListener('change', (event) => {
      const site = getSites().find(s => s.siteId === siteId);
      if (!site) return;
      saveRawSites(getRawSites().map(raw =>
        raw.domain === site.domain ? { ...raw, enabled: event.target.checked } : raw
      ));
      renderPanel();
    });

    row.querySelector('[data-act="open"]')?.addEventListener('click', () => {
      const site = getSites().find(s => s.siteId === siteId);
      if (site) GM_openInTab(site.visitUrl, { active: true, insert: true });
    });

    row.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
      runBatchCheckIn([siteId]).catch(error => showToast(`出错了: ${error.message}`));
    });

    row.querySelector('[data-act="edit"]')?.addEventListener('click', () => handleEditSite(siteId));

    row.querySelector('[data-act="remove"]')?.addEventListener('click', async () => {
      const site = getSites().find(s => s.siteId === siteId);
      if (!site) return;
      if (!await showConfirm(`删除「${site.siteName}」？`)) return;
      saveRawSites(getRawSites().filter(raw => raw.domain !== site.domain));
      const results = getResults();
      delete results[siteId];
      saveResults(results);
      renderPanel();
    });
  }
}

// 切到那个站点的标签页。
// 油猴无法直接聚焦已存在的标签页，只能请它自己切到前台；
// 它已经被关掉时再退回新开一个。
function handleFocusSiteTab(site) {
  requestTabFocus(site.domain);
  showToast(`正在切到 ${site.siteName}`);

  // 给目标页一点时间响应。它若已不在，就没人清掉这条请求，
  // 那时才新开标签页。
  setTimeout(() => {
    const pending = readFocusRequest();
    if (pending?.domain !== site.domain) return;   // 已被响应
    clearFocusRequest();
    GM_openInTab(site.visitUrl, { active: true, insert: true });
    showToast('原标签页已关闭，重新打开了一个');
  }, 700);
}

function handleAddSite(rawInput, visitOnly, name = '') {
  const parsed = normalizeSiteInput(rawInput);
  if (!parsed) {
    showToast('地址看起来不对');
    return;
  }

  const sites = getRawSites();
  if (sites.some(site => site.domain === parsed.domain)) {
    showToast(`${parsed.domain} 已经在列表里了`);
    return;
  }

  const trimmedName = String(name || '').replace(/\s+/g, ' ').trim();
  if (trimmedName.length > 40) {
    showToast('名称太长了');
    return;
  }
  sites.push({
    domain: parsed.domain,
    name: trimmedName || parsed.domain,
    // 添加时就填了名称，视为手动指定，不再被自动获取覆盖
    nameLocked: trimmedName !== '' && trimmedName !== parsed.domain,
    enabled: true,
    pageUrl: parsed.pageUrl || '',
    visitOnly: visitOnly === true
  });
  saveRawSites(sites);

  for (const role of ['new-site', 'new-name']) {
    const input = document.querySelector(`#${PANEL_ID} [data-role="${role}"]`);
    if (input) input.value = '';
  }
  const visitBox = document.querySelector(`#${PANEL_ID} [data-role="new-visit"]`);
  if (visitBox) visitBox.checked = false;

  showToast(`已添加 ${parsed.domain}`);
  renderPanel();
}

function handleEditSite(siteId) {
  const site = getSites().find(s => s.siteId === siteId);
  if (!site) return;

  showFormDialog(`编辑「${site.siteName}」`, [
    {
      key: 'name',
      label: '站点名称',
      value: site.siteName,
      placeholder: site.domain,
      hint: '留空则用域名。手动改过之后不会再被自动覆盖。'
    },
    {
      key: 'url',
      label: '签到页地址',
      value: site.visitUrl,
      placeholder: `https://${site.domain}/`,
      hint: '脚本会打开这个地址并在页面上找签到按钮'
    },
    {
      key: 'buttonWords',
      label: '签到按钮文案（可选）',
      value: site.buttonWords.join(', '),
      placeholder: '如 立即签',
      hint: '填了以后只精确匹配这里的文案；多个文案用逗号分隔'
    },
    {
      key: 'resultWords',
      label: '成功结果文案（可选）',
      value: site.resultWords.join(', '),
      placeholder: '如 奖励已发放',
      hint: '结果提示不在通用词表时再填，不会主动发请求'
    },
    {
      key: 'visitOnly',
      label: '仅访问（不用点签到按钮）',
      type: 'checkbox',
      value: site.visitOnly,
      hint: '打开页面就算完成。适合每天访问一次即可的站点。'
    }
  ], {
    onConfirm: ({ name, url, buttonWords, resultWords, visitOnly }) => {
      const edited = buildEditedSite(getRawSites(), site.domain, {
        name, url, buttonWords, resultWords, visitOnly
      });
      if (edited.error) {
        showToast(edited.error);
        return false;
      }
      saveRawSites(edited.sites);
      showToast('已更新');
      renderPanel();
      return true;
    }
  });
}

// 没找到按钮时，把页面上的候选文案列出来让你挑
function handleTeachButtonWords(siteId) {
  const result = getResults()[siteId];
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  const current = getSettings().extraButtonWords;

  const listing = candidates.length
    ? `页面上的可点击文案：\n${candidates.map(t => `  ${t}`).join('\n')}\n\n`
    : '';

  showTextDialog('补充签到按钮文案', current, {
    rows: 3,
    hint: `${listing}把签到按钮的文案填进来（逗号分隔），下次就能识别了`,
    onConfirm: (text) => {
      saveSettings({ extraButtonWords: String(text || '').trim() });
      showToast('已保存，重试看看');
      renderPanel();
      return true;
    }
  });
}

// ===== 导入导出 =====
function buildBackupPayload() {
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    sites: getRawSites().map(site => ({
      domain: site.domain,
      name: site.name || site.domain,
      nameLocked: site.nameLocked === true,
      enabled: site.enabled !== false,
      pageUrl: site.pageUrl || '',
      visitOnly: site.visitOnly === true,
      buttonWords: normalizeConfiguredWords(site.buttonWords),
      resultWords: normalizeConfiguredWords(site.resultWords)
    })),
    settings: getSettings()
  };
}

function parseBackupPayload(text) {
  if (String(text || '').length > 1000000) return { error: '备份文件太大' };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: '不是有效的 JSON' };
  }

  const rawSites = Array.isArray(parsed) ? parsed : parsed?.sites;
  if (!Array.isArray(rawSites)) return { error: '找不到站点列表' };

  const sites = [];
  for (const site of rawSites) {
    const domain = String(site?.domain || '').trim().toLowerCase();
    const domainInput = normalizeSiteInput(domain);
    if (!domainInput || domainInput.domain !== domain) continue;

    const pageInput = site.pageUrl
      ? normalizeSiteInput(site.pageUrl)
      : domainInput;
    if (!pageInput || pageInput.domain !== domain) continue;

    const rawName = String(site.name || domain).replace(/\s+/g, ' ').trim();
    const name = rawName && rawName.length <= 40 ? rawName : domain;
    sites.push({
      domain,
      name,
      // 旧版备份没有这个字段：名称与域名不同就当作手动指定过，
      // 避免导入后又被页面标题覆盖掉
      nameLocked: site.nameLocked === true || (name !== domain && name !== ''),
      enabled: site.enabled !== false,
      pageUrl: pageInput.pageUrl,
      // 兼容旧版扩展导出的 mode 字段
      visitOnly: site.visitOnly === true || site.mode === 'visit',
      buttonWords: normalizeConfiguredWords(site.buttonWords),
      resultWords: normalizeConfiguredWords(site.resultWords)
    });
  }

  const deduped = dedupeSitesByDomain(sites);
  if (deduped.length === 0) return { error: '没有可导入的站点' };
  return {
    sites: deduped,
    settings: isRecord(parsed?.settings) ? sanitizeSettings(parsed.settings) : null
  };
}

function handleExport() {
  showTextDialog('导出配置', JSON.stringify(buildBackupPayload(), null, 2), {
    readOnly: true,
    copyable: true
  });
}

function handleImport() {
  showTextDialog('导入配置', '', {
    hint: '粘贴之前导出的 JSON。扩展版导出的配置也能用。',
    onConfirm: (text) => {
      const parsed = parseBackupPayload(text);
      if (parsed.error) {
        showToast(`导入失败: ${parsed.error}`);
        return false;
      }
      saveRawSites(parsed.sites);
      if (parsed.settings) saveSettings(parsed.settings);
      showToast(`已导入 ${parsed.sites.length} 个站点`);
      renderPanel();
      return true;
    }
  });
}
