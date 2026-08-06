const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');

// 单独加载协调者和签到流程里与路由、任务认领相关的纯函数
function loadRoutingHelpers(locationStub) {
  const source = [
    fs.readFileSync(path.join(srcDir, '60-coordinator.js'), 'utf8'),
    fs.readFileSync(path.join(srcDir, '40-checkin.js'), 'utf8')
  ].join('\n');

  const names = ['isJobFresh', 'getTargetHash', 'ensureHashRoute', 'pickGap',
                 'summarizeResults', 'JOB_CLAIM_WINDOW_MS'];
  const factory = new Function('location', 'URL', 'setTimeout', 'Math', `
    ${source}
    return { ${names.join(', ')} };
  `);
  return factory(locationStub, URL, setTimeout, Math);
}

const M = loadRoutingHelpers({ hash: '' });

test('取出 hash 路由部分', () => {
  assert.equal(M.getTargetHash('https://aa.bb.com/#/checkin'), '#/checkin');
  assert.equal(M.getTargetHash('https://aa.bb.com/#/user/daily'), '#/user/daily');
  assert.equal(M.getTargetHash('https://aa.bb.com/#checkin'), '#checkin');
});

test('没有 hash 的地址返回空', () => {
  assert.equal(M.getTargetHash('https://aa.bb.com/'), '');
  assert.equal(M.getTargetHash('https://aa.bb.com/console/personal'), '');
  // 只有 # 没有内容的不算路由
  assert.equal(M.getTargetHash('https://aa.bb.com/#'), '');
  assert.equal(M.getTargetHash('不是地址'), '');
});

test('hash 带查询参数时完整保留', () => {
  assert.equal(
    M.getTargetHash('https://aa.bb.com/#/checkin?tab=daily'),
    '#/checkin?tab=daily'
  );
});

test('当前 hash 不对时会纠正', async () => {
  const locationStub = { hash: '' };
  const helpers = loadRoutingHelpers(locationStub);
  const fixed = await helpers.ensureHashRoute({ visitUrl: 'https://aa.bb.com/#/checkin' });
  assert.equal(fixed, true);
  assert.equal(locationStub.hash, '#/checkin');
});

test('hash 已经正确时不重复设置', async () => {
  const locationStub = { hash: '#/checkin' };
  const helpers = loadRoutingHelpers(locationStub);
  const fixed = await helpers.ensureHashRoute({ visitUrl: 'https://aa.bb.com/#/checkin' });
  assert.equal(fixed, false);
});

test('目标地址没有 hash 时不动当前 hash', async () => {
  const locationStub = { hash: '#/somewhere' };
  const helpers = loadRoutingHelpers(locationStub);
  const fixed = await helpers.ensureHashRoute({ visitUrl: 'https://aa.bb.com/console/personal' });
  assert.equal(fixed, false);
  assert.equal(locationStub.hash, '#/somewhere', '不该改动');
});

test('SPA 把 hash 冲成首页后能纠正回来', async () => {
  // 模拟前端初始化时把 hash 重置成 #/
  const locationStub = { hash: '#/' };
  const helpers = loadRoutingHelpers(locationStub);
  const fixed = await helpers.ensureHashRoute({ visitUrl: 'https://aa.bb.com/#/checkin' });
  assert.equal(fixed, true);
  assert.equal(locationStub.hash, '#/checkin');
});

test('刚派出的任务能被认领', () => {
  const now = 1_000_000;
  const job = { site: { domain: 'aa.bb.com' }, assignedAt: now };
  assert.equal(M.isJobFresh(job, 'aa.bb.com', now), true);
  assert.equal(M.isJobFresh(job, 'aa.bb.com', now + 5000), true);
});

test('超出时间窗口的任务不认领', () => {
  const now = 1_000_000;
  const job = { site: { domain: 'aa.bb.com' }, assignedAt: now };
  assert.equal(M.isJobFresh(job, 'aa.bb.com', now + M.JOB_CLAIM_WINDOW_MS + 1), false);
});

test('已被认领的任务不再认领', () => {
  const now = 1_000_000;
  const job = { site: { domain: 'aa.bb.com' }, assignedAt: now, claimedAt: now + 100 };
  assert.equal(M.isJobFresh(job, 'aa.bb.com', now + 200), false);
});

test('域名不匹配的任务不认领', () => {
  const now = 1_000_000;
  const job = { site: { domain: 'aa.bb.com' }, assignedAt: now };
  assert.equal(M.isJobFresh(job, 'other.com', now), false);
});

test('空任务或缺字段的任务不认领', () => {
  assert.equal(M.isJobFresh(null, 'aa.bb.com'), false);
  assert.equal(M.isJobFresh({}, 'aa.bb.com'), false);
  assert.equal(M.isJobFresh({ site: {} }, 'aa.bb.com'), false);
  assert.equal(M.isJobFresh({ site: { domain: 'aa.bb.com' } }, 'aa.bb.com'), false);
});

test('间隔落在配置区间内', () => {
  for (let i = 0; i < 50; i++) {
    const gap = M.pickGap({ gapMinMs: 3000, gapMaxMs: 8000 });
    assert.ok(gap >= 3000 && gap <= 8000, `间隔 ${gap} 越界`);
  }
});

test('最大值小于最小值时不会产生负间隔', () => {
  const gap = M.pickGap({ gapMinMs: 5000, gapMaxMs: 1000 });
  assert.ok(gap >= 5000);
});

test('结果汇总文案按类别拼接', () => {
  const summary = M.summarizeResults({
    a: { status: 'success' },
    b: { status: 'already' },
    c: { status: 'failed' },
    d: { status: 'unknown' }
  });
  assert.equal(summary.success, 1);
  assert.equal(summary.already, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.unknown, 1);
  assert.match(summary.text, /成功 1/);
  assert.match(summary.text, /已签 1/);
  assert.match(summary.text, /失败 1/);
});

test('空结果也有合理文案', () => {
  assert.equal(M.summarizeResults({}).text, '签到完成');
});
