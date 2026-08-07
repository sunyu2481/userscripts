const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');

function loadStorage(initial = {}) {
  const source = fs.readFileSync(path.join(srcDir, '10-storage.js'), 'utf8');
  const values = new Map(Object.entries(initial));
  const factory = new Function('GM_getValue', 'GM_setValue', `
    ${source}
    return {
      sanitizeSettings, getSettings, saveSettings,
      getResults, getRunState, getJob, readFocusRequest,
      MAX_GAP_MS, MIN_SITE_TIMEOUT_MS, MAX_SITE_TIMEOUT_MS, MAX_EXTRA_WORDS_LENGTH
    };
  `);
  const module = factory(
    (key, fallback) => values.has(key) ? values.get(key) : fallback,
    (key, value) => values.set(key, value)
  );
  return { module, values };
}

test('设置坏数据会回落并限制数值范围', () => {
  const { module: M } = loadStorage({
    settings: {
      gapMinMs: -20,
      gapMaxMs: Infinity,
      siteTimeoutMs: '无效',
      autoCloseTab: 'true',
      extraButtonWords: '词'.repeat(2000)
    }
  });

  const settings = M.getSettings();
  assert.equal(settings.gapMinMs, 0);
  assert.equal(settings.gapMaxMs, 8000);
  assert.equal(settings.siteTimeoutMs, 90000);
  assert.equal(settings.autoCloseTab, false);
  assert.equal(settings.extraButtonWords.length, M.MAX_EXTRA_WORDS_LENGTH);
});

test('保存设置只保留已知字段并修正上下界', () => {
  const { module: M } = loadStorage();
  const saved = M.saveSettings({
    gapMinMs: M.MAX_GAP_MS + 1,
    gapMaxMs: 1,
    siteTimeoutMs: 1,
    unknown: '不应保存'
  });

  assert.equal(saved.gapMinMs, M.MAX_GAP_MS);
  assert.equal(saved.gapMaxMs, M.MAX_GAP_MS);
  assert.equal(saved.siteTimeoutMs, M.MIN_SITE_TIMEOUT_MS);
  assert.equal('unknown' in saved, false);
});

test('对象型存储损坏时返回安全默认值', () => {
  const { module: M } = loadStorage({
    checkInResults: [],
    checkInRunState: '坏数据',
    checkInJob: 42,
    focusRequest: []
  });

  assert.deepEqual(M.getResults(), {});
  assert.deepEqual(M.getRunState(), { running: false });
  assert.equal(M.getJob(), null);
  assert.equal(M.readFocusRequest(), null);
});
