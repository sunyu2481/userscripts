const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDomModules } = require('./load-src.js');
const { buildDom } = require('./dom-stub.js');

// 用页面描述树建一个 DOM，加载识别逻辑
function setup(spec, options = {}) {
  const dom = buildDom(spec, options);
  const M = loadDomModules({
    document: dom.document,
    window: dom.window,
    location: dom.location,
    getSettings: () => ({ extraButtonWords: options.extraWords || '' }),
    URL,
    console
  });
  return { ...dom, M };
}

test('找到最常见的签到按钮', () => {
  const { M } = setup([
    { tag: 'button', text: '签到' }
  ]);
  const found = M.findCheckInButton();
  assert.ok(found, '应该找到按钮');
  assert.equal(found.text, '签到');
});

test('识别各种签到文案', () => {
  const texts = [
    '签到', '打卡', '领取', '立即签到', '每日签到', '今日签到', '点击签到',
    '签到领取', '领取奖励', '免费领取', '每日打卡', '每日福利',
    'Check in', 'Check In Now', 'Daily Check-in', 'Claim Reward', 'Claim'
  ];
  for (const text of texts) {
    const { M } = setup([{ tag: 'button', text }]);
    assert.ok(M.findCheckInButton(), `应该识别「${text}」`);
  }
});

test('不把设置项和说明文字当成签到按钮', () => {
  const texts = [
    '签到设置', '签到规则', '签到记录', '签到历史', '连续签到 3 天',
    '签到说明', '开启签到', '签到额度', 'Check-in Settings', 'Check-in History'
  ];
  for (const text of texts) {
    const { M } = setup([{ tag: 'button', text }]);
    assert.equal(M.findCheckInButton(), null, `不该把「${text}」当按钮`);
  }
});

test('已签到的按钮不再点', () => {
  const texts = ['已签到', '今日已签到', '已打卡', '已领取', 'Already Checked In', 'Checked in'];
  for (const text of texts) {
    const { M } = setup([{ tag: 'button', text }]);
    assert.equal(M.findCheckInButton(), null, `「${text}」不该被当成可点按钮`);
    assert.ok(M.findAlreadyCheckedIn(), `「${text}」应该被识别为已签到`);
  }
});

test('配置站点按钮时忽略页面其它区域的已签到文案', () => {
  const { M } = setup([{ tag: 'div', text: '今日已签到' }]);
  assert.ok(M.findAlreadyCheckedIn(), '通用模式仍能识别已签到状态');
  assert.equal(M.findInitialAlreadyCheckedIn(['立即签']), null,
    '自定义按钮模式不能把静态页面文案当成已签');
});

test('隐藏的按钮不算', () => {
  const { M } = setup([
    { tag: 'button', text: '签到', hidden: true }
  ]);
  assert.equal(M.findCheckInButton(), null);
});

test('display none 的按钮不算', () => {
  const { M } = setup([
    { tag: 'button', text: '签到', style: { display: 'none' } }
  ]);
  assert.equal(M.findCheckInButton(), null);
});

test('禁用的签到按钮不会被当成可点按钮', () => {
  const { M } = setup([
    { tag: 'button', text: '签到', disabled: true }
  ]);
  assert.equal(M.findCheckInButton(), null);
  const disabled = M.findDisabledCheckInButton();
  assert.ok(disabled);
  assert.equal(disabled.text, '签到');
});

test('aria-disabled 与 pointer-events none 都算禁用', () => {
  const byAria = setup([{ tag: 'div', text: '签到', attrs: { role: 'button', 'aria-disabled': 'true' } }]);
  assert.equal(byAria.M.findCheckInButton(), null);

  const byPointer = setup([{ tag: 'button', text: '签到', style: { pointerEvents: 'none' } }]);
  assert.equal(byPointer.M.findCheckInButton(), null);

  const byCursor = setup([{ tag: 'button', text: '签到', style: { cursor: 'not-allowed' } }]);
  assert.equal(byCursor.M.findCheckInButton(), null);
});

test('加载中的按钮不算已签到', () => {
  const { M } = setup([
    { tag: 'button', text: '签到中...', disabled: true }
  ]);
  assert.equal(M.findDisabledCheckInButton(), null);
});

test('文案精确的按钮优先于泛化的', () => {
  const { M } = setup([
    { tag: 'button', text: '每日签到奖励说明' },
    { tag: 'button', text: '签到' }
  ]);
  assert.equal(M.findCheckInButton().text, '签到');
});

