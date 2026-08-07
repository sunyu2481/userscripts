// ===== 存储层：GM_* 封装 =====
const KEY_SITES = 'userSites';           // 站点列表：只有域名、名称、签到页地址
const KEY_RESULTS = 'checkInResults';    // 本轮结果 { [siteId]: result }
const KEY_RUN = 'checkInRunState';       // 批量运行态（协调者持有）
const KEY_JOB = 'checkInJob';            // 当前派出的任务（工作者读取）
const KEY_LAST = 'lastCheckInTime';
const KEY_SETTINGS = 'settings';
const KEY_FOCUS = 'focusRequest';        // 请求某个站点标签页自我聚焦

const DEFAULT_SETTINGS = {
  gapMinMs: 3000,
  gapMaxMs: 8000,
  siteTimeoutMs: 90000,
  // 默认把标签页留着，方便你核对签到结果，之后用面板一键关闭。
  // 打开这个则签完自动关（需要你处理的仍然保留）。
  autoCloseTab: false,
  extraButtonWords: ''   // 用户自定义的签到按钮关键词，逗号分隔
};

const MAX_GAP_MS = 600000;
const MIN_SITE_TIMEOUT_MS = 5000;
const MAX_SITE_TIMEOUT_MS = 600000;
const MAX_EXTRA_WORDS_LENGTH = 1000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSettingNumber(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeSettings(value) {
  const settings = isRecord(value) ? value : {};
  const gapMinMs = normalizeSettingNumber(
    settings.gapMinMs, DEFAULT_SETTINGS.gapMinMs, 0, MAX_GAP_MS
  );
  const gapMaxMs = Math.max(gapMinMs, normalizeSettingNumber(
    settings.gapMaxMs, DEFAULT_SETTINGS.gapMaxMs, 0, MAX_GAP_MS
  ));

  return {
    gapMinMs,
    gapMaxMs,
    siteTimeoutMs: normalizeSettingNumber(
      settings.siteTimeoutMs,
      DEFAULT_SETTINGS.siteTimeoutMs,
      MIN_SITE_TIMEOUT_MS,
      MAX_SITE_TIMEOUT_MS
    ),
    autoCloseTab: settings.autoCloseTab === true,
    extraButtonWords: String(settings.extraButtonWords || '').trim().slice(0, MAX_EXTRA_WORDS_LENGTH)
  };
}

function readValue(key, fallback) {
  try {
    const raw = GM_getValue(key, null);
    if (raw === null || raw === undefined) return fallback;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return fallback;
  }
}

function writeValue(key, value) {
  GM_setValue(key, JSON.stringify(value));
}

function getSettings() {
  return sanitizeSettings(readValue(KEY_SETTINGS, {}));
}

function saveSettings(patch) {
  const next = sanitizeSettings({ ...getSettings(), ...(isRecord(patch) ? patch : {}) });
  writeValue(KEY_SETTINGS, next);
  return next;
}

function getRawSites() {
  return dedupeSitesByDomain(readValue(KEY_SITES, []));
}

function saveRawSites(sites) {
  writeValue(KEY_SITES, dedupeSitesByDomain(sites));
}

function getSites() {
  return getRawSites().map(buildSiteConfig);
}

function getResults() {
  const results = readValue(KEY_RESULTS, {});
  return isRecord(results) ? results : {};
}

function saveResults(results) {
  writeValue(KEY_RESULTS, results);
}

function getRunState() {
  const state = readValue(KEY_RUN, { running: false });
  return isRecord(state) ? state : { running: false };
}

function saveRunState(state) {
  writeValue(KEY_RUN, state);
}

function getJob() {
  const job = readValue(KEY_JOB, null);
  return isRecord(job) ? job : null;
}

function saveJob(job) {
  writeValue(KEY_JOB, job);
}

function clearJob() {
  writeValue(KEY_JOB, null);
}

function getLastCheckInTime() {
  return readValue(KEY_LAST, null);
}

function saveLastCheckInTime(iso) {
  writeValue(KEY_LAST, iso);
}

// 请求某个域名的标签页把自己切到前台。
// 油猴没有"聚焦已存在标签页"的接口，只能让目标页自己调 window.focus()。
function requestTabFocus(domain) {
  writeValue(KEY_FOCUS, { domain, at: Date.now() });
}

function readFocusRequest() {
  const request = readValue(KEY_FOCUS, null);
  return isRecord(request) ? request : null;
}

function clearFocusRequest() {
  writeValue(KEY_FOCUS, null);
}

// 更新单个站点的字段（如从页面标题学到的站点名）
function patchRawSite(domain, patch) {
  const sites = getRawSites();
  const target = String(domain || '').trim().toLowerCase();
  let changed = false;
  const next = sites.map((site) => {
    if (String(site.domain || '').trim().toLowerCase() !== target) return site;
    for (const [key, value] of Object.entries(patch)) {
      if (site[key] !== value) changed = true;
    }
    return { ...site, ...patch };
  });
  if (changed) saveRawSites(next);
  return changed;
}
