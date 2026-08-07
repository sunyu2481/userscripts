// ===== 自定义对话框 =====
// 沿用扩展版约定：不使用原生 confirm / prompt
const DIALOG_ID = 'gm-checkin-dialog';
let activeDialog = null;

function removeDialog(notifyDismiss = true) {
  const dialog = activeDialog;
  activeDialog = null;

  if (!dialog) {
    document.getElementById(DIALOG_ID)?.remove();
    return;
  }

  dialog.overlay.remove();
  document.removeEventListener('keydown', dialog.onEsc);
  if (notifyDismiss) dialog.onDismiss?.();
}

function createDialogShell(title, options = {}) {
  removeDialog();
  injectStyle();

  const overlay = document.createElement('div');
  overlay.id = DIALOG_ID;
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483002;
    background: rgba(0,0,0,.42); display: flex;
    align-items: center; justify-content: center;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    width: min(460px, 92vw); background: #fff; color: #1f2328;
    max-height: 92vh; display: flex; flex-direction: column;
    border-radius: 8px; box-shadow: 0 12px 32px rgba(0,0,0,.24);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
    overflow: hidden;
  `;
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    box.style.background = '#1c2128';
    box.style.color = '#e6edf3';
  }

  box.innerHTML = `
    <div style="padding:12px 14px;background:#667eea;color:#fff;font-weight:600">${escapeHtml(title)}</div>
    <div data-role="content" style="padding:14px;overflow-y:auto"></div>
    <div data-role="footer" style="padding:0 14px 14px;display:flex;gap:8px;justify-content:flex-end"></div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) removeDialog();
  });
  function onEsc(event) {
    if (event.key === 'Escape') {
      removeDialog();
    }
  }
  document.addEventListener('keydown', onEsc);
  activeDialog = { overlay, onEsc, onDismiss: options.onDismiss };

  return {
    overlay,
    content: box.querySelector('[data-role="content"]'),
    footer: box.querySelector('[data-role="footer"]')
  };
}

function makeDialogButton(label, variant = 'default') {
  const button = document.createElement('button');
  button.textContent = label;
  const isPrimary = variant === 'primary';
  const isDanger = variant === 'danger';
  button.style.cssText = `
    padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px;
    border: 1px solid ${isPrimary ? '#667eea' : isDanger ? '#ffccc7' : '#d0d7de'};
    background: ${isPrimary ? '#667eea' : isDanger ? '#fff1f0' : '#f6f8fa'};
    color: ${isPrimary ? '#fff' : isDanger ? '#cf1322' : '#1f2328'};
  `;
  return button;
}

function showConfirm(message) {
  return new Promise((resolve) => {
    let settled = false;
    const { content, footer } = createDialogShell('请确认', {
      onDismiss: () => {
        if (settled) return;
        settled = true;
        resolve(false);
      }
    });
    content.textContent = message;

    function finish(value) {
      if (settled) return;
      settled = true;
      removeDialog(false);
      resolve(value);
    }

    const cancel = makeDialogButton('取消');
    const ok = makeDialogButton('确定', 'danger');

    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));

    footer.append(cancel, ok);
    ok.focus();
  });
}

