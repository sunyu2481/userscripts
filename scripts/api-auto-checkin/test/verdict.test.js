const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDomModules } = require('./load-src.js');
const { buildDom } = require('./dom-stub.js');

function setup(spec = [], options = {}) {
  const dom = buildDom(spec, options);
  const M = loadDomModules({
    document: dom.document,
    window: dom.window,
    location: dom.location,
    getSettings: () => ({ extraButtonWords: '' }),
    URL,
    console
  });
  return { ...dom, M };
}

const { M } = setup();

function respond(body, status = 200) {
  return { url: 'https://site.example.com/api/checkin', method: 'POST', status, text: JSON.stringify(body) };
}

test('成功字段的多种写法都认', () => {
  for (const body of [{ success: true }, { code: 0 }, { ret: 1 }, { ok: true }, { status: 'success' }]) {
    const verdict = M.readVerdictFromResponse(respond(body));
    assert.equal(verdict?.status, 'success', JSON.stringify(body));
  }
});

test('普通 POST 的通用成功字段不作为签到结果', () => {
  const verdict = M.readVerdictFromResponse({
    url: 'https://site.example.com/api/profile/save',
    method: 'POST',
    status: 200,
    text: JSON.stringify({ success: true })
  });
  assert.equal(verdict, null);
});

test('settings 路径不因包含 sign 而被当成签到接口', () => {
  const verdict = M.readVerdictFromResponse({
    url: 'https://site.example.com/api/settings',
    method: 'POST',
    status: 200,
    text: JSON.stringify({ success: true })
  });
  assert.equal(verdict, null);
});

test('非签到路径的明确签到文案仍可识别', () => {
  const verdict = M.readVerdictFromResponse({
    url: 'https://site.example.com/api/action',
    method: 'POST',
    status: 200,
    text: JSON.stringify({ message: '签到成功' })
  });
  assert.equal(verdict?.status, 'success');
});

test('站点结果文案可以识别非通用提示', () => {
  const verdict = M.readVerdictFromResponse({
    url: 'https://site.example.com/api/action',
    method: 'POST',
    status: 200,
    text: JSON.stringify({ message: '本次奖励已发放' })
  }, { resultWords: ['奖励已发放'] });
  assert.equal(verdict?.status, 'success');
});

test('单独的获得或恭喜不作为成功文案', () => {
  assert.equal(M.readVerdictFromResponse(respond({ message: '获得新头像' })), null);
  assert.equal(M.readVerdictFromResponse(respond({ message: '恭喜注册成功' })), null);
  assert.equal(M.readVerdictFromResponse(respond({ message: '+1 follower' })), null);
});

test('已签到的提示优先于 success 字段', () => {
  // 有站点返回 success:true 但消息是"今日已签到"
  const verdict = M.readVerdictFromResponse(respond({ success: true, message: '今日已签到' }));
  assert.equal(verdict.status, 'already');
});

test('结果里不含余额字段', () => {
  // 余额靠猜不可靠，已经移除。响应里带 balance 也不该被采信
  const verdict = M.readVerdictFromResponse(respond({ success: true, data: { balance: 12.5 } }));
  assert.equal(verdict.status, 'success');
  assert.equal('balance' in verdict, false);
});

test('失败响应带上原始消息', () => {
  const verdict = M.readVerdictFromResponse(respond({ success: false, message: '签到失败，请稍后再试' }));
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.message, '签到失败，请稍后再试');
});

test('401/403 且提示登录时标记需要登录', () => {
  const verdict = M.readVerdictFromResponse(respond({ message: '请先登录' }, 401));
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.needsLogin, true);
});

test('token 失效也标记需要登录', () => {
  const verdict = M.readVerdictFromResponse(respond({ success: false, message: 'token invalid' }, 200));
  assert.equal(verdict.needsLogin, true);
});

test('非 JSON 响应不作为签到结论', () => {
  const verdict = M.readVerdictFromResponse({
    url: 'https://site.example.com/checkin',
    method: 'GET',
    status: 200,
    text: '<!DOCTYPE html><html><body>页面</body></html>'
  });
  assert.equal(verdict, null);
});

test('无法判断的响应返回 null 而不是猜', () => {
  assert.equal(M.readVerdictFromResponse(respond({ data: [1, 2, 3] })), null);
  assert.equal(M.readVerdictFromResponse(null), null);
});

test('消息里的成功文案能兜底', () => {
  const verdict = M.readVerdictFromResponse(respond({ message: '签到成功，获得 1.00 额度' }));
  assert.equal(verdict.status, 'success');
});

test('从 toast 文字读结论', () => {
  const success = setup([
    { tag: 'div', attrs: { class: 'toast' }, text: '签到成功，获得 $1.00' }
  ]);
  assert.equal(success.M.readVerdictFromToast().status, 'success');

  const already = setup([
    { tag: 'div', attrs: { role: 'alert' }, text: '今日已签到' }
  ]);
  assert.equal(already.M.readVerdictFromToast().status, 'already');

  const failed = setup([
    { tag: 'div', attrs: { class: 'message' }, text: '签到失败' }
  ]);
  assert.equal(failed.M.readVerdictFromToast().status, 'failed');

  const login = setup([
    { tag: 'div', attrs: { class: 'notification' }, text: '请先登录' }
  ]);
  const loginVerdict = login.M.readVerdictFromToast();
  assert.equal(loginVerdict.needsLogin, true);
});

test('隐藏的 toast 不读', () => {
  const { M: hidden } = setup([
    { tag: 'div', attrs: { class: 'toast' }, text: '签到成功', hidden: true }
  ]);
  assert.equal(hidden.readVerdictFromToast(), null);
});

test('过长的 toast 文本不读，避免命中整页内容', () => {
  const { M: long } = setup([
    { tag: 'div', attrs: { class: 'message' }, text: '签到成功。' + '说明文字'.repeat(40) }
  ]);
  assert.equal(long.readVerdictFromToast(), null);
});