test('立即签到优先于领取奖励', () => {
  const { M } = setup([
    { tag: 'button', text: '领取奖励' },
    { tag: 'button', text: '立即签到' }
  ]);
  assert.equal(M.findCheckInButton().text, '立即签到');
});

test('容器不会因为内部有签到字样被误判', () => {
  // 外层 div 的 innerText 含"签到"，但它本身不是按钮
  const { M } = setup([
    {
      tag: 'div',
      attrs: { class: 'card' },
      children: [
        { tag: 'p', text: '每天签到可以领取额度' },
        { tag: 'button', text: '签到' }
      ]
    }
  ]);
  const found = M.findCheckInButton();
  assert.equal(found.text, '签到');
  assert.equal(found.el.tagName, 'BUTTON');
});

test('文案在 span 上、点击挂在祖先按钮时能找到按钮', () => {
  const { M } = setup([
    {
      tag: 'div',
      attrs: { role: 'button', class: 'btn' },
      children: [{ tag: 'span', text: '签到' }]
    }
  ]);
  const found = M.findCheckInButton();
  assert.ok(found);
  // 点击目标应该是可点击的祖先，不是 span
  assert.equal(found.el.getAttribute('role'), 'button');
});

test('aria-label 也能作为按钮文案', () => {
  const { M } = setup([
    { tag: 'button', attrs: { 'aria-label': '每日签到' } }
  ]);
  assert.ok(M.findCheckInButton());
});

test('用户补充的文案能被识别', () => {
  const spec = [{ tag: 'button', text: '每日礼包' }];
  assert.equal(setup(spec).M.findCheckInButton(), null);
  assert.ok(setup(spec, { extraWords: '每日礼包' }).M.findCheckInButton());
});

test('补充文案支持中英文逗号和换行分隔', () => {
  const spec = [{ tag: 'button', text: '点我领福利' }];
  assert.ok(setup(spec, { extraWords: '每日礼包，点我领福利' }).M.findCheckInButton());
  assert.ok(setup(spec, { extraWords: '每日礼包\n点我领福利' }).M.findCheckInButton());
});

test('站点指定按钮文案时只匹配指定按钮', () => {
  const dom = setup([
    { tag: 'button', text: '立即签' },
    { tag: 'button', text: '每日签到' }
  ]);
  assert.equal(dom.M.findCheckInButton().text, '每日签到');
  assert.equal(dom.M.findCheckInButton(['立即签']).text, '立即签');
  assert.equal(dom.M.findCheckInButton(['不存在']), null);
});

test('过长的文案不当按钮', () => {
  const { M } = setup([
    { tag: 'button', text: '签到功能说明：每天登录后可以点击签到按钮领取额度奖励' }
  ]);
  assert.equal(M.findCheckInButton(), null);
});

test('列出可点击文案供调试', () => {
  const { M } = setup([
    { tag: 'button', text: '登录' },
    { tag: 'button', text: '我的账户' },
    { tag: 'a', text: '帮助', attrs: { href: '#' } },
    { tag: 'button', text: '登录', attrs: { class: 'dup' } }
  ]);
  const texts = M.listClickableTexts();
  assert.ok(texts.includes('登录'));
  assert.ok(texts.includes('我的账户'));
  // 重复文案只留一份
  assert.equal(texts.filter(t => t === '登录').length, 1);
});

test('识别人机验证的选择器与文字', () => {
  const byIframe = setup([
    { tag: 'iframe', attrs: { src: 'https://challenges.cloudflare.com/turnstile/v0' } }
  ]);
  assert.equal(byIframe.M.hasHumanVerification(), true);

  const byClass = setup([{ tag: 'div', attrs: { class: 'cf-turnstile' } }]);
  assert.equal(byClass.M.hasHumanVerification(), true);

  const byText = setup([{ tag: 'div', text: '请完成安全验证后继续' }]);
  assert.equal(byText.M.hasHumanVerification(), true);

  const normal = setup([{ tag: 'button', text: '签到' }]);
  assert.equal(normal.M.hasHumanVerification(), false);
});

test('隐藏的验证组件不算', () => {
  const { M } = setup([
    { tag: 'div', attrs: { class: 'cf-turnstile' }, hidden: true }
  ]);
  assert.equal(M.hasHumanVerification(), false);
});

