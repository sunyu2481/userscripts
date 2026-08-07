const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');

function loadConfigHelpers() {
  const source = ['10-storage.js', '20-site.js', '72-ui-events.js']
    .map(name => fs.readFileSync(path.join(srcDir, name), 'utf8'))
    .join('\n');
  return new Function('URL', `
    ${source}
    return { parseBackupPayload, sanitizeSettings };
  `)(URL);
}

const M = loadConfigHelpers();

test('导入时拒绝非 HTTPS、跨域和非法主机名', () => {
  const parsed = M.parseBackupPayload(JSON.stringify({
    sites: [
      { domain: 'good.example.com', pageUrl: 'https://good.example.com/checkin', name: '好站' },
      { domain: 'http.example.com', pageUrl: 'http://http.example.com/checkin' },
      { domain: 'cross.example.com', pageUrl: 'https://other.example.com/checkin' },
      { domain: 'bad_name.example.com', pageUrl: 'https://bad_name.example.com/checkin' },
      { domain: 'secret.example.com', pageUrl: 'https://user:pass@secret.example.com/checkin' }
    ]
  }));

  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.sites, [{
    domain: 'good.example.com',
    name: '好站',
    nameLocked: true,
    enabled: true,
    pageUrl: 'https://good.example.com/checkin',
    visitOnly: false,
    buttonWords: [],
    resultWords: []
  }]);
});

test('导入会去重、规整名称并净化设置', () => {
  const parsed = M.parseBackupPayload(JSON.stringify({
    sites: [
      { domain: 'dup.example.com', name: '名'.repeat(80) },
      { domain: 'dup.example.com', name: '重复项' }
    ],
    settings: {
      gapMinMs: 900000,
      gapMaxMs: -1,
      siteTimeoutMs: 0,
      autoCloseTab: true,
      extraButtonWords: '  每日礼包  ',
      unknown: true
    }
  }));

  assert.equal(parsed.sites.length, 1);
  assert.equal(parsed.sites[0].name, 'dup.example.com');
  assert.equal(parsed.settings.gapMinMs, 600000);
  assert.equal(parsed.settings.gapMaxMs, 600000);
  assert.equal(parsed.settings.siteTimeoutMs, 5000);
  assert.equal(parsed.settings.autoCloseTab, true);
  assert.equal(parsed.settings.extraButtonWords, '每日礼包');
  assert.equal('unknown' in parsed.settings, false);
});

test('过大的备份在解析前被拒绝', () => {
  assert.deepEqual(M.parseBackupPayload('x'.repeat(1000001)), { error: '备份文件太大' });
});

test('错误类型的导入设置不会覆盖当前设置', () => {
  const parsed = M.parseBackupPayload(JSON.stringify({
    sites: [{ domain: 'good.example.com' }],
    settings: []
  }));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.settings, null);
});