// 多字段表单对话框。fields: [{ key, label, value, placeholder, hint, type }]
// onConfirm 收到 { [key]: value }，返回 false 表示校验不通过、保持对话框打开
function showFormDialog(title, fields, options = {}) {
  const { content, footer } = createDialogShell(title);
  const inputs = {};

  const isDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;

  for (const field of fields) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:12px';

    // 复选框把标签和控件放在同一行，读起来更像一句话
    if (field.type === 'checkbox') {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = field.value === true;
      input.style.cssText = 'cursor:pointer;flex:none';
      row.appendChild(input);

      const text = document.createElement('span');
      text.textContent = field.label;
      row.appendChild(text);

      wrap.appendChild(row);
      inputs[field.key] = input;

      if (field.hint) {
        const hint = document.createElement('div');
        hint.textContent = field.hint;
        hint.style.cssText = 'margin-top:4px;margin-left:22px;font-size:11px;opacity:.65';
        wrap.appendChild(hint);
      }

      content.appendChild(wrap);
      continue;
    }

    const label = document.createElement('div');
    label.textContent = field.label;
    label.style.cssText = 'margin-bottom:4px;font-size:12px;font-weight:500';
    wrap.appendChild(label);

    const input = document.createElement('input');
    input.type = field.type || 'text';
    input.value = field.value == null ? '' : String(field.value);
    input.placeholder = field.placeholder || '';
    input.style.cssText = `
      width: 100%; padding: 7px 9px; border-radius: 6px;
      border: 1px solid #d0d7de; font-size: 13px;
      background: #fff; color: #1f2328;
    `;
    if (isDark) {
      input.style.background = '#0d1117';
      input.style.borderColor = '#30363d';
      input.style.color = '#e6edf3';
    }
    wrap.appendChild(input);
    inputs[field.key] = input;

    if (field.hint) {
      const hint = document.createElement('div');
      hint.textContent = field.hint;
      hint.style.cssText = 'margin-top:4px;font-size:11px;opacity:.65';
      wrap.appendChild(hint);
    }

    content.appendChild(wrap);
  }

  function collect() {
    const values = {};
    for (const [key, input] of Object.entries(inputs)) {
      values[key] = input.type === 'checkbox' ? input.checked : input.value;
    }
    return values;
  }

  function submit() {
    if (options.onConfirm(collect()) !== false) removeDialog();
  }

  const cancel = makeDialogButton('取消');
  cancel.addEventListener('click', removeDialog);
  const ok = makeDialogButton('保存', 'primary');
  ok.addEventListener('click', submit);
  footer.append(cancel, ok);

  // 回车直接提交，省一次点击
  for (const input of Object.values(inputs)) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
  }

  // 焦点给第一个文本框，复选框不抢焦点
  const firstText = Object.values(inputs).find(input => input.type !== 'checkbox');
  firstText?.focus();
  firstText?.select();
}

function showTextDialog(title, initialText, options = {}) {
  const { content, footer } = createDialogShell(title);

  if (options.hint) {
    const hint = document.createElement('div');
    hint.textContent = options.hint;
    hint.style.cssText = 'margin-bottom:8px;font-size:12px;opacity:.75;white-space:pre-wrap';
    content.appendChild(hint);
  }

  const textarea = document.createElement('textarea');
  textarea.value = initialText || '';
  textarea.placeholder = options.placeholder || '';
  textarea.readOnly = options.readOnly === true;
  const rows = Number(options.rows) || 0;
  const height = rows > 0 ? `${Math.max(48, rows * 22)}px` : '220px';
  textarea.style.cssText = `
    width: 100%; height: ${height}; padding: 8px; border-radius: 6px;
    border: 1px solid #d0d7de; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    resize: vertical; background: ${options.readOnly ? '#f6f8fa' : '#fff'}; color: #1f2328;
  `;
  content.appendChild(textarea);

  const close = makeDialogButton(options.onConfirm ? '取消' : '关闭');
  close.addEventListener('click', removeDialog);
  footer.appendChild(close);

  if (options.copyable) {
    const copy = makeDialogButton('复制', 'primary');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textarea.value);
        showToast('已复制到剪贴板');
      } catch (e) {
        textarea.select();
        showToast('请手动复制（已全选）');
      }
    });
    footer.appendChild(copy);
  }

  if (options.onConfirm) {
    const confirm = makeDialogButton('确定', 'primary');
    confirm.addEventListener('click', () => {
      const accepted = options.onConfirm(textarea.value);
      if (accepted !== false) removeDialog();
    });
    footer.appendChild(confirm);
  }

  textarea.focus();
  if (options.readOnly) textarea.select();
}
