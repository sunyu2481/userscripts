const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPureModules, loadDomModules } = require('./load-src.js');
const { buildDom } = require('./dom-stub.js');

const M = loadPureModules({ URL, console });

// 用给定的 title / meta 建页面，测自动取名
function setupPage({ title = '', ogSiteName = null, appName = null } = {}) {
  const children = [];
  if (ogSiteName !== null) {
    children.push({ tag: 'meta', attrs: { property: 'og:site_name', content: ogSiteName } });
  }
  if (appName !== null) {
    children.push({ tag: 'meta', attrs: { name: 'application-name', content: appName } });
  }
  const dom = buildDom(children, { title });
  // stub 的 meta 用 attrs.content，读取时走 .content
  for (const meta of dom.body.querySelectorAll('meta')) {
    meta.content = meta.getAttribute('content');
  }
  const mods = loadDomModules({
    document: dom.document,
    window: dom.window,
    location: dom.location,
    getSettings: () => ({ extraButtonWords: '' }),
    URL,
    console
  });
  return mods;
}

// ===== 自动取名的过滤 =====

test('标题是「签到 - 站点名」时取站点名', () => {
  const mods = setupPage({ title: '签到 - 甲站' });
  assert.equal(mods.readSiteNameFromPage('a.com'), '甲站');
});

test('标题是「站点名 - 签到」时也取站点名', () => {
  const mods = setupPage({ title: '甲站 - 签到' });
  assert.equal(mods.readSiteNameFromPage('a.com'), '甲站');
});

test('标题只有功能词时不取名', () => {
  for (const title of ['签到', '打卡', '领取', '首页', '控制台', '个人中心',
                       'Check-in', 'Dashboard', 'Login', 'Daily']) {
    const mods = setupPage({ title });
    assert.equal(mods.readSiteNameFromPage('a.com'), null, `「${title}」不该被当站点名`);
  }
});

test('各种分隔符都能拆', () => {
  for (const title of ['签到 | 甲站', '签到 – 甲站', '签到 · 甲站',
                       '签到：甲站', '签到 > 甲站', '签到 / 甲站']) {
    const mods = setupPage({ title });
    assert.equal(mods.readSiteNameFromPage('a.com'), '甲站', title);
  }
});

test('og:site_name 优先于标题', () => {
  const mods = setupPage({ title: '签到 - 别的名字', ogSiteName: '正式站名' });
  assert.equal(mods.readSiteNameFromPage('a.com'), '正式站名');
});

test('og:site_name 是功能词时退回标题', () => {
  const mods = setupPage({ title: '签到 - 甲站', ogSiteName: '签到' });
  assert.equal(mods.readSiteNameFromPage('a.com'), '甲站');
});

test('application-name 也能用', () => {
  const mods = setupPage({ title: '', appName: '乙站' });
  assert.equal(mods.readSiteNameFromPage('a.com'), '乙站');
});

test('名称跟域名一样时不存', () => {
  const mods = setupPage({ title: 'a.com' });
  assert.equal(mods.readSiteNameFromPage('a.com'), null);
});

test('单字符和纯符号不当名称', () => {
  assert.equal(setupPage({ title: 'A' }).readSiteNameFromPage('a.com'), null);
  assert.equal(setupPage({ title: '- -' }).readSiteNameFromPage('a.com'), null);
  assert.equal(setupPage({ title: '###' }).readSiteNameFromPage('a.com'), null);
});

test('过长的标题不当名称', () => {
  const long = '这是一个非常长的站点标题'.repeat(5);
  assert.equal(setupPage({ title: long }).readSiteNameFromPage('a.com'), null);
});

test('没有标题也不炸', () => {
  assert.equal(setupPage({ title: '' }).readSiteNameFromPage('a.com'), null);
});

test('三段标题挑第一个非功能词', () => {
  const mods = setupPage({ title: '签到 - 用户中心 - 丙站' });
  assert.equal(mods.readSiteNameFromPage('a.com'), '丙站');
});

