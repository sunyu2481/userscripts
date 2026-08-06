// ===== 浮层 UI =====
const PANEL_ID = 'gm-checkin-panel';
const TOAST_ID = 'gm-checkin-toast';
const STYLE_ID = 'gm-checkin-style';

const PANEL_CSS = `
#${PANEL_ID} {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 320px; max-height: 70vh; overflow: hidden;
  display: flex; flex-direction: column;
  background: #fff; color: #1f2328;
  border: 1px solid #d0d7de; border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,.16);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
#${PANEL_ID} * { box-sizing: border-box; }
#${PANEL_ID} .gm-hd {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; background: #667eea; color: #fff;
  cursor: move; user-select: none;
}
#${PANEL_ID} .gm-hd b { font-size: 13px; font-weight: 600; flex: 1; }
#${PANEL_ID} .gm-hd button {
  background: rgba(255,255,255,.18); color: #fff; border: 0;
  border-radius: 4px; padding: 2px 7px; cursor: pointer; font-size: 12px;
}
#${PANEL_ID} .gm-hd button:hover { background: rgba(255,255,255,.32); }
#${PANEL_ID} .gm-bd { padding: 10px 12px; overflow-y: auto; flex: 1; }
#${PANEL_ID} .gm-actions { display: flex; gap: 6px; margin-bottom: 10px; }
#${PANEL_ID} .gm-btn {
  flex: 1; padding: 7px 8px; border-radius: 6px; border: 1px solid #d0d7de;
  background: #f6f8fa; cursor: pointer; font-size: 12px; color: #1f2328;
}
#${PANEL_ID} .gm-btn:hover:not(:disabled) { background: #eef1f4; }
#${PANEL_ID} .gm-btn:disabled { opacity: .5; cursor: not-allowed; }
#${PANEL_ID} .gm-btn.primary {
  background: #667eea; border-color: #667eea; color: #fff; font-weight: 500;
}
#${PANEL_ID} .gm-btn.primary:hover:not(:disabled) { background: #5a6fd8; }
#${PANEL_ID} .gm-btn.danger { background: #fff1f0; border-color: #ffccc7; color: #cf1322; }
#${PANEL_ID} .gm-progress {
  margin-bottom: 8px; padding: 6px 8px; border-radius: 6px;
  background: #eef2ff; color: #3730a3; font-size: 12px;
}
#${PANEL_ID} .gm-site {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 0; border-bottom: 1px solid #f0f2f4;
}
#${PANEL_ID} .gm-site:last-child { border-bottom: 0; }
#${PANEL_ID} .gm-site input[type="checkbox"] { cursor: pointer; flex: none; }
#${PANEL_ID} .gm-site .gm-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: pointer; color: #0969da;
}
#${PANEL_ID} .gm-site .gm-name:hover { text-decoration: underline; }
#${PANEL_ID} .gm-site .gm-name.off { color: #8c959f; }
#${PANEL_ID} .gm-badge {
  flex: none; padding: 1px 6px; border-radius: 10px; font-size: 11px; white-space: nowrap;
}
#${PANEL_ID} .gm-badge.success { background: #dafbe1; color: #1a7f37; }
#${PANEL_ID} .gm-badge.already { background: #ddf4ff; color: #0969da; }
#${PANEL_ID} .gm-badge.failed { background: #ffebe9; color: #cf222e; }
#${PANEL_ID} .gm-badge.invalid { background: #fff1e5; color: #bc4c00; }
#${PANEL_ID} .gm-badge.checking { background: #fff8c5; color: #7d4e00; }
#${PANEL_ID} .gm-mode {
  flex: none; padding: 1px 5px; border-radius: 3px; font-size: 10px;
  background: #f0f2f4; color: #57606a; white-space: nowrap;
}
#${PANEL_ID} .gm-del {
  flex: none; border: 0; background: transparent; color: #8c959f;
  cursor: pointer; font-size: 14px; padding: 0 2px; line-height: 1;
}
#${PANEL_ID} .gm-del:hover { color: #cf222e; }
#${PANEL_ID} .gm-msg {
  font-size: 11px; color: #57606a; padding: 0 0 6px 24px;
  word-break: break-all; border-bottom: 1px solid #f0f2f4;
}
#${PANEL_ID} .gm-empty { color: #8c959f; text-align: center; padding: 18px 0; }
#${PANEL_ID} .gm-row { display: flex; gap: 6px; margin-bottom: 8px; }
#${PANEL_ID} .gm-row input[type="text"] {
  flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid #d0d7de;
  border-radius: 6px; font-size: 12px; color: #1f2328; background: #fff;
}
#${PANEL_ID} .gm-row label {
  display: flex; align-items: center; gap: 4px; font-size: 12px;
  color: #57606a; white-space: nowrap;
}
#${PANEL_ID} .gm-sec {
  margin-top: 10px; padding-top: 8px; border-top: 1px solid #f0f2f4;
  font-size: 12px; color: #57606a;
}
#${PANEL_ID} .gm-sec-hd {
  font-weight: 600; color: #1f2328; margin-bottom: 6px;
  cursor: pointer; user-select: none;
}
#${PANEL_ID} .gm-gap { display: flex; align-items: center; gap: 6px; }
#${PANEL_ID} .gm-gap input[type="number"] {
  width: 58px; padding: 4px 6px; border: 1px solid #d0d7de;
  border-radius: 4px; font-size: 12px; color: #1f2328; background: #fff;
}
#${PANEL_ID}.collapsed .gm-bd { display: none; }
#${TOAST_ID} {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483001;
  max-width: 320px; padding: 10px 14px; border-radius: 8px;
  background: rgba(31,35,40,.94); color: #fff;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  box-shadow: 0 6px 18px rgba(0,0,0,.22);
}
@media (prefers-color-scheme: dark) {
  #${PANEL_ID} { background: #1c2128; color: #e6edf3; border-color: #30363d; }
  #${PANEL_ID} .gm-btn { background: #21262d; border-color: #30363d; color: #e6edf3; }
  #${PANEL_ID} .gm-btn:hover:not(:disabled) { background: #30363d; }
  #${PANEL_ID} .gm-progress { background: #1f2b4d; color: #a5b4fc; }
  #${PANEL_ID} .gm-site, #${PANEL_ID} .gm-msg { border-color: #21262d; }
  #${PANEL_ID} .gm-sec, #${PANEL_ID} .gm-sec { border-color: #21262d; }
  #${PANEL_ID} .gm-row input[type="text"],
  #${PANEL_ID} .gm-gap input[type="number"] {
    background: #0d1117; border-color: #30363d; color: #e6edf3;
  }
  #${PANEL_ID} .gm-mode { background: #21262d; color: #8b949e; }
}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  (document.head || document.documentElement).appendChild(style);
}

let toastTimer = null;

function showToast(message, duration = 3200) {
  injectStyle();
  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.cursor = 'default';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), duration);
}

// 需要你处理时用这个：不自动消失，点一下才关。
// 比定时消失的提示可靠——你可能过一会儿才切过来看。
function showStickyNotice(message) {
  injectStyle();
  document.getElementById(TOAST_ID)?.remove();
  if (toastTimer) clearTimeout(toastTimer);

  const notice = document.createElement('div');
  notice.id = TOAST_ID;
  notice.style.cssText = 'cursor:pointer;max-width:360px;background:rgba(191,54,12,.96)';
  notice.textContent = `${message}（点此关闭）`;
  notice.addEventListener('click', () => notice.remove());
  document.body.appendChild(notice);
}
