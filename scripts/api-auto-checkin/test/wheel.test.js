const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');
const { buildDom } = require('./dom-stub.js');

// 转盘式签到：按钮「开始转动」→ 转几秒 → 弹窗显示转到的额度
function setup(spec, { extraWords = '' } = {}) {
  const dom = buildDom(spec, { url: 'https://wheel.example.com/#/checkin' });
  const source = ['20-site.js', '30-detect.js', '31-guards.js', '41-verdict.js']
    .map(n => fs.readFileSync(path.join(srcDir, n), 'utf8')).join('\n');

  const M = new Function('document', 'window', 'location', 'URL', 'console', 'getSettings', `
    ${source}
    return {
      findCheckInButton, findDisabledCheckInButton, findAlreadyCheckedIn,
      closeBlockingDialogs, readVerdictFromToast, isCheckInOutcomeText,
      readVerdictFromResponse, IN_PROGRESS_PATTERN
    };
  `)(dom.document, dom.window, dom.location, URL, console, () => ({ extraButtonWords: extraWords }));

  return { M, dom };
}

// ===== 按钮识别 =====

test('识别转盘类按钮文案', () => {
  for (const text of ['开始转动', '开始抽奖', '点击抽奖', '立即抽奖', '免费抽奖',
                      '点击转动', '抽奖', '试试运气', 'Spin', 'Lucky Draw', 'Spin Now']) {
    const { M } = setup([{ tag: 'button', text }]);
    assert.ok(M.findCheckInButton(), `应该识别「${text}」`);
  }
});

test('不收太泛的词避免误伤', () => {
  // 「开始」「draw」单独出现时不该当签到按钮
  for (const text of ['开始使用', '开始', 'Drawer', 'Drawing Board']) {
    const { M } = setup([{ tag: 'button', text }]);
    assert.equal(M.findCheckInButton(), null, `不该把「${text}」当签到按钮`);
  }
});

test('自定义文案能补上没收录的转盘按钮', () => {
  const spec = [{ tag: 'button', text: '摇一摇' }];
  assert.equal(setup(spec).M.findCheckInButton(), null);
  assert.ok(setup(spec, { extraWords: '摇一摇' }).M.findCheckInButton());
});

// ===== 转动中不算已签 =====

test('转动中的禁用按钮不算今日已签', () => {
  for (const text of ['转动中', '抽奖中', '抽取中', '旋转中', '正在抽奖',
                      '请稍候', 'Spinning', 'Drawing...']) {
    const { M } = setup([{ tag: 'button', text, disabled: true }]);
    assert.equal(M.findDisabledCheckInButton(), null, `「${text}」是进行中，不该判已签`);
  }
});

test('转完后能识别置灰的按钮', () => {
  const { M } = setup([{ tag: 'button', text: '开始转动', disabled: true }]);
  const disabled = M.findDisabledCheckInButton();
  assert.ok(disabled, '文案没有进行中特征时，应保留不可用按钮线索');
  assert.equal(disabled.text, '开始转动');
});

test('进行中的文案模式覆盖中英文', () => {
  const { M } = setup([{ tag: 'div', text: 'x' }]);
  for (const text of ['转动中', '抽奖中', 'spinning', 'processing', '正在处理', '...']) {
    assert.equal(M.IN_PROGRESS_PATTERN.test(text), true, text);
  }
  // 正常按钮文案不该命中
  assert.equal(M.IN_PROGRESS_PATTERN.test('开始转动'), false);
  assert.equal(M.IN_PROGRESS_PATTERN.test('签到'), false);
});

// ===== 结果弹窗要保住 =====

test('转盘结果弹窗不被当公告关掉', () => {
  const { M, dom } = setup([
    {
      tag: 'div',
      attrs: { class: 'modal', role: 'dialog' },
      children: [
        { tag: 'h3', text: '恭喜获得 $1.00' },
        { tag: 'button', text: '确定' }
      ]
    }
  ]);
  assert.equal(M.closeBlockingDialogs(), 0, '结果弹窗必须留着才能读到结论');
  const btn = dom.body.querySelectorAll('button')[0];
  assert.equal(btn.clicked, 0);
});

test('抽中提示的弹窗也保住', () => {
  for (const text of ['抽中 5 额度', '转到 $2.00', '中奖啦', '幸运奖励已到账', '已存入账户']) {
    const { M } = setup([
      {
        tag: 'div',
        attrs: { class: 'modal', role: 'dialog' },
        children: [{ tag: 'p', text }, { tag: 'button', text: '关闭' }]
      }
    ]);
    assert.equal(M.closeBlockingDialogs(), 0, `「${text}」是结果，不该关`);
  }
});

test('普通公告弹窗照旧关掉', () => {
  const { M } = setup([
    {
      tag: 'div',
      attrs: { class: 'modal', role: 'dialog' },
      children: [
        { tag: 'p', text: '本站将于今晚维护，请提前保存数据' },
        { tag: 'button', text: '我知道了' }
      ]
    }
  ]);
  assert.equal(M.closeBlockingDialogs(), 1);
});

test('结果文案判定不误伤长篇内容', () => {
  const { M } = setup([{ tag: 'div', text: 'x' }]);
  assert.equal(M.isCheckInOutcomeText('恭喜获得 $1.00'), true);
  assert.equal(M.isCheckInOutcomeText('今日已签到'), true);
  assert.equal(M.isCheckInOutcomeText('维护公告'), false);
  // 过长的文本不当结果，避免整页内容命中
  assert.equal(M.isCheckInOutcomeText('恭喜' + '说明'.repeat(120)), false);
});

// ===== 结果读取 =====

test('从结果弹窗读出成功', () => {
  const { M } = setup([
    { tag: 'div', attrs: { class: 'modal', role: 'dialog' }, children: [
      { tag: 'p', attrs: { class: 'message' }, text: '恭喜获得 $1.00' }
    ]}
  ]);
  const verdict = M.readVerdictFromToast();
  assert.equal(verdict?.status, 'success');
});

test('转盘次数用完判为已签', () => {
  for (const text of ['今日次数已用完', '抽奖次数不足', '机会已用完', 'No draws left']) {
    const { M } = setup([
      { tag: 'div', attrs: { class: 'toast' }, text }
    ]);
    assert.equal(M.readVerdictFromToast()?.status, 'already', text);
  }
});

test('转盘接口响应能判成功', () => {
  const { M } = setup([{ tag: 'div', text: 'x' }]);
  const verdict = M.readVerdictFromResponse({
    url: 'https://wheel.example.com/api/lottery/draw',
    method: 'POST',
    status: 200,
    text: JSON.stringify({ success: true, message: '恭喜抽中 1.00 额度' })
  });
  assert.equal(verdict.status, 'success');
});
