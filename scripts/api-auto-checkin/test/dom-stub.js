// 轻量 DOM stub：只实现按钮识别用到的那部分，不引入外部依赖。
// 用 { tag, text, attrs, children } 的树描述页面。

class El {
  constructor(spec, parent = null) {
    this.tagName = String(spec.tag || 'div').toUpperCase();
    this.ownText = spec.text || '';
    this.attrs = { ...(spec.attrs || {}) };
    this.parentElement = parent;
    this.children = (spec.children || []).map(child => new El(child, this));
    this.clicked = 0;
    this.events = [];

    this.disabled = spec.disabled === true;
    this.value = spec.value;
    this._style = {
      visibility: 'visible',
      display: 'block',
      opacity: '1',
      pointerEvents: 'auto',
      cursor: 'pointer',
      ...(spec.style || {})
    };
    this._rect = spec.hidden
      ? { width: 0, height: 0, left: 0, top: 0 }
      : { width: 80, height: 30, left: 10, top: 10, ...(spec.rect || {}) };

    this.classList = {
      contains: (name) => String(this.attrs.class || '').split(/\s+/).includes(name)
    };
  }

  // innerText 包含后代文本，与浏览器一致
  get innerText() {
    const own = this.ownText;
    const kids = this.children.map(c => c.innerText).filter(Boolean).join(' ');
    return [own, kids].filter(Boolean).join(' ');
  }

  get textContent() {
    return this.innerText;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  getBoundingClientRect() {
    return this._rect;
  }

  scrollIntoView() { /* 测试里无需实现 */ }

  click() {
    this.clicked++;
  }

  dispatchEvent(event) {
    this.events.push(event?.type || 'unknown');
    return true;
  }

  addEventListener() { /* 测试里无需实现 */ }

  // 只支持测试用到的选择器语法
  matches(selector) {
    return selector.split(',').some(part => matchesSingle(this, part.trim()));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    walk(this, (node) => {
      if (node !== this && node.matches(selector)) out.push(node);
    });
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  get id() {
    return this.attrs.id || '';
  }
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

// 支持 tag、[attr]、[attr="v"]、[attr*="v" i]、.class、#id、:not(...)
function matchesSingle(el, selector) {
  if (!selector) return false;

  // 先摘掉 :not(...)
  const notMatch = selector.match(/^(.*?):not\(([^)]*)\)$/);
  if (notMatch) {
    const [, base, negated] = notMatch;
    if (base && !matchesSingle(el, base)) return false;
    return !matchesSingle(el, negated);
  }

  let rest = selector;

  // 标签名
  const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/);
  if (tagMatch) {
    if (el.tagName !== tagMatch[1].toUpperCase()) return false;
    rest = rest.slice(tagMatch[1].length);
  }

  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      const m = rest.match(/^\.([\w-]+)/);
      if (!m || !el.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
      continue;
    }
    if (rest.startsWith('#')) {
      const m = rest.match(/^#([\w-]+)/);
      if (!m || el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
      continue;
    }
    if (rest.startsWith('[')) {
      const m = rest.match(/^\[([\w-]+)(?:([*^$~|]?=)"([^"]*)")?(\s+i)?\]/);
      if (!m) return false;
      const [, name, op, expected, ci] = m;
      const actual = el.getAttribute(name);
      if (actual === null) return false;
      if (op) {
        const a = ci ? String(actual).toLowerCase() : String(actual);
        const b = ci ? String(expected).toLowerCase() : String(expected);
        if (op === '=' && a !== b) return false;
        if (op === '*=' && !a.includes(b)) return false;
        if (op === '^=' && !a.startsWith(b)) return false;
        if (op === '$=' && !a.endsWith(b)) return false;
      }
      rest = rest.slice(m[0].length);
      continue;
    }
    return false;
  }
  return true;
}

// 从描述树建一个可用的 document / window / location
function buildDom(spec, { url = 'https://site.example.com/checkin', title = '测试站点' } = {}) {
  const body = new El({ tag: 'body', children: Array.isArray(spec) ? spec : [spec] });
  const root = new El({ tag: 'html', children: [] });
  root.children = [body];
  body.parentElement = root;

  const document = {
    readyState: 'complete',
    title,
    body,
    documentElement: root,
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    querySelector: (selector) => body.querySelector(selector),
    getElementById: (id) => body.querySelectorAll(`#${id}`)[0] || null,
    addEventListener: () => {},
    createElement: (tag) => new El({ tag })
  };

  const window = {
    getComputedStyle: (el) => el._style || { visibility: 'visible', display: 'block', opacity: '1' },
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false })
  };

  const parsed = new URL(url);
  const location = {
    href: parsed.href,
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    origin: parsed.origin
  };

  return { document, window, location, body };
}

module.exports = { El, buildDom };
