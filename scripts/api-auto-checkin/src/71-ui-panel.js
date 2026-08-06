// ===== 面板渲染 =====
let panelVisible = false;
let settingsExpanded = false;

const STATUS_LABEL = {
  success: '成功',
  already: '已签',
  failed: '失败',
  invalid: '失效',
  unknown: '待确认',
  checking: '签到中'
};

function ensurePanel() {
  injectStyle();
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="gm-hd">
      <b>签到助手</b>
      <button data-act="collapse" title="折叠">−</button>
      <button data-act="hide" title="隐藏">×</button>
    </div>
    <div class="gm-bd"></div>
  `;
  document.body.appendChild(panel);

  panel.querySelector('[data-act="hide"]').addEventListener('click', () => togglePanel(false));
  panel.querySelector('[data-act="collapse"]').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });

  makeDraggable(panel, panel.querySelector('.gm-hd'));
  return panel;
}

function makeDraggable(panel, handle) {
  let startX = 0, startY = 0, originLeft = 0, originTop = 0, dragging = false;

  handle.addEventListener('mousedown', (event) => {
    if (event.target.tagName === 'BUTTON') return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    startX = event.clientX;
    startY = event.clientY;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${originLeft}px`;
    panel.style.top = `${originTop}px`;
    event.preventDefault();
  });

  document.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, originLeft + event.clientX - startX))}px`;
    panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, originTop + event.clientY - startY))}px`;
  });

  document.addEventListener('mouseup', () => { dragging = false; });
}

function togglePanel(visible) {
  panelVisible = visible === undefined ? !panelVisible : visible;
  if (!panelVisible) {
    document.getElementById(PANEL_ID)?.remove();
    return;
  }
  renderPanel();
}

function renderPanel() {
  if (!panelVisible) return;
  const panel = ensurePanel();
  const body = panel.querySelector('.gm-bd');
  const sites = getSites();
  const results = getResults();
  const runState = getRunState();
  const running = runState.running === true;
  const enabledCount = sites.filter(s => s.enabled).length;

  const parts = [];

  if (running) {
    const current = sites.find(s => s.siteId === runState.currentSiteId);
    parts.push(`<div class="gm-progress">进度 ${runState.current || 0}/${runState.total || 0}${
      current ? ` · ${escapeHtml(current.siteName)}` : ''
    }</div>`);
  }

  const openedTabCount = getOpenedTabCount();
  parts.push(`
    <div class="gm-actions">
      <button class="gm-btn primary" data-act="start" ${running || enabledCount === 0 ? 'disabled' : ''}>
        ${running ? '签到中...' : '开始签到'}
      </button>
      ${running ? '<button class="gm-btn danger" data-act="abort">终止</button>' : ''}
      ${!running && openedTabCount > 0
        ? `<button class="gm-btn" data-act="close-tabs">关闭 ${openedTabCount} 个标签页</button>`
        : ''}
    </div>
    <div class="gm-row">
      <input type="text" data-role="new-site" placeholder="签到页地址，如 c.com/#/checkin">
    </div>
    <div class="gm-row">
      <input type="text" data-role="new-name" placeholder="站点名称（可留空）" style="flex:1">
      <label title="只打开页面，不找按钮"><input type="checkbox" data-role="new-visit">仅访问</label>
      <button class="gm-btn" data-act="add" style="flex:none;width:46px">添加</button>
    </div>
  `);

  if (sites.length === 0) {
    parts.push('<div class="gm-empty">先添加一个站点的签到页地址</div>');
  } else {
    for (const site of sites) {
      const result = results[site.siteId];
      const status = result?.status;
      const badge = status ? `<span class="gm-badge ${status}">${STATUS_LABEL[status] || status}</span>` : '';

      parts.push(`
        <div class="gm-site" data-site="${escapeHtml(site.siteId)}">
          <input type="checkbox" data-act="toggle" ${site.enabled ? 'checked' : ''} title="启用/禁用">
          <span class="gm-name ${site.enabled ? '' : 'off'}" data-act="open" title="${escapeHtml(site.visitUrl)}">
            ${escapeHtml(site.siteName)}
          </span>
          ${site.visitOnly ? '<span class="gm-mode" title="仅访问，不点按钮">仅访问</span>' : ''}
          ${badge}
          <button class="gm-del" data-act="retry" title="只签这个">↻</button>
          <button class="gm-del" data-act="edit" title="改名称和地址">✎</button>
          <button class="gm-del" data-act="remove" title="删除">×</button>
        </div>
      `);

      // 需要你处理或没成功的情况才展开说明
      if (result?.message && status !== 'success' && status !== 'already' && status !== 'checking') {
        const hint = result.hint ? `<br><span style="opacity:.75">${escapeHtml(result.hint)}</span>` : '';
        const action = buildResultAction(result);
        parts.push(`<div class="gm-msg">${escapeHtml(result.message)}${hint}${action}</div>`);
      }
    }
  }

  const settings = getSettings();
  parts.push(`
    <div class="gm-sec">
      <div class="gm-sec-hd" data-act="toggle-settings">${settingsExpanded ? '▾' : '▸'} 设置与备份</div>
      ${settingsExpanded ? `
        <div class="gm-gap" style="margin-bottom:8px">
          站点间隔
          <input type="number" data-role="gap-min" value="${Math.round(settings.gapMinMs / 1000)}" min="0" max="600"> -
          <input type="number" data-role="gap-max" value="${Math.round(settings.gapMaxMs / 1000)}" min="0" max="600"> 秒
        </div>
        <div style="margin-bottom:8px">
          <div style="margin-bottom:4px">补充签到按钮文案（逗号分隔）</div>
          <input type="text" data-role="extra-words" value="${escapeHtml(settings.extraButtonWords)}"
                 placeholder="如 每日礼包, 点我领取" style="width:100%">
        </div>
        <label style="display:flex;gap:5px;align-items:center;margin-bottom:4px">
          <input type="checkbox" data-role="auto-close" ${settings.autoCloseTab ? 'checked' : ''}>
          签完自动关闭标签页
        </label>
        <div style="margin:0 0 8px 20px;font-size:11px;opacity:.65">
          默认留着，方便核对结果。需要你处理的标签页始终保留。
        </div>
        <div class="gm-actions">
          <button class="gm-btn" data-act="export">导出</button>
          <button class="gm-btn" data-act="import">导入</button>
        </div>
      ` : ''}
    </div>
  `);

  body.innerHTML = parts.join('');
  bindPanelEvents(panel, body);
}

// 失败结果给一个可操作的出口
function buildResultAction(result) {
  if (result.needsHuman) {
    return '<br><a href="#" data-act="focus-tab" style="color:#0969da">切到那个标签页完成验证 →</a>';
  }
  if (result.needsLogin) {
    return '<br><a href="#" data-act="focus-tab" style="color:#0969da">切到那个标签页登录 →</a>';
  }
  if (Array.isArray(result.candidates) && result.candidates.length > 0) {
    return '<br><a href="#" data-act="teach" style="color:#0969da">按钮文案不对？点这里补充 →</a>';
  }
  return '';
}

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
