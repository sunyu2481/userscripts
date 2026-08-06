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
  return { ...DEFAULT_SETTINGS, ...readValue(KEY_SETTINGS, {}) };
}

function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
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
  return readValue(KEY_RESULTS, {});
}

function saveResults(results) {
  writeValue(KEY_RESULTS, results);
}

function getRunState() {
  return readValue(KEY_RUN, { running: false });
}

function saveRunState(state) {
  writeValue(KEY_RUN, state);
}

function getJob() {
  return readValue(KEY_JOB, null);
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
  return readValue(KEY_FOCUS, null);
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
