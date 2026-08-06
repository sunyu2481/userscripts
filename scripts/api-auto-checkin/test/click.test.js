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

test('元素不支持 scrollIntoView 也能点', () => {
  const { M, button } = setup();
  button.scrollIntoView = () => { throw new Error('不支持'); };
  assert.equal(M.clickElement(button), true);
  assert.equal(button.clicked, 1);
});
