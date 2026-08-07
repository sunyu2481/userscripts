const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDomModules } = require('./load-src.js');
const { buildDom } = require('./dom-stub.js');

function setupNetwork({ fetch, XMLHttpRequest } = {}) {
  const dom = buildDom([]);
  Object.assign(dom.window, { fetch, XMLHttpRequest });
  const module = loadDomModules({
    document: dom.document,
    window: dom.window,
    location: dom.location,
    getSettings: () => ({ extraButtonWords: '' }),
    URL,
    console
  });
  module.installNetworkHooks();
  return { ...dom, module };
}

function makeResponse(text) {
  return {
    status: 200,
    cloneCalls: 0,
    clone() {
      this.cloneCalls++;
      return { text: () => text };
    }
  };
}

test('普通 GET 响应不会被克隆读取', async () => {
  const response = makeResponse(Promise.resolve('{}'));
  const { window } = setupNetwork({ fetch: async () => response });

  assert.equal(await window.fetch('https://site.example.com/api/profile'), response);
  assert.equal(response.cloneCalls, 0);
});

test('候选 fetch 的副本读取不会阻塞页面拿到响应', async () => {
  let resolveText;
  const text = new Promise(resolve => { resolveText = resolve; });
  const response = makeResponse(text);
  const { window } = setupNetwork({ fetch: async () => response });

  const outcome = await Promise.race([
    window.fetch('https://site.example.com/api/checkin').then(() => 'returned'),
    new Promise(resolve => setImmediate(() => resolve('blocked')))
  ]);
  assert.equal(outcome, 'returned');
  assert.equal(response.cloneCalls, 1);
  resolveText('{}');
});

test('XHR 非文本响应不会读取 responseText 或抛异常', () => {
  class FakeXHR {
    constructor() {
      this.responseType = 'arraybuffer';
      this.status = 200;
      this.listeners = {};
    }

    open() {}

    send() {}

    addEventListener(name, callback) {
      this.listeners[name] = callback;
    }

    get responseText() {
      throw new Error('非文本响应不能读取 responseText');
    }
  }

  setupNetwork({ XMLHttpRequest: FakeXHR });
  const xhr = new FakeXHR();
  xhr.open('POST', 'https://site.example.com/api/action');
  xhr.send();
  assert.doesNotThrow(() => xhr.listeners.load());
});