test('登录页判断：路径与密码框', () => {
  const byPath = setup([{ tag: 'div', text: '欢迎' }], { url: 'https://site.example.com/login' });
  assert.equal(byPath.M.isOnLoginPage(), true);

  const byPassword = setup([
    { tag: 'input', attrs: { type: 'password' } }
  ], { url: 'https://site.example.com/somewhere' });
  assert.equal(byPassword.M.isOnLoginPage(), true);

  const checkinPage = setup([{ tag: 'button', text: '签到' }]);
  assert.equal(checkinPage.M.isOnLoginPage(), false);
});

test('有签到按钮时即便有密码框也不算登录页', () => {
  const { M } = setup([
    { tag: 'input', attrs: { type: 'password' } },
    { tag: 'button', text: '签到' }
  ]);
  assert.equal(M.isOnLoginPage(), false);
});

test('未登录提示能被识别', () => {
  const byText = setup([{ tag: 'div', text: '请先登录后再进行操作' }]);
  assert.equal(byText.M.looksLoggedOut(), true);

  const byButton = setup([{ tag: 'button', text: '登录' }]);
  assert.equal(byButton.M.looksLoggedOut(), true);

  // 有签到按钮时，页面上的登录按钮不代表未登录
  const hasCheckIn = setup([
    { tag: 'button', text: '登录' },
    { tag: 'button', text: '签到' }
  ]);
  assert.equal(hasCheckIn.M.looksLoggedOut(), false);
});

test('失效页面识别标题与短正文', () => {
  const byTitle = setup([{ tag: 'div', text: '空' }], { title: '404 Not Found' });
  assert.equal(byTitle.M.looksLikeInvalidPage(), true);

  const byShortBody = setup([{ tag: 'div', text: '页面不存在' }], { title: '站点' });
  assert.equal(byShortBody.M.looksLikeInvalidPage(), true);

  // 正常页面里出现 404 字样不该误判
  const longBody = setup([{
    tag: 'div',
    text: '错误码 404 表示资源不存在。' + '这是一段很长的正常页面内容，'.repeat(12)
  }], { title: '帮助文档' });
  assert.equal(longBody.M.looksLikeInvalidPage(), false);
});

test('关掉挡路的公告弹窗', () => {
  const { M, body } = setup([
    {
      tag: 'div',
      attrs: { class: 'modal', role: 'dialog' },
      children: [
        { tag: 'p', text: '系统维护公告' },
        { tag: 'button', text: '我知道了' }
      ]
    },
    { tag: 'button', text: '签到' }
  ]);
  assert.equal(M.closeBlockingDialogs(), 1);
  const closeButton = body.querySelectorAll('button').find(b => b.innerText === '我知道了');
  assert.equal(closeButton.clicked, 1);
});

test('弹窗里有签到按钮时不关它', () => {
  const { M } = setup([
    {
      tag: 'div',
      attrs: { class: 'modal', role: 'dialog' },
      children: [
        { tag: 'p', text: '每日签到' },
        { tag: 'button', text: '签到' },
        { tag: 'button', text: '关闭' }
      ]
    }
  ]);
  assert.equal(M.closeBlockingDialogs(), 0);
});

test('站点自定义结果文案的弹窗不关', () => {
  const { M } = setup([
    {
      tag: 'div',
      attrs: { class: 'modal', role: 'dialog' },
      children: [
        { tag: 'p', text: '本次奖励已发放' },
        { tag: 'button', text: '关闭' }
      ]
    }
  ]);
  assert.equal(M.closeBlockingDialogs(null, ['奖励已发放']), 0);
});

test('人机验证弹窗一律不动', () => {
  const { M } = setup([
    {
      tag: 'div',
      attrs: { class: 'modal', role: 'dialog' },
      children: [
        { tag: 'p', text: '请完成人机验证' },
        { tag: 'button', text: '关闭' }
      ]
    }
  ]);
  assert.equal(M.closeBlockingDialogs(), 0);
});

test('登录提示弹窗不关', () => {
  const { M } = setup([
    {
      tag: 'div',
      attrs: { class: 'modal', role: 'dialog' },
      children: [
        { tag: 'p', text: '请先登录' },
        { tag: 'button', text: '取消' }
      ]
    }
  ]);
  assert.equal(M.closeBlockingDialogs(), 0);
});
