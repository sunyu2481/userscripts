const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');
const { buildDom } = require('./dom-stub.js');

// 造一个能记录事件类型的 Event 构造器
function makeEventCtor(name) {
  return class {
    constructor(type, init) {
      this.type = type;
      this.name = name;
      Object.assign(this, init || {});
    }
  };
}

function setup({ withPointerEvent = true, clickThrows = false } = {}) {
  const dom = buildDom([{ tag: 'button', text: '签到' }]);
  dom.window.MouseEvent = makeEventCtor('MouseEvent');
  if (withPointerEvent) dom.window.PointerEvent = makeEventCtor('PointerEvent');

  const source = fs.readFileSync(path.join(srcDir, '40-checkin.js'), 'utf8');
  const M = new Function('document', 'window', 'location', 'URL', 'setTimeout', 'console', `
    ${source}
    return { clickElement, dispatchQuietly };
  `)(dom.document, dom.window, dom.location, URL, setTimeout, console);

  const button = dom.body.querySelector('button');
  if (clickThrows) {
    button.click = () => { throw new Error('click 被拦截'); };
  }
  return { M, button, dom };
}

test('点击派发完整的事件序列', () => {
  const { M, button } = setup();
  assert.equal(M.clickElement(button), true);
  assert.deepEqual(button.events, ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
  assert.equal(button.clicked, 1);
});

test('没有 PointerEvent 时鼠标事件照旧派发', () => {
  // 老浏览器或受限环境里 PointerEvent 可能不存在，
  // 不该因此跳过 mousedown/mouseup —— 很多框架只监听这两个
  const { M, button } = setup({ withPointerEvent: false });
  assert.equal(M.clickElement(button), true);
  assert.deepEqual(button.events, ['mousedown', 'mouseup']);
  assert.equal(button.clicked, 1);
});

test('事件带上中心点坐标', () => {
  const dom = buildDom([{ tag: 'button', text: '签到', rect: { left: 100, top: 50, width: 80, height: 30 } }]);
  dom.window.MouseEvent = makeEventCtor('MouseEvent');
  dom.window.PointerEvent = makeEventCtor('PointerEvent');

  const source = fs.readFileSync(path.join(srcDir, '40-checkin.js'), 'utf8');
  const M = new Function('document', 'window', 'location', 'URL', 'setTimeout', 'console',
    `${source}\nreturn { clickElement };`
  )(dom.document, dom.window, dom.location, URL, setTimeout, console);

  const button = dom.body.querySelector('button');
  const dispatched = [];
  button.dispatchEvent = (event) => { dispatched.push(event); return true; };

  M.clickElement(button);
  assert.ok(dispatched.length > 0);
  // 中心点 = left + width/2, top + height/2
  assert.equal(dispatched[0].clientX, 140);
  assert.equal(dispatched[0].clientY, 65);
});

test('click 抛异常时返回失败', () => {
  const { M, button } = setup({ clickThrows: true });
  assert.equal(M.clickElement(button), false);
  // 前面的事件仍然派发过了
  assert.ok(button.events.length > 0);
});

test('dispatchQuietly 遇到不存在的构造器不炸', () => {
  const { M, button } = setup();
  assert.equal(M.dispatchQuietly(button, 'NoSuchEvent', 'foo', {}), false);
  assert.equal(M.dispatchQuietly(button, 'MouseEvent', 'mousedown', {}), true);
});

test('仅访问模式落在登录页时报需要登录', async () => {
  const dom = buildDom([
    { tag: 'input', attrs: { type: 'password' } },
    { tag: 'button', text: '登录' }
  ], { url: 'https://a.com/login' });
  dom.window.MouseEvent = makeEventCtor('MouseEvent');

  const source = ['20-site.js', '30-detect.js', '31-guards.js', '41-verdict.js', '40-checkin.js']
    .map(n => fs.readFileSync(path.join(srcDir, n), 'utf8')).join('\n');

  const M = new Function('document', 'window', 'location', 'URL', 'setTimeout', 'console', 'getSettings', `
    ${source}
    return { checkInOnThisPage };
  `)(dom.document, dom.window, dom.location, URL, setTimeout, console, () => ({ extraButtonWords: '' }));

  const result = await M.checkInOnThisPage({ visitOnly: true, visitUrl: 'https://a.com/' });
  assert.equal(result.status, 'failed');
  assert.equal(result.needsLogin, true);
});

test('仅访问模式正常页面直接算成功', async () => {
  const dom = buildDom([
    { tag: 'div', text: '欢迎回来，今天已经为你续期' }
  ], { url: 'https://a.com/dashboard' });
  dom.window.MouseEvent = makeEventCtor('MouseEvent');

  const source = ['20-site.js', '30-detect.js', '31-guards.js', '41-verdict.js', '40-checkin.js']
    .map(n => fs.readFileSync(path.join(srcDir, n), 'utf8')).join('\n');

  const M = new Function('document', 'window', 'location', 'URL', 'setTimeout', 'console', 'getSettings', `
    ${source}
    return { checkInOnThisPage };
  `)(dom.document, dom.window, dom.location, URL, setTimeout, console, () => ({ extraButtonWords: '' }));

  const result = await M.checkInOnThisPage({ visitOnly: true, visitUrl: 'https://a.com/dashboard' });
  assert.equal(result.status, 'success');
  assert.match(result.message, /已访问/);
});

test('自定义按钮暂时禁用且页面有静态已签到文字时不误判已签', async () => {
  const dom = buildDom([
    { tag: 'div', text: '今日已签到' },
    { tag: 'button', text: '立即签', disabled: true }
  ], { url: 'https://a.com/checkin' });

  let source = ['20-site.js', '30-detect.js', '31-guards.js', '41-verdict.js', '40-checkin.js']
    .map(n => fs.readFileSync(path.join(srcDir, n), 'utf8')).join('\n');
  source = source
    .replace('const WAIT_BUTTON_TIMEOUT_MS = 20000;', 'const WAIT_BUTTON_TIMEOUT_MS = 5;')
    .replace('const POLL_MS = 400;', 'const POLL_MS = 1;')
    .replace('await sleep(1200);', 'await sleep(0);');

  const M = new Function('document', 'window', 'location', 'URL', 'setTimeout', 'console', 'getSettings', `
    ${source}
    return { checkInOnThisPage };
  `)(dom.document, dom.window, dom.location, URL, setTimeout, console, () => ({ extraButtonWords: '' }));

  const result = await M.checkInOnThisPage({
    visitOnly: false,
    visitUrl: 'https://a.com/checkin',
    buttonWords: ['立即签'],
    resultWords: []
  });
  assert.equal(result.status, 'unknown');
  assert.match(result.message, /无法确认是否已签到/);
});

test('元素不支持 scrollIntoView 也能点', () => {
  const { M, button } = setup();
  button.scrollIntoView = () => { throw new Error('不支持'); };
  assert.equal(M.clickElement(button), true);
  assert.equal(button.clicked, 1);
});

// 用可推进的时钟跑完整签到流程，不必让回归用例真实等待 20 秒。
function setupCheckIn(spec, onSleep = () => {}) {
  const dom = buildDom(spec, { url: 'https://a.com/checkin' });
  let now = 1000000;
  class TestDate extends Date {
    static now() { return now; }
  }
  const source = ['20-site.js', '30-detect.js', '31-guards.js', '41-verdict.js', '40-checkin.js']
    .map(name => fs.readFileSync(path.join(srcDir, name), 'utf8')).join('\n');
  const globals = {
    document: dom.document, window: dom.window, location: dom.location, URL,
    Date: TestDate,
    setTimeout: (callback, ms) => {
      now += ms;
      onSleep(ms);
      queueMicrotask(callback);
    },
    getSettings: () => ({ extraButtonWords: '' })
  };
  const M = new Function(...Object.keys(globals), `
    ${source}
    return { checkInOnThisPage, capture: response => capturedResponses.push(response) };
  `)(...Object.values(globals));
  return { ...dom, M, get elapsed() { return now - 1000000; } };
}

const checkInSite = { visitUrl: 'https://a.com/checkin', buttonWords: [], resultWords: [] };

test('登录返回后已经手动签到时采信明确反馈，不再点击', async () => {
  const ctx = setupCheckIn([
    { tag: 'button', text: '签到' },
    { tag: 'div', attrs: { role: 'alert' }, text: '签到成功' }
  ]);
  const result = await ctx.M.checkInOnThisPage(checkInSite, { resumed: true });
  assert.equal(result.status, 'success');
  assert.equal(ctx.body.querySelector('button').clicked, 0);
});

test('跳转接续先读手动签到的响应，不会把它清掉再点击', async () => {
  const ctx = setupCheckIn([{ tag: 'button', text: '签到' }]);
  ctx.M.capture({ isCheckInish: true, status: 200, text: JSON.stringify({ success: true, message: '签到成功' }) });
  const result = await ctx.M.checkInOnThisPage(checkInSite, { resumed: true });
  assert.equal(result.status, 'success');
  assert.equal(ctx.body.querySelector('button').clicked, 0);
});

test('已点击的任务刷新后只读结果，按钮仍可用也不重复点击', async () => {
  for (const hasFeedback of [true, false]) {
    const ctx = setupCheckIn([
      { tag: 'button', text: '签到' },
      ...(hasFeedback ? [{ tag: 'div', attrs: { role: 'alert' }, text: '签到成功' }] : [])
    ]);
    const result = await ctx.M.checkInOnThisPage(checkInSite, {
      resumed: true,
      previousClick: { clickedText: '签到', initialAlreadyTexts: [], initialToastTexts: [] }
    });
    assert.equal(result.status, hasFeedback ? 'success' : 'unknown');
    assert.equal(ctx.body.querySelector('button').clicked, 0);
  }
});

test('点击后转到登录页会及时报告需要登录', async () => {
  const ctx = setupCheckIn([{ tag: 'button', text: '签到' }]);
  const button = ctx.body.querySelector('button');
  button.click = () => {
    button.clicked++;
    button.ownText = '登录';
    ctx.location.pathname = '/login';
  };
  const result = await ctx.M.checkInOnThisPage(checkInSite);
  assert.equal(result.needsLogin, true);
  assert.equal(button.clicked, 1);
  assert.ok(ctx.elapsed < 3000, '不应等完整结果超时');
});

test('等待渲染期间任务已手动结束就停止，不再点击', async () => {
  let active = true;
  const ctx = setupCheckIn([{ tag: 'button', text: '签到' }], () => { active = false; });
  const result = await ctx.M.checkInOnThisPage(checkInSite, { isActive: () => active });
  assert.equal(result, null);
  assert.equal(ctx.body.querySelector('button').clicked, 0);
});

test('点击前无法继续持有任务时不点击', async () => {
  const ctx = setupCheckIn([{ tag: 'button', text: '签到' }]);
  const result = await ctx.M.checkInOnThisPage(checkInSite, { beforeClick: () => false });
  assert.equal(result, null);
  assert.equal(ctx.body.querySelector('button').clicked, 0);
});

test('等待点击结果期间任务被手动结束，不再采信迟到的成功提示', async () => {
  let active = true;
  const ctx = setupCheckIn([
    { tag: 'button', text: '签到' },
    { tag: 'div', attrs: { role: 'alert' }, text: '签到成功' }
  ], () => { active = false; });
  const result = await ctx.M.checkInOnThisPage(checkInSite, {
    isActive: () => active,
    previousClick: { clickedText: '签到' }
  });
  assert.equal(result, null);
});