test('名字里带连字符不会被拆坏', () => {
  // 连字符两侧没空格时不当分隔符
  assert.equal(setupPage({ title: 'Sub2API-Pro' }).readSiteNameFromPage('a.com'), 'Sub2API-Pro');
  assert.equal(setupPage({ title: '签到 - Free-API' }).readSiteNameFromPage('a.com'), 'Free-API');
});

test('Check-in 这类功能词整体识别', () => {
  // 若先按连字符拆，会得到「Check」而漏过过滤
  assert.equal(setupPage({ title: 'Check-in' }).readSiteNameFromPage('a.com'), null);
  assert.equal(setupPage({ title: 'check in' }).readSiteNameFromPage('a.com'), null);
  assert.equal(setupPage({ title: 'Check-in - 甲站' }).readSiteNameFromPage('a.com'), '甲站');
});

// ===== 名称锁定 =====

test('名称没被改过时允许自动更新', () => {
  assert.equal(M.canAutoUpdateName({ domain: 'a.com', name: 'a.com' }), true);
  assert.equal(M.canAutoUpdateName({ domain: 'a.com', name: '' }), true);
  assert.equal(M.canAutoUpdateName({ domain: 'a.com' }), true);
});

test('手动改过名称后不再自动更新', () => {
  assert.equal(M.canAutoUpdateName({ domain: 'a.com', name: '甲站', nameLocked: true }), false);
});

test('名称已经不是域名时也不自动更新', () => {
  // 之前自动学到的名称，不重复覆盖
  assert.equal(M.canAutoUpdateName({ domain: 'a.com', name: '甲站' }), false);
});

test('空站点不允许自动更新', () => {
  assert.equal(M.canAutoUpdateName(null), false);
  assert.equal(M.canAutoUpdateName(undefined), false);
});

// ===== 编辑校验 =====

const baseSites = [
  { domain: 'a.com', name: 'a.com', pageUrl: 'https://a.com/#/checkin' },
  { domain: 'b.com', name: '乙站', pageUrl: '' }
];

test('同时改名称和地址', () => {
  const result = M.buildEditedSite(baseSites, 'a.com', {
    name: '甲站',
    url: 'https://a.com/#/daily'
  });
  assert.equal(result.error, undefined);
  const edited = result.sites.find(s => s.domain === 'a.com');
  assert.equal(edited.name, '甲站');
  assert.equal(edited.pageUrl, 'https://a.com/#/daily');
  assert.equal(edited.nameLocked, true, '手动改过要锁定');
});

test('改域名时连带更新', () => {
  const result = M.buildEditedSite(baseSites, 'a.com', {
    name: '甲站',
    url: 'https://new.com/#/checkin'
  });
  assert.equal(result.error, undefined);
  assert.ok(result.sites.some(s => s.domain === 'new.com'));
  assert.ok(!result.sites.some(s => s.domain === 'a.com'));
});

test('名称留空回落到域名并解除锁定', () => {
  const locked = [{ domain: 'a.com', name: '旧名', nameLocked: true, pageUrl: '' }];
  const result = M.buildEditedSite(locked, 'a.com', { name: '', url: 'https://a.com/' });
  const edited = result.sites[0];
  assert.equal(edited.name, 'a.com');
  assert.equal(edited.nameLocked, false, '留空应解除锁定，让自动获取重新生效');
});

test('名称填成域名本身不算锁定', () => {
  const result = M.buildEditedSite(baseSites, 'a.com', { name: 'a.com', url: 'https://a.com/' });
  assert.equal(result.sites.find(s => s.domain === 'a.com').nameLocked, false);
});

test('名称首尾空白和连续空格会规整', () => {
  const result = M.buildEditedSite(baseSites, 'a.com', {
    name: '  甲   站  ',
    url: 'https://a.com/'
  });
  assert.equal(result.sites.find(s => s.domain === 'a.com').name, '甲 站');
});

