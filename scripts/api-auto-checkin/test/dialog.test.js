const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');

class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.document = document;
    this.children = [];
    this.listeners = new Map();
    this.roles = new Map();
    this.style = {};
    this.parentElement = null;
    this.id = '';
  }

  set innerHTML(value) {
    this.html = value;
    for (const role of ['content', 'footer']) {
      if (!value.includes(`data-role="${role}"`)) continue;
      const child = new FakeElement('div', this.document);
      child.parentElement = this;
      this.roles.set(role, child);
    }
  }

  querySelector(selector) {
    const match = selector.match(/^\[data-role="([^"]+)"\]$/);
    return match ? this.roles.get(match[1]) || null : null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) || [];
    callbacks.push(callback);
    this.listeners.set(name, callbacks);
  }

  dispatch(name, event = {}) {
    for (const callback of this.listeners.get(name) || []) callback({ target: this, ...event });
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }

  focus() {}
}

function setupDialog() {
  const documentListeners = new Map();
  const document = {
    body: null,
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    getElementById(id) {
      function find(node) {
        if (node.id === id) return node;
        for (const child of node.children) {
          const found = find(child);
          if (found) return found;
        }
        return null;
      }
      return find(document.body);
    },
    addEventListener(name, callback) {
      const callbacks = documentListeners.get(name) || new Set();
      callbacks.add(callback);
      documentListeners.set(name, callbacks);
    },
    removeEventListener(name, callback) {
      documentListeners.get(name)?.delete(callback);
    }
  };
  document.body = new FakeElement('body', document);

  const source = fs.readFileSync(path.join(srcDir, '73-ui-dialog.js'), 'utf8');
  const module = new Function('document', 'window', 'injectStyle', 'escapeHtml', `
    ${source}
    return { showConfirm, createDialogShell, removeDialog, DIALOG_ID };
  `)(
    document,
    { matchMedia: () => ({ matches: false }) },
    () => {},
    text => String(text)
  );

  return {
    document,
    module,
    fireKey(key) {
      for (const callback of [...(documentListeners.get('keydown') || [])]) callback({ key });
    },
    get keydownListenerCount() {
      return documentListeners.get('keydown')?.size || 0;
    }
  };
}

test('Esc 关闭确认框时会返回取消并清理监听', async () => {
  const ctx = setupDialog();
  const result = ctx.module.showConfirm('确认删除？');
  assert.equal(ctx.keydownListenerCount, 1);

  ctx.fireKey('Escape');
  assert.equal(await result, false);
  assert.equal(ctx.keydownListenerCount, 0);
  assert.equal(ctx.document.getElementById(ctx.module.DIALOG_ID), null);
});

test('点击遮罩会返回取消', async () => {
  const ctx = setupDialog();
  const result = ctx.module.showConfirm('确认删除？');
  const overlay = ctx.document.getElementById(ctx.module.DIALOG_ID);
  overlay.dispatch('click');
  assert.equal(await result, false);
  assert.equal(ctx.keydownListenerCount, 0);
});

test('确认按钮返回 true 且不会遗留键盘监听', async () => {
  const ctx = setupDialog();
  const result = ctx.module.showConfirm('确认删除？');
  const overlay = ctx.document.getElementById(ctx.module.DIALOG_ID);
  const footer = overlay.children[0].querySelector('[data-role="footer"]');
  footer.children[1].dispatch('click');

  assert.equal(await result, true);
  assert.equal(ctx.keydownListenerCount, 0);
});

test('重复打开对话框只保留一个键盘监听', () => {
  const ctx = setupDialog();
  ctx.module.createDialogShell('第一个');
  ctx.module.createDialogShell('第二个');
  assert.equal(ctx.keydownListenerCount, 1);
  ctx.module.removeDialog();
  assert.equal(ctx.keydownListenerCount, 0);
});
