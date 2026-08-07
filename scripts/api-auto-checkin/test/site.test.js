const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPureModules } = require('./load-src.js');

const M = loadPureModules({ URL, console });

test('站点配置只有页面地址，没有接口路径', () => {
  const site = M.buildSiteConfig({ domain: 'a.example.com' });
  assert.equal(site.siteId, 'a_example_com');
  assert.equal(site.siteName, 'a.example.com');
  assert.equal(site.visitUrl, 'https://a.example.com/');
  assert.equal(site.enabled, true);
  assert.equal(site.visitOnly, false);

  // 不该出现任何拼接出来的接口地址
  const keys = Object.keys(site).join(' ');
  assert.doesNotMatch(keys, /signExec|signQuery|apiBase|type/i);
});

test('填了签到页地址就用它', () => {
  const site = M.buildSiteConfig({
    domain: 'a.example.com',
    pageUrl: 'https://a.example.com/console/personal'
  });
  assert.equal(site.visitUrl, 'https://a.example.com/console/personal');
});

test('自定义名称优先于域名', () => {
  const site = M.buildSiteConfig({ domain: 'a.example.com', name: '甲站' });
  assert.equal(site.siteName, '甲站');
});

test('仅访问模式标记保留', () => {
  assert.equal(M.buildSiteConfig({ domain: 'a.com', visitOnly: true }).visitOnly, true);
  assert.equal(M.buildSiteConfig({ domain: 'a.com' }).visitOnly, false);
});

test('站点配置保留并规整按钮和结果文案', () => {
  const site = M.buildSiteConfig({
    domain: 'a.com',
    buttonWords: ' 立即签，立即签\n每日签到 ',
    resultWords: ['奖励已发放', ' 奖励已发放 ']
  });
  assert.deepEqual(site.buttonWords, ['立即签', '每日签到']);
  assert.deepEqual(site.resultWords, ['奖励已发放']);
});

test('地址解析补协议并保留路径与查询', () => {
  assert.deepEqual(M.normalizeSiteInput('c.com/console/personal'), {
    domain: 'c.com',
    pageUrl: 'https://c.com/console/personal'
  });
  assert.deepEqual(M.normalizeSiteInput('https://c.com/check-in?tab=daily'), {
    domain: 'c.com',
    pageUrl: 'https://c.com/check-in?tab=daily'
  });
});

test('只填域名时不记页面地址，运行时用首页', () => {
  assert.deepEqual(M.normalizeSiteInput('c.com'), { domain: 'c.com', pageUrl: '' });
  assert.deepEqual(M.normalizeSiteInput('https://c.com/'), { domain: 'c.com', pageUrl: '' });
});

test('无效输入返回 null', () => {
  assert.equal(M.normalizeSiteInput(''), null);
  assert.equal(M.normalizeSiteInput('   '), null);
  assert.equal(M.normalizeSiteInput('没有点的字符串'), null);
  assert.equal(M.normalizeSiteInput('http://c.com/checkin'), null);
  assert.equal(M.normalizeSiteInput('https://user:pass@c.com/checkin'), null);
  assert.equal(M.normalizeSiteInput('https://bad_name.c.com/checkin'), null);
  assert.equal(M.normalizeSiteInput('https://-bad.c.com/checkin'), null);
  assert.equal(M.normalizeSiteInput(null), null);
});

test('配置文案有数量上限', () => {
  const words = Array.from({ length: 50 }, (_, index) => `文案${index}`);
  assert.equal(M.normalizeConfiguredWords(words).length, M.MAX_CONFIGURED_WORDS);
});

test('域名去重保留首个并转小写', () => {
  const deduped = M.dedupeSitesByDomain([
    { domain: 'A.Example.com', name: '第一个' },
    { domain: 'a.example.com', name: '重复' },
    { domain: '', name: '空' },
    { domain: 'b.example.com', name: '第二个' }
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].domain, 'a.example.com');
  assert.equal(deduped[0].name, '第一个');
});

test('非数组输入不炸', () => {
  assert.deepEqual(M.dedupeSitesByDomain(null), []);
  assert.deepEqual(M.dedupeSitesByDomain('x'), []);
});

test('站点排序不越界', () => {
  const sites = [{ domain: 'a' }, { domain: 'b' }, { domain: 'c' }];
  assert.deepEqual(M.moveSiteInList(sites, 0, 2).map(s => s.domain), ['b', 'c', 'a']);
  assert.deepEqual(M.moveSiteInList(sites, 2, 0).map(s => s.domain), ['c', 'a', 'b']);
  assert.deepEqual(M.moveSiteInList(sites, 9, 0).map(s => s.domain), ['a', 'b', 'c']);
  assert.deepEqual(M.moveSiteInList(sites, 0, -1).map(s => s.domain), ['a', 'b', 'c']);
  // 原数组不被修改
  assert.deepEqual(sites.map(s => s.domain), ['a', 'b', 'c']);
});
