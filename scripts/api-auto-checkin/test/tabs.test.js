const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');

// 只加载协调者里的标签页登记逻辑
function loadTabHelpers() {
  const source = fs.readFileSync(path.join(srcDir, '60-coordinator.js'), 'utf8');
  return new Function('Math', 'Date', 'console', `
    ${source}
    return {
      rememberOpenedTab, closeRememberedTab, closeAllOpenedTabs,
      getOpenedTabCount, shouldKeepTabOpen
    };
  `)(Math, Date, console);
}

// 造一个假句柄，记录 close 调用
function fakeHandle({ throws = false } = {}) {
  const handle = {
    closed: 0,
    close() {
      handle.closed++;
      if (throws) throw new Error('标签页已经不在了');
    }
  };
  return handle;
}

test('登记后计数增加', () => {
  const M = loadTabHelpers();
  assert.equal(M.getOpenedTabCount(), 0);
  M.rememberOpenedTab('a_com', '甲站', fakeHandle());
  M.rememberOpenedTab('b_com', '乙站', fakeHandle());
  assert.equal(M.getOpenedTabCount(), 2);
});

test('同一站点重复登记不会重复计数', () => {
  const M = loadTabHelpers();
  M.rememberOpenedTab('a_com', '甲站', fakeHandle());
  M.rememberOpenedTab('a_com', '甲站', fakeHandle());
  assert.equal(M.getOpenedTabCount(), 1);
});

test('关闭单个标签页', () => {
  const M = loadTabHelpers();
  const handle = fakeHandle();
  M.rememberOpenedTab('a_com', '甲站', handle);

  assert.equal(M.closeRememberedTab('a_com'), true);
  assert.equal(handle.closed, 1);
  assert.equal(M.getOpenedTabCount(), 0, '关掉后要从登记表移除');
});

test('关闭不存在的标签页返回 false', () => {
  const M = loadTabHelpers();
  assert.equal(M.closeRememberedTab('nope'), false);
});

test('句柄失效时不抛异常', () => {
  // 你可能已经手动关了那个标签页
  const M = loadTabHelpers();
  M.rememberOpenedTab('a_com', '甲站', fakeHandle({ throws: true }));
  assert.doesNotThrow(() => M.closeRememberedTab('a_com'));
  assert.equal(M.getOpenedTabCount(), 0, '即便关失败也要移出登记表');
});

test('一键关闭全部', () => {
  const M = loadTabHelpers();
  const handles = ['a_com', 'b_com', 'c_com'].map((id) => {
    const handle = fakeHandle();
    M.rememberOpenedTab(id, id, handle);
    return handle;
  });

  assert.equal(M.closeAllOpenedTabs(), 3);
  assert.equal(M.getOpenedTabCount(), 0);
  for (const handle of handles) assert.equal(handle.closed, 1);
});

test('一键关闭只统计真正关掉的', () => {
  const M = loadTabHelpers();
  M.rememberOpenedTab('a_com', '甲站', fakeHandle());
  M.rememberOpenedTab('b_com', '乙站', fakeHandle({ throws: true }));
  M.rememberOpenedTab('c_com', '丙站', fakeHandle());

  // 中间那个已被手动关闭，不计入
  assert.equal(M.closeAllOpenedTabs(), 2);
  assert.equal(M.getOpenedTabCount(), 0, '全部移出登记表');
});

test('空登记表关闭返回 0', () => {
  const M = loadTabHelpers();
  assert.equal(M.closeAllOpenedTabs(), 0);
});

test('需要用户处理的结果不该自动关', () => {
  const M = loadTabHelpers();
  assert.equal(M.shouldKeepTabOpen({ needsHuman: true }), true);
  assert.equal(M.shouldKeepTabOpen({ needsLogin: true }), true);
  assert.equal(M.shouldKeepTabOpen({ status: 'unknown', skipped: true }), true);
});

test('普通结果可以自动关', () => {
  const M = loadTabHelpers();
  assert.equal(M.shouldKeepTabOpen({ status: 'success' }), false);
  assert.equal(M.shouldKeepTabOpen({ status: 'already' }), false);
  assert.equal(M.shouldKeepTabOpen({ status: 'failed' }), false);
  assert.equal(M.shouldKeepTabOpen({ status: 'unknown' }), false);
  assert.equal(M.shouldKeepTabOpen(null), false);
});
