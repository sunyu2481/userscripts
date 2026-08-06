const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');

// 只加载聚焦相关的纯逻辑
function loadFocusHelpers() {
  const source = fs.readFileSync(path.join(srcDir, '52-focus.js'), 'utf8');
  return new Function('window', 'document', 'GM_addValueChangeListener',
                      'readFocusRequest', 'clearFocusRequest', 'KEY_FOCUS',
                      'setInterval', 'clearInterval', 'console', `
    ${source}
    return { isFocusRequestForMe, focusSelf, watchFocusRequests, FOCUS_REQUEST_TTL_MS };
  `);
}

function setup({ focusThrows = false, pending = null } = {}) {
  let focused = 0;
  let cleared = 0;
  let listener = null;

  const window = {
    focus: () => {
      focused++;
      if (focusThrows) throw new Error('被浏览器拦下');
    }
  };
  const document = { title: '原标题' };

  const M = loadFocusHelpers()(
    window,
    document,
    (key, cb) => { listener = cb; return 1; },
    () => pending,
    () => { cleared++; },
    'focusRequest',
    () => 0,          // setInterval 不真的跑，避免测试悬挂
    () => {},
    console
  );

  return {
    M,
    get focused() { return focused; },
    get cleared() { return cleared; },
    fire: (value, remote = true) => listener?.('focusRequest', null, JSON.stringify(value), remote),
    hasListener: () => listener !== null
  };
}

test('域名匹配且请求新鲜时响应', () => {
  const { M } = setup();
  const now = 1_000_000;
  assert.equal(M.isFocusRequestForMe({ domain: 'a.com', at: now }, 'a.com', now), true);
  assert.equal(M.isFocusRequestForMe({ domain: 'a.com', at: now }, 'a.com', now + 5000), true);
});

test('域名不匹配不响应', () => {
  const { M } = setup();
  const now = 1_000_000;
  assert.equal(M.isFocusRequestForMe({ domain: 'a.com', at: now }, 'b.com', now), false);
});

test('过期请求不响应', () => {
  const { M } = setup();
  const now = 1_000_000;
  const stale = { domain: 'a.com', at: now };
  assert.equal(M.isFocusRequestForMe(stale, 'a.com', now + M.FOCUS_REQUEST_TTL_MS + 1), false);
});

test('空请求或缺字段不响应', () => {
  const { M } = setup();
  assert.equal(M.isFocusRequestForMe(null, 'a.com'), false);
  assert.equal(M.isFocusRequestForMe({}, 'a.com'), false);
  assert.equal(M.isFocusRequestForMe({ domain: 'a.com' }, 'a.com'), false);
});

test('装监听时先处理已存在的请求', () => {
  // 面板点击后目标页可能刚好在加载，监听还没装上
  const ctx = setup({ pending: { domain: 'a.com', at: Date.now() } });
  ctx.M.watchFocusRequests('a.com');
  assert.equal(ctx.focused, 1, '应该立刻聚焦');
  assert.equal(ctx.cleared, 1, '应该清掉请求表示已响应');
});

test('已存在的请求不是给自己的就不动', () => {
  const ctx = setup({ pending: { domain: 'other.com', at: Date.now() } });
  ctx.M.watchFocusRequests('a.com');
  assert.equal(ctx.focused, 0);
  assert.equal(ctx.cleared, 0);
});

test('收到远程请求时聚焦并清掉请求', () => {
  const ctx = setup();
  ctx.M.watchFocusRequests('a.com');
  assert.ok(ctx.hasListener());

  ctx.fire({ domain: 'a.com', at: Date.now() });
  assert.equal(ctx.focused, 1);
  assert.equal(ctx.cleared, 1, '清掉请求让协调者知道已被响应');
});

test('本地写入不触发聚焦', () => {
  const ctx = setup();
  ctx.M.watchFocusRequests('a.com');
  ctx.fire({ domain: 'a.com', at: Date.now() }, false);
  assert.equal(ctx.focused, 0, 'remote 为 false 时不该响应');
});

test('别的站点的请求不触发聚焦', () => {
  const ctx = setup();
  ctx.M.watchFocusRequests('a.com');
  ctx.fire({ domain: 'other.com', at: Date.now() });
  assert.equal(ctx.focused, 0);
  assert.equal(ctx.cleared, 0, '不该清掉别人的请求');
});

test('坏数据不炸', () => {
  const ctx = setup();
  ctx.M.watchFocusRequests('a.com');
  assert.doesNotThrow(() => ctx.fire('不是 JSON'));
  assert.equal(ctx.focused, 0);
});

test('window.focus 被拦时不抛异常', () => {
  const ctx = setup({ focusThrows: true });
  assert.doesNotThrow(() => ctx.M.focusSelf());
});