test('改成已存在的域名被拒绝', () => {
  const result = M.buildEditedSite(baseSites, 'a.com', { name: '甲站', url: 'https://b.com/' });
  assert.match(result.error, /已经在列表里/);
  assert.equal(result.sites, undefined);
});

test('域名不变时不算重复', () => {
  const result = M.buildEditedSite(baseSites, 'a.com', { name: '甲站', url: 'https://a.com/other' });
  assert.equal(result.error, undefined);
});

test('地址无效被拒绝', () => {
  for (const url of ['', '   ', '没有点的字符串', null]) {
    const result = M.buildEditedSite(baseSites, 'a.com', { name: '甲站', url });
    assert.match(result.error, /地址/, `「${url}」应该被拒绝`);
  }
});

test('名称过长被拒绝', () => {
  const result = M.buildEditedSite(baseSites, 'a.com', {
    name: '名'.repeat(41),
    url: 'https://a.com/'
  });
  assert.match(result.error, /太长/);
});

test('站点不存在时报错', () => {
  const result = M.buildEditedSite(baseSites, 'nope.com', { name: 'x', url: 'https://x.com/' });
  assert.match(result.error, /找不到/);
});

test('编辑不影响其它站点', () => {
  const result = M.buildEditedSite(baseSites, 'a.com', { name: '甲站', url: 'https://a.com/' });
  const other = result.sites.find(s => s.domain === 'b.com');
  assert.deepEqual(other, baseSites[1]);
});

test('hash 路由地址在编辑后完整保留', () => {
  const result = M.buildEditedSite(baseSites, 'a.com', {
    name: '甲站',
    url: 'https://a.com/#/user/checkin?tab=daily'
  });
  assert.equal(
    result.sites.find(s => s.domain === 'a.com').pageUrl,
    'https://a.com/#/user/checkin?tab=daily'
  );
});

test('派生配置透出锁定标记', () => {
  assert.equal(M.buildSiteConfig({ domain: 'a.com', nameLocked: true }).nameLocked, true);
  assert.equal(M.buildSiteConfig({ domain: 'a.com' }).nameLocked, false);
});

// ===== 仅访问模式 =====

test('编辑时可以开启仅访问', () => {
  const result = M.buildEditedSite(baseSites, 'a.com', {
    name: '甲站',
    url: 'https://a.com/',
    visitOnly: true
  });
  assert.equal(result.sites.find(s => s.domain === 'a.com').visitOnly, true);
});

test('编辑时可以关闭仅访问', () => {
  const sites = [{ domain: 'a.com', name: '甲站', pageUrl: '', visitOnly: true }];
  const result = M.buildEditedSite(sites, 'a.com', {
    name: '甲站',
    url: 'https://a.com/',
    visitOnly: false
  });
  assert.equal(result.sites[0].visitOnly, false);
});

test('没传 visitOnly 时保持原值', () => {
  const sites = [{ domain: 'a.com', name: '甲站', pageUrl: '', visitOnly: true }];
  const result = M.buildEditedSite(sites, 'a.com', { name: '甲站', url: 'https://a.com/' });
  assert.equal(result.sites[0].visitOnly, true, '漏传不该改掉模式');
});

test('仅访问标记在派生配置里透出', () => {
  assert.equal(M.buildSiteConfig({ domain: 'a.com', visitOnly: true }).visitOnly, true);
  assert.equal(M.buildSiteConfig({ domain: 'a.com' }).visitOnly, false);
});

test('改地址的同时改模式互不影响', () => {
  const result = M.buildEditedSite(baseSites, 'a.com', {
    name: '甲站',
    url: 'https://a.com/#/home',
    visitOnly: true
  });
  const edited = result.sites.find(s => s.domain === 'a.com');
  assert.equal(edited.pageUrl, 'https://a.com/#/home');
  assert.equal(edited.visitOnly, true);
  assert.equal(edited.name, '甲站');
});
