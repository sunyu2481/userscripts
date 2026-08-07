// ==UserScript==
// @name         签到助手
// @namespace    https://github.com/sunyu2481/userscripts
// @version      3.0.4
// @description  在页面上找到签到按钮并点击，一次点击依次处理多个站点。不调用任何接口，只代替你点按钮。
// @author       sunyu2481
// @match        https://*/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @noframes
// @updateURL    https://raw.githubusercontent.com/sunyu2481/userscripts/main/dist/api-auto-checkin.user.js
// @downloadURL  https://raw.githubusercontent.com/sunyu2481/userscripts/main/dist/api-auto-checkin.user.js
// ==/UserScript==

// 这个脚本不发任何网络请求：签到请求全部由站点页面自己发出，
// 脚本只是找到按钮、点一下，然后读页面的反馈。
(function () {
  'use strict';

// ==================================================================
// 源文件: 10-storage.js
// ==================================================================
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

// ==================================================================
// 源文件: 20-site.js
// ==================================================================
// ===== 站点模型 =====
// 脚本不认识"站点类型"，也不知道任何接口地址。
// 一个站点至少需要两件事：去哪个页面，以及怎么称呼它；其余是可选规则。
function dedupeSitesByDomain(sites) {
  if (!Array.isArray(sites)) return [];
  const seen = new Set();
  const deduped = [];
  for (const site of sites) {
    const domain = String(site?.domain || '').trim().toLowerCase();
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    deduped.push({ ...site, domain });
  }
  return deduped;
}

// 配置文案只保存普通文本，不把用户输入当作正则表达式。
function normalizeConfiguredWords(value, maxLength = 40) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
  const words = [];
  for (const item of raw) {
    const word = String(item || '').replace(/\s+/g, ' ').trim();
    if (!word || word.length > maxLength || words.includes(word)) continue;
    words.push(word);
  }
  return words;
}

function buildSiteConfig(site) {
  const domain = site.domain;
  return {
    siteId: domain.replace(/\./g, '_'),
    siteName: site.name || domain,
    domain,
    enabled: site.enabled !== false,
    // 签到页地址：没填就用站点首页，脚本在那个页面上找按钮
    visitUrl: site.pageUrl || `https://${domain}/`,
    // 仅访问模式：打开页面就算完成，不找按钮
    visitOnly: site.visitOnly === true,
    // 配置后只按这些文案找按钮，避免把跳转入口当成签到动作
    buttonWords: normalizeConfiguredWords(site.buttonWords),
    // 某些站点的结果文案不在通用词表里时，用它补充结果判断
    resultWords: normalizeConfiguredWords(site.resultWords),
    // 名称被手动改过，自动获取不再覆盖
    nameLocked: site.nameLocked === true
  };
}

// 解析用户输入的地址，域名和完整路径都留着
function normalizeSiteInput(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
    const isBareHost = parsed.pathname === '/' && !parsed.search && !parsed.hash;
    return {
      domain: parsed.hostname.toLowerCase(),
      pageUrl: isBareHost ? '' : `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`
    };
  } catch (e) {
    return null;
  }
}

function moveSiteInList(sites, fromIndex, toIndex) {
  if (!Array.isArray(sites)) return [];
  const list = sites.slice();
  if (fromIndex < 0 || fromIndex >= list.length) return list;
  if (toIndex < 0 || toIndex >= list.length) return list;
  const [moved] = list.splice(fromIndex, 1);
  list.splice(toIndex, 0, moved);
  return list;
}

// 校验并生成编辑后的站点列表。不直接改存储，方便单独测。
// 返回 { sites } 或 { error }
function buildEditedSite(rawSites, originalDomain, {
  name, url, visitOnly, buttonWords, resultWords
}) {
  const sites = Array.isArray(rawSites) ? rawSites : [];
  const target = String(originalDomain || '').trim().toLowerCase();
  const existing = sites.find(site => String(site.domain || '').toLowerCase() === target);
  if (!existing) return { error: '找不到这个站点' };

  const parsed = normalizeSiteInput(url);
  if (!parsed) return { error: '地址看起来不对' };

  if (parsed.domain !== target &&
      sites.some(site => String(site.domain || '').toLowerCase() === parsed.domain)) {
    return { error: `${parsed.domain} 已经在列表里了` };
  }

  const trimmedName = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (trimmedName.length > 40) return { error: '名称太长了' };

  // 名称留空就回落到域名，同时解除锁定让自动获取重新生效
  const finalName = trimmedName || parsed.domain;
  const nameLocked = trimmedName !== '' && trimmedName !== parsed.domain;

  // 没传这个字段就保持原值，避免调用方漏传时意外改掉模式
  const finalVisitOnly = visitOnly === undefined
    ? existing.visitOnly === true
    : visitOnly === true;
  const finalButtonWords = buttonWords === undefined
    ? normalizeConfiguredWords(existing.buttonWords)
    : normalizeConfiguredWords(buttonWords);
  const finalResultWords = resultWords === undefined
    ? normalizeConfiguredWords(existing.resultWords)
    : normalizeConfiguredWords(resultWords);

  return {
    sites: sites.map(site => String(site.domain || '').toLowerCase() === target
      ? {
        ...site,
        domain: parsed.domain,
        name: finalName,
        nameLocked,
        pageUrl: parsed.pageUrl || '',
        visitOnly: finalVisitOnly,
        buttonWords: finalButtonWords,
        resultWords: finalResultWords
      }
      : site
    )
  };
}

// 站点名是否还可以自动更新：用户手动改过就不再动
function canAutoUpdateName(site) {
  if (!site) return false;
  if (site.nameLocked === true) return false;
  // 名称还是域名时才考虑自动获取
  return !site.name || site.name === site.domain;
}

// 页面标题里常见的功能词。标题形如「签到 - XXX」时，
// 切出来的第一段是功能名而不是站点名，必须排掉。
const PAGE_FUNCTION_WORDS = [
  '签到', '打卡', '领取', '首页', '主页', '登录', '注册', '控制台', '仪表盘',
  '个人中心', '用户中心', '个人设置', '账户', '账号', '我的', '面板', '后台',
  'check-in', 'checkin', 'check in', 'sign in', 'signin', 'sign up', 'login',
  'home', 'dashboard', 'console', 'panel', 'profile', 'account', 'user center',
  'daily', 'reward', 'bonus', 'claim'
];

const PAGE_FUNCTION_PATTERN = new RegExp(
  `^(?:${PAGE_FUNCTION_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
  'i'
);

// 判断一段文字能不能当站点名
function isUsableSiteName(text, domain) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (normalized.length > 40) return false;
  if (normalized.length < 2) return false;
  // 纯功能词不算站点名
  if (PAGE_FUNCTION_PATTERN.test(normalized)) return false;
  // 跟域名一样就没必要存
  if (normalized.toLowerCase() === String(domain || '').toLowerCase()) return false;
  // 纯数字、纯符号不像名字
  if (!/[\p{L}\p{N}]/u.test(normalized)) return false;
  return true;
}

// 从页面标题或元信息取一个像样的站点名。
// meta 里的 og:site_name 最可靠，标题只作兜底且要过滤功能词。
function readSiteNameFromPage(domain) {
  const metaCandidates = [
    document.querySelector('meta[property="og:site_name"]')?.content,
    document.querySelector('meta[name="application-name"]')?.content
  ];
  for (const raw of metaCandidates) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (isUsableSiteName(text, domain)) return text;
  }

  const title = String(document.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;

  // 整个标题就是功能词时直接放弃。必须先判断，否则
  // 「Check-in」会被连字符拆成「Check」而漏过功能词过滤。
  if (PAGE_FUNCTION_PATTERN.test(title)) return null;

  // 标题按分隔符拆开，挑第一个不是功能词的片段。
  // 「签到 - 甲站」取「甲站」，「甲站 - 签到」也取「甲站」。
  // 连字符只在两侧有空格时才当分隔符，避免拆坏 Check-in、Sub2API-Pro 这类词。
  const segments = title
    .split(/\s[|\-–—·•>\/]\s|[|·•》]|[:：]\s?/)
    .map(s => s.trim())
    .filter(Boolean);

  for (const segment of segments) {
    if (PAGE_FUNCTION_PATTERN.test(segment)) continue;
    if (isUsableSiteName(segment, domain)) return segment;
  }

  // 整个标题只有一段且不是功能词时才用它
  return isUsableSiteName(title, domain) ? title : null;
}

// ==================================================================
// 源文件: 30-detect.js
// ==================================================================
// ===== 页面元素识别 =====
// 脚本靠文案在页面上找按钮，不依赖任何站点特定的选择器或接口。

function isVisible(el) {
  try {
    if (!el || !el.getBoundingClientRect) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch (e) {
    return false;
  }
}

// 取控件自身的文案。用 childNodes 只收直接文本，避免把整个容器的
// 后代文字都算进来（否则一个大 div 会因为内部有"签到"字样而被误判成按钮）
function getOwnText(el) {
  if (!el) return '';
  const aria = el.getAttribute?.('aria-label');
  if (aria) return String(aria).replace(/\s+/g, ' ').trim();
  if (el.value && (el.tagName === 'INPUT' || el.tagName === 'BUTTON')) {
    return String(el.value).replace(/\s+/g, ' ').trim();
  }
  const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  return text;
}

// ===== 签到按钮文案 =====
const CHECKIN_WORDS = [
  '立即签到', '现在签到', '每日签到', '每天签到', '今日签到', '签到领取', '点击签到',
  '签到打卡', '打卡签到', '每日打卡', '免费领取', '领取奖励', '领取额度', '每日领取',
  '今日领取', '每日福利', '今日福利', '每日奖励', '每日红包', '签到', '打卡', '领取',
  // 转盘/抽奖式签到。不收「开始」这种太泛的词——「开始使用」之类会误伤，
  // 真需要就在设置里补
  '开始转动', '开始抽奖', '开始抽取', '开始旋转', '点击抽奖', '立即抽奖',
  '免费抽奖', '点击转动', '抽奖', '转盘', '试试运气', '碰碰运气',
  'check in now', 'daily check-in', 'daily checkin', 'daily check in',
  'daily reward', 'daily bonus', 'claim reward', 'claim daily', 'claim bonus',
  'check-in', 'checkin', 'check in', 'sign in daily', 'daily sign',
  'claim', 'redeem daily',
  // draw 单独一个词太容易误伤（drawer、drawing board），只收组合
  'spin', 'lucky draw', 'start spin', 'try your luck', 'spin now'
];

// 已签到的状态文案
const ALREADY_WORDS = [
  '已签到', '已经签到', '已签过', '今日已签', '今天已签', '已完成签到', '重复签到',
  '已打卡', '今日已打卡', '已领取', '今日已领取', '已领', '明日再来', '明天再来',
  'already checked', 'already signed', 'already claimed', 'checked in',
  'come back tomorrow', 'claimed today'
];

// 看着像签到但其实是设置项、说明文字的，要排掉
const NOT_CHECKIN_WORDS = [
  '签到设置', '签到配置', '签到规则', '签到说明', '签到记录', '签到历史', '签到统计',
  '签到日志', '签到额度', '连续签到', '签到排行', '开启签到', '启用签到', '关闭签到',
  'check-in settings', 'checkin settings', 'check-in rules', 'check-in history',
  'check-in log', 'check-in quota', 'enable check', 'minimum check', 'maximum check'
];

function buildWordPattern(words) {
  const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'i');
}

const CHECKIN_PATTERN = buildWordPattern(CHECKIN_WORDS);
const ALREADY_PATTERN = buildWordPattern(ALREADY_WORDS);
const NOT_CHECKIN_PATTERN = buildWordPattern(NOT_CHECKIN_WORDS);

// 用户可以在设置里补充自己站点的按钮文案
function getExtraButtonPattern() {
  const raw = String(getSettings().extraButtonWords || '').trim();
  if (!raw) return null;
  const words = raw.split(/[,，\n]/).map(w => w.trim()).filter(Boolean);
  if (words.length === 0) return null;
  try {
    return buildWordPattern(words);
  } catch (e) {
    return null;
  }
}

function normalizeButtonWords(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
  return [...new Set(raw.map(word => String(word || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))];
}

function looksLikeCheckInText(text, extraPattern = null, buttonWords = null) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 24) return false;   // 按钮文案不会很长
  if (NOT_CHECKIN_PATTERN.test(normalized)) return false;
  if (ALREADY_PATTERN.test(normalized)) return false;
  if (buttonWords?.length) return buttonWords.includes(normalized);
  if (extraPattern?.test(normalized)) return true;
  return CHECKIN_PATTERN.test(normalized);
}

function looksLikeAlreadyText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 40) return false;
  if (NOT_CHECKIN_PATTERN.test(normalized)) return false;
  return ALREADY_PATTERN.test(normalized);
}

// 动作进行中的文案。命中这些说明按钮只是暂时禁用，不代表今日已签。
// 转盘/抽奖类签到会转几秒，期间按钮置灰且文案常变成"转动中"。
const IN_PROGRESS_PATTERN = new RegExp([
  'loading', '加载', '处理中', '请稍候', '请稍等', '稍等',
  '签到中', '提交中', '领取中', '转动中', '抽奖中', '抽取中', '旋转中',
  '进行中', '正在', 'spinning', 'drawing', 'processing', 'submitting',
  'wait', '\\.\\.\\.', '…'
].join('|'), 'i');

// 文案越精确优先级越高，避免点到"签到记录"这类次要控件
function getCheckInPriority(text) {
  const t = String(text || '').trim();
  if (/^(签到|打卡|领取|check.?in|claim)$/i.test(t)) return 0;
  if (/立即签到|现在签到|点击签到|check in now/i.test(t)) return 1;
  if (/每日签到|每天签到|今日签到|daily check|daily sign/i.test(t)) return 2;
  if (/领取奖励|领取额度|免费领取|claim reward|claim bonus|daily reward/i.test(t)) return 3;
  return 4;
}

// ===== 可点击元素 =====
const CLICKABLE_SELECTOR = [
  'button',
  'a',
  '[role="button"]',
  'input[type="button"]',
  'input[type="submit"]',
  '[onclick]',
  '[data-slot="button"]',
  '[class*="btn" i]',
  '[class*="button" i]',
  '[class*="cursor-pointer"]',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

function isDisabled(el) {
  if (!el) return false;
  if (el.disabled === true) return true;
  if (el.getAttribute?.('aria-disabled') === 'true') return true;
  if (el.classList?.contains('disabled')) return true;
  if (el.closest?.('[disabled], [aria-disabled="true"]')) return true;
  try {
    // 视觉上禁用的按钮往往靠 pointer-events 或半透明表达
    const style = window.getComputedStyle(el);
    if (style.pointerEvents === 'none') return true;
    if (style.cursor === 'not-allowed') return true;
    if (Number(style.opacity) > 0 && Number(style.opacity) < 0.5) return true;
  } catch (e) { /* 取不到样式就不当禁用 */ }
  return false;
}

// 找签到按钮：遍历所有可点击元素，按文案匹配再按优先级排序
function findCheckInButton(buttonWords = null) {
  const configuredWords = normalizeButtonWords(buttonWords);
  const extraPattern = configuredWords.length ? null : getExtraButtonPattern();
  const found = [];

  let index = 0;
  for (const el of document.querySelectorAll(CLICKABLE_SELECTOR)) {
    index++;
    const text = getOwnText(el);
    if (!looksLikeCheckInText(text, extraPattern, configuredWords)) continue;
    if (!isVisible(el)) continue;
    if (isDisabled(el)) continue;
    found.push({ el, text, index });
  }

  // 文案在普通元素上、点击响应挂在祖先按钮上的情况
  if (found.length === 0) {
    for (const el of document.querySelectorAll('div, span, p, li, h1, h2, h3, h4, label')) {
      const text = getOwnText(el);
      if (!looksLikeCheckInText(text, extraPattern, configuredWords)) continue;
      if (!isVisible(el)) continue;
      const clickable = el.closest(CLICKABLE_SELECTOR);
      const target = clickable && isVisible(clickable) ? clickable : el;
      if (isDisabled(target)) continue;
      found.push({ el: target, text, index: ++index });
    }
  }

  found.sort((a, b) =>
    getCheckInPriority(a.text) - getCheckInPriority(b.text) || a.index - b.index
  );
  return found[0] || null;
}

// 找"今日已签到"的状态提示
function getAlreadyCheckedInNodes() {
  return document.querySelectorAll(
    'button, a, [role="button"], [role="status"], [aria-live], span, p, div, li, ' +
    'input[type="button"], input[type="submit"], [class*="badge" i], [class*="tag" i], ' +
    '[class*="status" i], [class*="chip" i]'
  );
}

function findAlreadyCheckedIn(ignoredTexts = []) {
  const nodes = getAlreadyCheckedInNodes();
  for (const el of nodes) {
    const text = getOwnText(el);
    if (!looksLikeAlreadyText(text)) continue;
    if (!isVisible(el)) continue;
    if (ignoredTexts.includes(text)) continue;
    return { el, text };
  }
  return null;
}

function listAlreadyCheckedInTexts() {
  const texts = [];
  for (const el of getAlreadyCheckedInNodes()) {
    const text = getOwnText(el);
    if (!looksLikeAlreadyText(text) || !isVisible(el) || texts.includes(text)) continue;
    texts.push(text);
  }
  return texts;
}

// 找被禁用的签到按钮 —— 通常也意味着今天已经签过了
function findDisabledCheckInButton(buttonWords = null) {
  const configuredWords = normalizeButtonWords(buttonWords);
  const extraPattern = configuredWords.length ? null : getExtraButtonPattern();
  for (const el of document.querySelectorAll(CLICKABLE_SELECTOR)) {
    const text = getOwnText(el);
    if (!looksLikeCheckInText(text, extraPattern, configuredWords)) continue;
    if (!isVisible(el)) continue;
    if (!isDisabled(el)) continue;
    // 进行中的状态不算已签：按钮此刻禁用只是因为动作还没完成。
    // 转盘、抽奖这类要转几秒，期间按钮一直是禁用的。
    if (IN_PROGRESS_PATTERN.test(text)) continue;
    return { el, text };
  }
  return null;
}

// 调试用：把页面上的可点击文案列出来，方便你补关键词
function listClickableTexts(limit = 12) {
  const texts = [];
  for (const el of document.querySelectorAll(CLICKABLE_SELECTOR)) {
    if (!isVisible(el)) continue;
    const text = getOwnText(el);
    if (!text || text.length > 24) continue;
    if (!texts.includes(text)) texts.push(text);
    if (texts.length >= limit) break;
  }
  return texts;
}

// ==================================================================
// 源文件: 31-guards.js
// ==================================================================
// ===== 需要停下来的情况 =====
// 人机验证和未登录都不自动处理，交回给你。

const HUMAN_VERIFICATION_PATTERN = new RegExp([
  'Security Check', '安全验证', '人机验证', '身份验证', 'Turnstile', 'captcha',
  '验证码', '请完成验证', 'verify you are human', 'hCaptcha', 'reCAPTCHA',
  'Checking your browser', 'Just a moment', '请稍候.{0,6}正在验证'
].join('|'), 'i');

const HUMAN_VERIFICATION_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="turnstile"]',
  'iframe[src*="google.com/recaptcha"]',
  'iframe[src*="recaptcha.net/recaptcha"]',
  'iframe[src*="hcaptcha.com"]',
  '.cf-turnstile', '.g-recaptcha', '.h-captcha',
  'input[name="cf-turnstile-response"]',
  'textarea[name="g-recaptcha-response"]',
  'textarea[name="h-captcha-response"]'
];

function hasHumanVerification() {
  for (const selector of HUMAN_VERIFICATION_SELECTORS) {
    try {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) return true;
    } catch (e) { /* 选择器不支持时跳过 */ }
  }
  // 文本判断只看可见正文，避免命中隐藏的脚本或模板内容
  const text = String(document.body?.innerText || '').slice(0, 4000);
  return HUMAN_VERIFICATION_PATTERN.test(text);
}

// ===== 登录判断 =====
const LOGIN_ROUTE_PATTERN = /^\/(?:login|signin|sign-in|sign_in|auth|account\/login|user\/login)(?:\/|$)/i;
const LOGIN_TEXT_PATTERN = /请先?登录|需要登录|登录后|尚未登录|未登录|会话已过期|登录已过期|please log ?in|please sign ?in|session expired|unauthorized/i;
const LOGIN_BUTTON_PATTERN = /^(登录|登陆|立即登录|去登录|登录账号|log ?in|sign ?in|sign ?up)$/i;

// 当前页面是不是登录页
function isOnLoginPage() {
  try {
    if (LOGIN_ROUTE_PATTERN.test(location.pathname)) return true;
  } catch (e) { /* 取不到路径就看内容 */ }

  // 有密码框且没有签到按钮，基本可以判定是登录页
  const passwordField = document.querySelector('input[type="password"]');
  if (passwordField && isVisible(passwordField) && !findCheckInButton()) return true;

  return false;
}

// 页面明确提示需要登录
function looksLoggedOut() {
  if (isOnLoginPage()) return true;

  const text = String(document.body?.innerText || '').slice(0, 3000);
  if (LOGIN_TEXT_PATTERN.test(text)) return true;

  // 页面上只有登录按钮、找不到签到按钮，也当作未登录
  for (const el of document.querySelectorAll(CLICKABLE_SELECTOR)) {
    if (!isVisible(el)) continue;
    if (LOGIN_BUTTON_PATTERN.test(getOwnText(el))) {
      return !findCheckInButton();
    }
  }
  return false;
}

// ===== 页面失效 =====
const INVALID_PAGE_PATTERN = /404|页面不存在|页面走丢|not found|页面已删除|站点已关闭|服务已停止|无法访问此?网站|域名过期/i;

function looksLikeInvalidPage() {
  try {
    if (/^chrome-error:|^about:neterror/i.test(location.href)) return true;
  } catch (e) { /* 忽略 */ }

  const title = String(document.title || '');
  if (INVALID_PAGE_PATTERN.test(title)) return true;

  // 正文判断要保守：真实的失效页几乎没有内容，
  // 而正常页面（帮助文档、错误码说明）可能提到"404"却完全可用。
  const text = String(document.body?.innerText || '');
  const compact = text.replace(/\s+/g, '');
  if (compact.length >= 80) return false;
  return INVALID_PAGE_PATTERN.test(text);
}

// ===== 挡住按钮的普通弹窗 =====
const DIALOG_CLOSE_PATTERN = /^(×|✕|✖|x|X|关闭|取消|我知道了|知道了|好的|好|确定|明白|不再提示|下次再说|以后再说|OK|Ok|ok|Close|Dismiss|Got it|Later|Skip)$/i;

// 公告弹窗常常盖住签到按钮，先关掉。人机验证和登录相关的一律不动。
function closeBlockingDialogs(buttonWords = null, resultWords = null) {
  if (hasHumanVerification()) return 0;

  let closed = 0;
  const dialogs = document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], [class*="modal" i], [class*="dialog" i], ' +
    '[class*="popup" i], [class*="overlay" i], [class*="announce" i], [class*="notice" i]'
  );

  for (const dialog of dialogs) {
    if (!isVisible(dialog)) continue;

    const dialogText = String(dialog.innerText || '');
    if (HUMAN_VERIFICATION_PATTERN.test(dialogText)) continue;
    if (LOGIN_TEXT_PATTERN.test(dialogText)) continue;
    // 弹窗里本身有签到按钮时不能关，否则把要点的东西关掉了
    if (CHECKIN_PATTERN.test(dialogText)) continue;
    const configuredWords = normalizeButtonWords(buttonWords);
    if (configuredWords.some(word => dialogText.replace(/\s+/g, ' ').includes(word))) continue;
    // 签到结果弹窗也不能关：转盘/抽奖的结果就在这种弹窗里，
    // 关掉就读不到"恭喜获得 xx"这类结论了
    if (isCheckInOutcomeText(dialogText) || matchesConfiguredResultText(dialogText, { resultWords })) continue;

    for (const control of dialog.querySelectorAll(CLICKABLE_SELECTOR + ', [class*="close" i]')) {
      if (!isVisible(control)) continue;
      if (!DIALOG_CLOSE_PATTERN.test(getOwnText(control))) continue;
      try {
        control.click();
        closed++;
      } catch (e) { /* 关不掉就算了 */ }
      break;
    }
  }
  return closed;
}

// ==================================================================
// 源文件: 40-checkin.js
// ==================================================================
// ===== 签到流程 =====
// 全程只做三件事：等按钮出现 → 点它 → 看页面有什么变化。
// 不拼接任何接口地址，不预设站点类型。

const WAIT_BUTTON_TIMEOUT_MS = 20000;   // 等按钮出现最多 20 秒（SPA 渲染慢）
const WAIT_RESULT_TIMEOUT_MS = 20000;   // 点完等结果最多 20 秒（转盘动画要几秒）
const POLL_MS = 400;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForDomReady() {
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', resolve, { once: true });
    setTimeout(resolve, 12000);
  });
}

// 取出目标地址里的 hash 路由部分，例如 https://a.com/#/checkin → #/checkin
function getTargetHash(url) {
  try {
    const hash = new URL(url).hash;
    // 只认路由型 hash（#/xxx 或 #xxx），纯锚点（#top）不当路由
    return hash && hash.length > 1 ? hash : '';
  } catch (e) {
    return '';
  }
}

// 目标是 hash 路由但当前 hash 不对时，纠正过去并等 SPA 重渲染。
// 这类站点（如 https://a.com/#/checkin）直接打开时，前端偶尔会
// 忽略初始 hash 落在首页，或被登录跳转后把 hash 丢掉。
async function ensureHashRoute(site) {
  const targetHash = getTargetHash(site.visitUrl);
  if (!targetHash) return false;

  let currentHash = '';
  try {
    currentHash = location.hash || '';
  } catch (e) {
    return false;
  }
  if (currentHash === targetHash) return false;

  try {
    location.hash = targetHash;
  } catch (e) {
    return false;
  }

  // hash 变了之后路由会换视图，DOM 整体重建，多给点时间
  await sleep(1500);
  return true;
}

// 页面自己发出的签到请求会被 hook 记下来，用于判断点击后的结果
function takeCapturedResult(site) {
  while (capturedResponses.length > 0) {
    const captured = capturedResponses.shift();
    const verdict = readVerdictFromResponse(captured, site);
    if (verdict) return verdict;
  }
  return null;
}

// 在页面上执行一次签到
async function checkInOnThisPage(site) {
  await waitForDomReady();

  // hash 路由的 SPA 有时会忽略初始 hash 直接落在首页，
  // 或者被登录流程重定向后丢掉 hash。这里纠正一次。
  await ensureHashRoute(site);

  // 给 SPA 一点渲染时间
  await sleep(1200);

  if (looksLikeInvalidPage()) {
    return { status: 'invalid', message: '页面不存在或站点已失效' };
  }
  if (hasHumanVerification()) {
    return { status: 'failed', message: '站点要求人机验证，请手动完成', needsHuman: true };
  }

  closeBlockingDialogs(site.buttonWords, site.resultWords);

  // 仅访问模式：打开页面就算完成。
  // 但落在登录页说明这次访问没真正生效，得让你知道。
  if (site.visitOnly) {
    if (looksLoggedOut()) {
      return { status: 'failed', message: '需要先登录这个站点', needsLogin: true };
    }
    return { status: 'success', message: '已访问页面' };
  }

  // 等按钮出现，同时留意"已签到"和需要登录的情况
  const deadline = Date.now() + WAIT_BUTTON_TIMEOUT_MS;
  const targetHash = getTargetHash(site.visitUrl);
  let button = null;
  let sawLoginHint = false;
  let hashFixes = 0;

  while (Date.now() < deadline) {
    if (hasHumanVerification()) {
      return { status: 'failed', message: '站点要求人机验证，请手动完成', needsHuman: true };
    }

    button = findCheckInButton(site.buttonWords);
    if (button) break;

    // SPA 可能在初始化过程中把 hash 冲掉（例如登录检查后跳回首页），
    // 那样就永远找不到签到按钮。发现偏了就纠正，最多两次避免打转。
    if (targetHash && location.hash !== targetHash && hashFixes < 2) {
      hashFixes++;
      await ensureHashRoute(site);
      continue;
    }

    const already = findAlreadyCheckedIn();
    if (already) {
      return { status: 'already', message: `今日已签到（${already.text}）` };
    }

    const disabled = findDisabledCheckInButton(site.buttonWords);
    if (disabled) {
      return { status: 'already', message: `签到按钮已置灰（${disabled.text}）` };
    }

    // 未登录的判断放宽一点：连续两轮都这么认为才下结论，
    // 避免页面还没渲染完就误报
    if (looksLoggedOut()) {
      if (sawLoginHint) {
        return { status: 'failed', message: '需要先登录这个站点', needsLogin: true };
      }
      sawLoginHint = true;
    } else {
      sawLoginHint = false;
    }

    // 弹窗可能是延迟出现的，每轮都试着关一下
    closeBlockingDialogs(site.buttonWords, site.resultWords);
    await sleep(POLL_MS);
  }

  if (!button) {
    // 最后再确认一次是否其实已经签过
    const already = findAlreadyCheckedIn();
    if (already) return { status: 'already', message: `今日已签到（${already.text}）` };
    if (looksLoggedOut()) {
      return { status: 'failed', message: '需要先登录这个站点', needsLogin: true };
    }

    const candidates = listClickableTexts();
    return {
      status: 'failed',
      message: '没找到签到按钮',
      candidates,
      hint: candidates.length
        ? `页面上的可点击文案：${candidates.join(' / ')}`
        : '页面上没有可识别的按钮，可能还没加载完或需要登录'
    };
  }

  // 点击前清空已捕获的响应，避免把页面加载时的旧请求当成签到结果
  capturedResponses.length = 0;

  const clickedText = button.text;
  const initialAlreadyTexts = listAlreadyCheckedInTexts();
  const initialToastTexts = listVisibleToastTexts();
  const clicked = clickElement(button.el);
  if (!clicked) {
    return { status: 'failed', message: `点击「${clickedText}」失败` };
  }

  return waitForCheckInOutcome(clickedText, site, {
    initialAlreadyTexts,
    initialToastTexts
  });
}

// 真实点击：先滚动到可见位置，再派发完整的鼠标事件序列。
// 有些前端框架只监听 mousedown/mouseup，光调 click() 不响应。
function clickElement(el) {
  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
  } catch (e) { /* 滚不动就直接点 */ }

  // 每个事件单独派发：某个事件类型构造失败（老浏览器没有 PointerEvent）
  // 不该影响后面的事件，否则框架可能收不到它真正监听的那一个。
  let base = { bubbles: true, cancelable: true, view: window };
  try {
    const rect = el.getBoundingClientRect();
    base.clientX = rect.left + rect.width / 2;
    base.clientY = rect.top + rect.height / 2;
  } catch (e) { /* 拿不到坐标就不带 */ }

  dispatchQuietly(el, 'PointerEvent', 'pointerdown', { ...base, pointerType: 'mouse', isPrimary: true });
  dispatchQuietly(el, 'MouseEvent', 'mousedown', base);
  dispatchQuietly(el, 'PointerEvent', 'pointerup', { ...base, pointerType: 'mouse', isPrimary: true });
  dispatchQuietly(el, 'MouseEvent', 'mouseup', base);

  // el.click() 是最后也是最关键的一步，前面的事件只是补足框架可能监听的时机
  try {
    el.click();
    return true;
  } catch (e) {
    return false;
  }
}

function dispatchQuietly(el, ctorName, type, init) {
  try {
    const Ctor = window[ctorName];
    if (typeof Ctor !== 'function') return false;
    el.dispatchEvent(new Ctor(type, init));
    return true;
  } catch (e) {
    return false;
  }
}

// 点完之后看页面怎么反应
async function waitForCheckInOutcome(clickedText, site = null, baseline = {}) {
  const deadline = Date.now() + WAIT_RESULT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);

    // 页面自己发的请求最可信
    const fromResponse = takeCapturedResult(site);
    if (fromResponse) {
      return { ...fromResponse, clickedText };
    }

    // 其次看页面上冒出来的提示文字（toast、结果弹窗、状态标签）
    const fromToast = readVerdictFromToast(site, baseline.initialToastTexts || []);
    if (fromToast) {
      return { ...fromToast, clickedText };
    }

    // 明确变成"已签到"文案，随时可信
    const already = findAlreadyCheckedIn(baseline.initialAlreadyTexts || []);
    if (already) {
      return { status: 'success', message: `签到成功（${already.text}）`, clickedText };
    }

    if (hasHumanVerification()) {
      return {
        status: 'failed',
        message: '点击后弹出人机验证，请手动完成',
        needsHuman: true,
        clickedText
      };
    }
  }

  // 点了但页面没给出可识别的反馈
  return {
    status: 'unknown',
    message: `已点击「${clickedText}」，但页面没有明确反馈`,
    clickedText
  };
}

// ==================================================================
// 源文件: 41-verdict.js
// ==================================================================
// ===== 判断签到有没有成功 =====
// 两个来源：页面自己发出的请求响应，以及页面上冒出来的提示文字。
// 脚本从不主动发签到请求，只是"偷听"页面的。

const capturedResponses = [];

// hook 必须在 document-start 装，否则抓不到页面早期发出的请求
function installNetworkHooks() {
  const originalFetch = window.fetch;
  const originalOpen = window.XMLHttpRequest?.prototype?.open;
  const originalSend = window.XMLHttpRequest?.prototype?.send;

  function record(url, method, status, text) {
    try {
      if (!url || !text) return;
      // 只留可能与签到有关的请求，避免堆积无关响应
      const path = new URL(String(url), location.origin).pathname.toLowerCase();
      const isCheckInish = isCheckInPath(path);
      const isPost = String(method || 'GET').toUpperCase() === 'POST';
      if (!isCheckInish && !isPost) return;
      if (text.length > 20000) return;

      capturedResponses.push({
        url: String(url), method, status, text, path, isCheckInish
      });
      // 只保留最近若干条，避免长时间停留的页面无限增长
      if (capturedResponses.length > 12) capturedResponses.shift();
    } catch (e) { /* 记录失败不影响页面 */ }
  }

  if (typeof originalFetch === 'function') {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const request = args[0];
        const options = args[1] || {};
        const url = typeof request === 'string' ? request : request?.url;
        const method = String(options.method || request?.method || 'GET');
        if (url) {
          const text = await response.clone().text();
          record(url, method, response.status, text);
        }
      } catch (e) { /* 克隆失败忽略 */ }
      return response;
    };
  }

  if (originalOpen && originalSend) {
    window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__ci = { method, url: String(url || '') };
      return originalOpen.call(this, method, url, ...rest);
    };
    window.XMLHttpRequest.prototype.send = function (...args) {
      try {
        this.addEventListener('load', () => {
          const info = this.__ci || {};
          record(info.url, info.method, this.status, this.responseText || '');
        }, { once: true });
      } catch (e) { /* 忽略 */ }
      return originalSend.apply(this, args);
    };
  }
}

// ===== 提示文案 =====
const SUCCESS_TEXT_PATTERN = /签到成功|打卡成功|领取成功|成功签到|签到完成|奖励已?到账|check.?in success|checked in success|success(?:fully)? claim|claimed success|reward granted|(?:恭喜|幸运).{0,20}(?:获得|抽中|中奖|奖励|到账)|(?:抽中|中奖|已存入|已到账|转到).{0,24}(?:额度|积分|奖励|余额|账户|account|credit|quota|point|token|[$¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:额度|积分|元))|中奖(?:啦|了|!|！)|\+\s*\d+(?:\.\d+)?\s*(?:额度|积分|credits?|points?|tokens?|quota|元|[$¥￥])/i;
const ALREADY_TEXT_PATTERN = /已签到|已经签到|已签过|今日已签|今天已签|重复签到|已打卡|已领取|今日已领取|明日再来|明天再来|次数不足|次数已用|机会已用|今日次数|already check|already sign|already claim|claimed today|come back tomorrow|no (?:more )?(?:draws?|spins?) left/i;
const FAIL_TEXT_PATTERN = /签到失败|领取失败|打卡失败|操作失败|请稍后再试|系统繁忙|失败|错误|异常|余额不足|check.?in fail|failed|error occurred/i;
const LOGIN_TEXT_HINT = /请先?登录|需要登录|登录后|未登录|会话已过期|登录已过期|请重新登录|unauthorized|please log ?in|session expired|token.{0,10}(?:invalid|expired)/i;

function isCheckInPath(path) {
  return /(?:^|[/_-])(?:check[\s_-]*in|signin|sign(?:[/_-]in)?|attendance?|daily|claim|reward|bonus|punch)(?:[/_-]|$)/.test(
    String(path || '').toLowerCase()
  );
}

// 这段文字看着像不像签到结果。用于保护结果弹窗不被当成公告关掉——
// 转盘/抽奖的结论就写在那种弹窗里。
// 注意：本函数在 31-guards.js 里被调用，靠函数声明提升生效（同一个 IIFE）。
function isCheckInOutcomeText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 200) return false;
  return SUCCESS_TEXT_PATTERN.test(normalized) ||
    ALREADY_TEXT_PATTERN.test(normalized);
}

function matchesConfiguredResultText(text, site) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const words = normalizeConfiguredWords(site?.resultWords);
  return words.some(word => normalized.includes(word));
}

function isCheckInResponse(captured) {
  if (captured?.isCheckInish === true) return true;
  const path = String(captured?.path || captured?.url || '').toLowerCase();
  return isCheckInPath(path);
}

// 从响应体里读结论
function readVerdictFromResponse(captured, site = null) {
  if (!captured) return null;

  const data = parseJsonSafely(captured.text);

  // 非 JSON 响应（HTML 之类）不作为签到结论，通常是页面导航
  if (data === null) return null;

  const message = pickMessage(data);

  // 明确的未授权状态
  if (captured.status === 401 || captured.status === 403) {
    if (LOGIN_TEXT_HINT.test(message)) {
      return { status: 'failed', message: message || '登录状态已失效', needsLogin: true };
    }
  }

  const isCheckInish = isCheckInResponse(captured);
  const hasConfiguredResult = matchesConfiguredResultText(message, site);

  // 先看文案里的"已签到"，它比 success 字段更能说明情况
  if (message && ALREADY_TEXT_PATTERN.test(message) && isCheckInish) {
    return { status: 'already', message };
  }

  const succeeded = data?.success === true ||
    data?.status === 'success' ||
    data?.code === 0 ||
    data?.ret === 1 ||
    data?.ok === true;

  // 通用 success/code 字段只有签到相关接口才可信，避免把保存设置、心跳等 POST 当成功
  if (succeeded && isCheckInish) {
    return { status: 'success', message: message || '签到成功' };
  }

  const failed = data?.success === false ||
    data?.code === 1 ||
    (typeof data?.code === 'number' && data.code !== 0) ||
    captured.status >= 400;

  if (failed && message && isCheckInish) {
    if (LOGIN_TEXT_HINT.test(message)) {
      return { status: 'failed', message, needsLogin: true };
    }
    return { status: 'failed', message };
  }

  if (message && (hasConfiguredResult || SUCCESS_TEXT_PATTERN.test(message))) {
    return { status: 'success', message };
  }
  if (message && FAIL_TEXT_PATTERN.test(message) && isCheckInish) {
    return { status: 'failed', message };
  }

  return null;
}

function pickMessage(data) {
  const raw = data?.message ?? data?.msg ?? data?.error ?? data?.detail ?? data?.info;
  if (typeof raw === 'string') return raw.replace(/\s+/g, ' ').trim();
  if (raw && typeof raw === 'object') return JSON.stringify(raw).slice(0, 160);
  if (typeof data?.data === 'string') return data.data.replace(/\s+/g, ' ').trim();
  return '';
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// 从页面新冒出来的提示文字里读结论（toast / message / alert）
const TOAST_SELECTOR = [
  '[class*="toast" i]', '[class*="message" i]', '[class*="notification" i]',
  '[class*="notify" i]', '[class*="alert" i]', '[class*="snackbar" i]',
  '[role="alert"]', '[role="status"]', '[aria-live="polite"]', '[aria-live="assertive"]'
].join(', ');

function listVisibleToastTexts() {
  const texts = [];
  for (const el of document.querySelectorAll(TOAST_SELECTOR)) {
    if (!isVisible(el)) continue;
    const text = String(el.innerText || '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 120 && !texts.includes(text)) texts.push(text);
  }
  return texts;
}

function readVerdictFromToast(site = null, ignoredTexts = []) {
  for (const el of document.querySelectorAll(TOAST_SELECTOR)) {
    if (!isVisible(el)) continue;
    const text = String(el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 120) continue;
    if (ignoredTexts.includes(text)) continue;

    if (ALREADY_TEXT_PATTERN.test(text)) return { status: 'already', message: text };
    if (matchesConfiguredResultText(text, site) || SUCCESS_TEXT_PATTERN.test(text)) {
      return { status: 'success', message: text };
    }
    if (LOGIN_TEXT_HINT.test(text)) return { status: 'failed', message: text, needsLogin: true };
    if (FAIL_TEXT_PATTERN.test(text)) return { status: 'failed', message: text };
  }
  return null;
}

// ==================================================================
// 源文件: 50-worker.js
// ==================================================================
// ===== 工作者：在被打开的站点页面上跑一次签到 =====
async function runWorker(job) {
  const site = job.site;
  reportResult(site.siteId, { status: 'checking', message: '签到中', siteName: site.siteName });

  try {
    const result = await checkInOnThisPage(site);

    // 站点名没被手动改过时，顺手从页面学一个
    const raw = getRawSites().find(s => s.domain === site.domain);
    if (canAutoUpdateName(raw)) {
      const name = readSiteNameFromPage(site.domain);
      if (name) {
        patchRawSite(site.domain, { name });
        result.siteName = name;
      }
    }
    result.siteName = result.siteName || site.siteName;

    reportResult(site.siteId, result);

    // 需要你亲自处理时，这个标签页会被保留下来。
    // 在页面上直接说明要做什么，并等你从面板点"切过来"。
    if (result.needsHuman || result.needsLogin) {
      showWorkerNotice(result);
    }
  } catch (error) {
    reportResult(site.siteId, {
      status: 'failed',
      message: error?.message || '签到过程出错',
      siteName: site.siteName
    });
  }
}

// 在被保留的标签页上显示一条提示，说明卡在哪一步
function showWorkerNotice(result) {
  const text = result.needsHuman
    ? '签到助手：请完成页面上的人机验证，然后手动点一次签到'
    : '签到助手：请先登录，登录后回签到面板点 ↻ 重试这个站点';
  showStickyNotice(text);
}

function reportResult(siteId, result) {
  const results = getResults();
  results[siteId] = { ...result, at: Date.now() };
  saveResults(results);
}

// ==================================================================
// 源文件: 52-focus.js
// ==================================================================
// ===== 自我聚焦 =====
// 油猴没有"把某个已存在的标签页切到前台"的接口：GM_openInTab 只会新开一个。
// 所以改由目标标签页自己响应——它还活着，能调 window.focus()。
// 协调者往存储写一条请求，目标页收到就把自己切到前台。

const FOCUS_REQUEST_TTL_MS = 15000;

function isFocusRequestForMe(request, host, now = Date.now()) {
  if (!request?.domain) return false;
  if (request.domain !== host) return false;
  // 过期请求不响应，避免刷新页面时被历史请求带到前台
  return now - Number(request.at || 0) <= FOCUS_REQUEST_TTL_MS;
}

function focusSelf() {
  try {
    window.focus();
  } catch (e) { /* 被浏览器策略拦下也没别的办法 */ }

  // 部分浏览器要求页面可见才允许 focus，闪一下标题提示你手动切
  try {
    blinkTitle();
  } catch (e) { /* 标题改不了就算了 */ }
}

let blinkTimer = null;

// 标题闪烁：即便 focus 被拦，你也能在标签栏一眼看到是哪个页面在等你
function blinkTitle(times = 10) {
  if (blinkTimer) return;
  const original = document.title;
  let count = 0;
  blinkTimer = setInterval(() => {
    document.title = count % 2 === 0 ? '⚠ 需要你处理' : original;
    count++;
    if (count >= times * 2) {
      clearInterval(blinkTimer);
      blinkTimer = null;
      document.title = original;
    }
  }, 700);
}

// 站点页面持续监听聚焦请求。签到结束后也要保持监听，
// 因为你可能过一会儿才点面板里那个链接。
function watchFocusRequests(host) {
  // 装监听前先看有没有刚发出的请求
  const pending = readFocusRequest();
  if (isFocusRequestForMe(pending, host)) {
    clearFocusRequest();
    focusSelf();
  }

  try {
    GM_addValueChangeListener(KEY_FOCUS, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      let request = null;
      try {
        request = typeof newValue === 'string' ? JSON.parse(newValue) : newValue;
      } catch (e) {
        return;
      }
      if (!isFocusRequestForMe(request, host)) return;
      clearFocusRequest();
      focusSelf();
    });
  } catch (e) { /* 不支持监听时退化为无法聚焦 */ }
}

// ==================================================================
// 源文件: 60-coordinator.js
// ==================================================================
// ===== 协调者：逐个开后台标签页，收结果 =====
// 只在你点"开始签到"的那个页面运行。

let coordinatorAborted = false;

// 本轮开过的标签页。GM_openInTab 返回的句柄是活对象，
// 存不进 GM_setValue，只能留在协调者页面的内存里。
// 代价是刷新协调者页面后就没法一键关闭了，只能手动关。
const openedTabs = new Map();

function rememberOpenedTab(siteId, siteName, handle) {
  openedTabs.set(siteId, { siteName, handle, at: Date.now() });
}

function closeRememberedTab(siteId) {
  const entry = openedTabs.get(siteId);
  if (!entry) return false;
  openedTabs.delete(siteId);
  try {
    entry.handle.close();
    return true;
  } catch (e) {
    return false;   // 你已经手动关了
  }
}

function getOpenedTabCount() {
  return openedTabs.size;
}

// 关掉本轮开的全部标签页
function closeAllOpenedTabs() {
  let closed = 0;
  for (const siteId of [...openedTabs.keys()]) {
    if (closeRememberedTab(siteId)) closed++;
  }
  return closed;
}

// 需要你亲自处理的标签页不该被自动关掉
function shouldKeepTabOpen(result) {
  return result?.needsHuman === true || result?.needsLogin === true;
}

function pickGap(settings) {
  const min = Math.max(0, Number(settings.gapMinMs) || 0);
  const max = Math.max(min, Number(settings.gapMaxMs) || min);
  return min + Math.random() * (max - min);
}

// 任务有效期：协调者派出任务后，新标签页应当在这段时间内加载并认领。
// 超出就不认，避免陈旧任务被无关的页面导航捡走。
const JOB_CLAIM_WINDOW_MS = 30000;

function isJobFresh(job, host, now = Date.now()) {
  if (!job?.site?.domain) return false;
  if (job.site.domain !== host) return false;
  if (job.claimedAt) return false;   // 已经被认领过，不再重复
  const assignedAt = Number(job.assignedAt || 0);
  if (!assignedAt) return false;
  return now - assignedAt <= JOB_CLAIM_WINDOW_MS;
}

// 等某个站点的结果写入，或超时
function waitForSiteResult(siteId, timeoutMs) {
  return new Promise((resolve) => {
    let listenerId = null;
    let timer = null;

    function finish(result) {
      if (listenerId !== null) {
        try { GM_removeValueChangeListener(listenerId); } catch (e) { /* 已移除 */ }
        listenerId = null;
      }
      if (timer) clearTimeout(timer);
      resolve(result);
    }

    // 先查一次，避免结果早于监听写入
    const existing = getResults()[siteId];
    if (existing && existing.status !== 'checking') {
      finish(existing);
      return;
    }

    listenerId = GM_addValueChangeListener(KEY_RESULTS, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      let parsed = null;
      try {
        parsed = typeof newValue === 'string' ? JSON.parse(newValue) : newValue;
      } catch (e) {
        return;
      }
      const result = parsed?.[siteId];
      if (result && result.status !== 'checking') finish(result);
    });

    timer = setTimeout(() => {
      finish({ status: 'failed', message: '处理超时，站点可能加载太慢' });
    }, timeoutMs);
  });
}

async function runBatchCheckIn(siteIds = null) {
  const settings = getSettings();
  const targets = getSites().filter(site =>
    site.enabled && (!siteIds || siteIds.includes(site.siteId))
  );

  if (targets.length === 0) {
    showToast(siteIds ? '这个站点已被禁用' : '没有启用的站点');
    return;
  }

  coordinatorAborted = false;

  // 清空上一轮结果。
  // 单站点重试只清该站点，别抹掉其它站点已有的结果。
  if (siteIds) {
    const kept = getResults();
    for (const siteId of siteIds) delete kept[siteId];
    saveResults(kept);
  } else {
    saveResults({});
  }

  saveRunState({
    running: true,
    total: targets.length,
    current: 0,
    startedAt: new Date().toISOString()
  });
  renderPanel();

  const collected = {};

  for (let index = 0; index < targets.length; index++) {
    if (coordinatorAborted) break;

    const site = targets[index];
    saveRunState({
      running: true,
      total: targets.length,
      current: index + 1,
      currentSiteId: site.siteId,
      startedAt: new Date().toISOString()
    });

    // 任务只在派出后的短时间内有效。这样同域其它已打开的标签页即便
    // 之后发生导航，也不会认领到这个任务、重复签到。
    // 不往 URL 上加任何标记：站点可能用 hash 路由（如 /#/checkin），
    // 动了 URL 就会把路由改坏。
    saveJob({ site, assignedAt: Date.now() });
    renderPanel();

    let handle = null;
    try {
      handle = GM_openInTab(site.visitUrl, {
        active: false,
        insert: true,
        setParent: true
      });
    } catch (e) {
      collected[site.siteId] = { status: 'failed', message: `打开标签页失败: ${e.message}` };
      saveResults({ ...getResults(), ...collected });
      clearJob();
      continue;
    }

    const result = await waitForSiteResult(site.siteId, settings.siteTimeoutMs);
    collected[site.siteId] = result;

    // 默认把标签页留着，让你能自己核对签到结果。
    // 攒下句柄，之后用面板上的「关闭标签页」一次性关掉。
    if (handle) {
      rememberOpenedTab(site.siteId, site.siteName, handle);
    }
    if (settings.autoCloseTab === true && !shouldKeepTabOpen(result)) {
      closeRememberedTab(site.siteId);
    }

    clearJob();
    renderPanel();

    if (index < targets.length - 1 && !coordinatorAborted) {
      await sleep(pickGap(settings));
    }
  }

  clearJob();
  saveLastCheckInTime(new Date().toISOString());
  saveRunState({ running: false, finishedAt: new Date().toISOString() });
  renderPanel();

  const summary = summarizeResults(collected);
  const remaining = getOpenedTabCount();
  showToast(remaining > 0
    ? `${summary.text}。${remaining} 个标签页留着供你核对`
    : summary.text);
}

function abortBatchCheckIn() {
  coordinatorAborted = true;
  clearJob();

  const results = getResults();
  for (const [siteId, result] of Object.entries(results)) {
    if (result?.status === 'checking') {
      results[siteId] = { ...result, status: 'failed', message: '已中断' };
    }
  }
  saveResults(results);
  saveRunState({ running: false, finishedAt: new Date().toISOString() });
  renderPanel();
  showToast('已终止');
}

function summarizeResults(results) {
  const values = Object.values(results || {});
  const success = values.filter(r => r?.status === 'success').length;
  const already = values.filter(r => r?.status === 'already').length;
  const unknown = values.filter(r => r?.status === 'unknown').length;
  const failed = values.filter(r => r?.status === 'failed' || r?.status === 'invalid').length;

  const parts = [];
  if (success) parts.push(`成功 ${success}`);
  if (already) parts.push(`已签 ${already}`);
  if (unknown) parts.push(`待确认 ${unknown}`);
  if (failed) parts.push(`失败 ${failed}`);

  return {
    success, already, unknown, failed,
    text: parts.length ? `签到完成：${parts.join('，')}` : '签到完成'
  };
}

// ==================================================================
// 源文件: 70-ui-style.js
// ==================================================================
// ===== 浮层 UI =====
const PANEL_ID = 'gm-checkin-panel';
const TOAST_ID = 'gm-checkin-toast';
const STYLE_ID = 'gm-checkin-style';

const PANEL_CSS = `
#${PANEL_ID} {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 320px; max-height: 70vh; overflow: hidden;
  display: flex; flex-direction: column;
  background: #fff; color: #1f2328;
  border: 1px solid #d0d7de; border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,.16);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
#${PANEL_ID} * { box-sizing: border-box; }
#${PANEL_ID} .gm-hd {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; background: #667eea; color: #fff;
  cursor: move; user-select: none;
}
#${PANEL_ID} .gm-hd b { font-size: 13px; font-weight: 600; flex: 1; }
#${PANEL_ID} .gm-hd button {
  background: rgba(255,255,255,.18); color: #fff; border: 0;
  border-radius: 4px; padding: 2px 7px; cursor: pointer; font-size: 12px;
}
#${PANEL_ID} .gm-hd button:hover { background: rgba(255,255,255,.32); }
#${PANEL_ID} .gm-bd { padding: 10px 12px; overflow-y: auto; flex: 1; }
#${PANEL_ID} .gm-actions { display: flex; gap: 6px; margin-bottom: 10px; }
#${PANEL_ID} .gm-btn {
  flex: 1; padding: 7px 8px; border-radius: 6px; border: 1px solid #d0d7de;
  background: #f6f8fa; cursor: pointer; font-size: 12px; color: #1f2328;
}
#${PANEL_ID} .gm-btn:hover:not(:disabled) { background: #eef1f4; }
#${PANEL_ID} .gm-btn:disabled { opacity: .5; cursor: not-allowed; }
#${PANEL_ID} .gm-btn.primary {
  background: #667eea; border-color: #667eea; color: #fff; font-weight: 500;
}
#${PANEL_ID} .gm-btn.primary:hover:not(:disabled) { background: #5a6fd8; }
#${PANEL_ID} .gm-btn.danger { background: #fff1f0; border-color: #ffccc7; color: #cf1322; }
#${PANEL_ID} .gm-progress {
  margin-bottom: 8px; padding: 6px 8px; border-radius: 6px;
  background: #eef2ff; color: #3730a3; font-size: 12px;
}
#${PANEL_ID} .gm-site {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 0; border-bottom: 1px solid #f0f2f4;
}
#${PANEL_ID} .gm-site:last-child { border-bottom: 0; }
#${PANEL_ID} .gm-site input[type="checkbox"] { cursor: pointer; flex: none; }
#${PANEL_ID} .gm-site .gm-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: pointer; color: #0969da;
}
#${PANEL_ID} .gm-site .gm-name:hover { text-decoration: underline; }
#${PANEL_ID} .gm-site .gm-name.off { color: #8c959f; }
#${PANEL_ID} .gm-badge {
  flex: none; padding: 1px 6px; border-radius: 10px; font-size: 11px; white-space: nowrap;
}
#${PANEL_ID} .gm-badge.success { background: #dafbe1; color: #1a7f37; }
#${PANEL_ID} .gm-badge.already { background: #ddf4ff; color: #0969da; }
#${PANEL_ID} .gm-badge.failed { background: #ffebe9; color: #cf222e; }
#${PANEL_ID} .gm-badge.invalid { background: #fff1e5; color: #bc4c00; }
#${PANEL_ID} .gm-badge.checking { background: #fff8c5; color: #7d4e00; }
#${PANEL_ID} .gm-mode {
  flex: none; padding: 1px 5px; border-radius: 3px; font-size: 10px;
  background: #f0f2f4; color: #57606a; white-space: nowrap;
}
#${PANEL_ID} .gm-del {
  flex: none; border: 0; background: transparent; color: #8c959f;
  cursor: pointer; font-size: 14px; padding: 0 2px; line-height: 1;
}
#${PANEL_ID} .gm-del:hover { color: #cf222e; }
#${PANEL_ID} .gm-msg {
  font-size: 11px; color: #57606a; padding: 0 0 6px 24px;
  word-break: break-all; border-bottom: 1px solid #f0f2f4;
}
#${PANEL_ID} .gm-empty { color: #8c959f; text-align: center; padding: 18px 0; }
#${PANEL_ID} .gm-row { display: flex; gap: 6px; margin-bottom: 8px; }
#${PANEL_ID} .gm-row input[type="text"] {
  flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid #d0d7de;
  border-radius: 6px; font-size: 12px; color: #1f2328; background: #fff;
}
#${PANEL_ID} .gm-row label {
  display: flex; align-items: center; gap: 4px; font-size: 12px;
  color: #57606a; white-space: nowrap;
}
#${PANEL_ID} .gm-sec {
  margin-top: 10px; padding-top: 8px; border-top: 1px solid #f0f2f4;
  font-size: 12px; color: #57606a;
}
#${PANEL_ID} .gm-sec-hd {
  font-weight: 600; color: #1f2328; margin-bottom: 6px;
  cursor: pointer; user-select: none;
}
#${PANEL_ID} .gm-gap { display: flex; align-items: center; gap: 6px; }
#${PANEL_ID} .gm-gap input[type="number"] {
  width: 58px; padding: 4px 6px; border: 1px solid #d0d7de;
  border-radius: 4px; font-size: 12px; color: #1f2328; background: #fff;
}
#${PANEL_ID}.collapsed .gm-bd { display: none; }
#${TOAST_ID} {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483001;
  max-width: 320px; padding: 10px 14px; border-radius: 8px;
  background: rgba(31,35,40,.94); color: #fff;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  box-shadow: 0 6px 18px rgba(0,0,0,.22);
}
@media (prefers-color-scheme: dark) {
  #${PANEL_ID} { background: #1c2128; color: #e6edf3; border-color: #30363d; }
  #${PANEL_ID} .gm-btn { background: #21262d; border-color: #30363d; color: #e6edf3; }
  #${PANEL_ID} .gm-btn:hover:not(:disabled) { background: #30363d; }
  #${PANEL_ID} .gm-progress { background: #1f2b4d; color: #a5b4fc; }
  #${PANEL_ID} .gm-site, #${PANEL_ID} .gm-msg { border-color: #21262d; }
  #${PANEL_ID} .gm-sec, #${PANEL_ID} .gm-sec { border-color: #21262d; }
  #${PANEL_ID} .gm-row input[type="text"],
  #${PANEL_ID} .gm-gap input[type="number"] {
    background: #0d1117; border-color: #30363d; color: #e6edf3;
  }
  #${PANEL_ID} .gm-mode { background: #21262d; color: #8b949e; }
}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  (document.head || document.documentElement).appendChild(style);
}

let toastTimer = null;

function showToast(message, duration = 3200) {
  injectStyle();
  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.cursor = 'default';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), duration);
}

// 需要你处理时用这个：不自动消失，点一下才关。
// 比定时消失的提示可靠——你可能过一会儿才切过来看。
function showStickyNotice(message) {
  injectStyle();
  document.getElementById(TOAST_ID)?.remove();
  if (toastTimer) clearTimeout(toastTimer);

  const notice = document.createElement('div');
  notice.id = TOAST_ID;
  notice.style.cssText = 'cursor:pointer;max-width:360px;background:rgba(191,54,12,.96)';
  notice.textContent = `${message}（点此关闭）`;
  notice.addEventListener('click', () => notice.remove());
  document.body.appendChild(notice);
}

// ==================================================================
// 源文件: 71-ui-panel.js
// ==================================================================
// ===== 面板渲染 =====
let panelVisible = false;
let settingsExpanded = false;

const STATUS_LABEL = {
  success: '成功',
  already: '已签',
  failed: '失败',
  invalid: '失效',
  unknown: '待确认',
  checking: '签到中'
};

function ensurePanel() {
  injectStyle();
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="gm-hd">
      <b>签到助手</b>
      <button data-act="collapse" title="折叠">−</button>
      <button data-act="hide" title="隐藏">×</button>
    </div>
    <div class="gm-bd"></div>
  `;
  document.body.appendChild(panel);

  panel.querySelector('[data-act="hide"]').addEventListener('click', () => togglePanel(false));
  panel.querySelector('[data-act="collapse"]').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });

  makeDraggable(panel, panel.querySelector('.gm-hd'));
  return panel;
}

function makeDraggable(panel, handle) {
  let startX = 0, startY = 0, originLeft = 0, originTop = 0, dragging = false;

  handle.addEventListener('mousedown', (event) => {
    if (event.target.tagName === 'BUTTON') return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    startX = event.clientX;
    startY = event.clientY;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${originLeft}px`;
    panel.style.top = `${originTop}px`;
    event.preventDefault();
  });

  document.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, originLeft + event.clientX - startX))}px`;
    panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, originTop + event.clientY - startY))}px`;
  });

  document.addEventListener('mouseup', () => { dragging = false; });
}

function togglePanel(visible) {
  panelVisible = visible === undefined ? !panelVisible : visible;
  if (!panelVisible) {
    document.getElementById(PANEL_ID)?.remove();
    return;
  }
  renderPanel();
}

function renderPanel() {
  if (!panelVisible) return;
  const panel = ensurePanel();
  const body = panel.querySelector('.gm-bd');
  const sites = getSites();
  const results = getResults();
  const runState = getRunState();
  const running = runState.running === true;
  const enabledCount = sites.filter(s => s.enabled).length;

  const parts = [];

  if (running) {
    const current = sites.find(s => s.siteId === runState.currentSiteId);
    parts.push(`<div class="gm-progress">进度 ${runState.current || 0}/${runState.total || 0}${
      current ? ` · ${escapeHtml(current.siteName)}` : ''
    }</div>`);
  }

  const openedTabCount = getOpenedTabCount();
  parts.push(`
    <div class="gm-actions">
      <button class="gm-btn primary" data-act="start" ${running || enabledCount === 0 ? 'disabled' : ''}>
        ${running ? '签到中...' : '开始签到'}
      </button>
      ${running ? '<button class="gm-btn danger" data-act="abort">终止</button>' : ''}
      ${!running && openedTabCount > 0
        ? `<button class="gm-btn" data-act="close-tabs">关闭 ${openedTabCount} 个标签页</button>`
        : ''}
    </div>
    <div class="gm-row">
      <input type="text" data-role="new-site" placeholder="签到页地址，如 c.com/#/checkin">
    </div>
    <div class="gm-row">
      <input type="text" data-role="new-name" placeholder="站点名称（可留空）" style="flex:1">
      <label title="只打开页面，不找按钮"><input type="checkbox" data-role="new-visit">仅访问</label>
      <button class="gm-btn" data-act="add" style="flex:none;width:46px">添加</button>
    </div>
  `);

  if (sites.length === 0) {
    parts.push('<div class="gm-empty">先添加一个站点的签到页地址</div>');
  } else {
    for (const site of sites) {
      const result = results[site.siteId];
      const status = result?.status;
      const badge = status ? `<span class="gm-badge ${status}">${STATUS_LABEL[status] || status}</span>` : '';

      parts.push(`
        <div class="gm-site" data-site="${escapeHtml(site.siteId)}">
          <input type="checkbox" data-act="toggle" ${site.enabled ? 'checked' : ''} title="启用/禁用">
          <span class="gm-name ${site.enabled ? '' : 'off'}" data-act="open" title="${escapeHtml(site.visitUrl)}">
            ${escapeHtml(site.siteName)}
          </span>
          ${site.visitOnly ? '<span class="gm-mode" title="仅访问，不点按钮">仅访问</span>' : ''}
          ${badge}
          <button class="gm-del" data-act="retry" title="只签这个">↻</button>
          <button class="gm-del" data-act="edit" title="改名称和地址">✎</button>
          <button class="gm-del" data-act="remove" title="删除">×</button>
        </div>
      `);

      // 需要你处理或没成功的情况才展开说明
      if (result?.message && status !== 'success' && status !== 'already' && status !== 'checking') {
        const hint = result.hint ? `<br><span style="opacity:.75">${escapeHtml(result.hint)}</span>` : '';
        const action = buildResultAction(result);
        parts.push(`<div class="gm-msg">${escapeHtml(result.message)}${hint}${action}</div>`);
      }
    }
  }

  const settings = getSettings();
  parts.push(`
    <div class="gm-sec">
      <div class="gm-sec-hd" data-act="toggle-settings">${settingsExpanded ? '▾' : '▸'} 设置与备份</div>
      ${settingsExpanded ? `
        <div class="gm-gap" style="margin-bottom:8px">
          站点间隔
          <input type="number" data-role="gap-min" value="${Math.round(settings.gapMinMs / 1000)}" min="0" max="600"> -
          <input type="number" data-role="gap-max" value="${Math.round(settings.gapMaxMs / 1000)}" min="0" max="600"> 秒
        </div>
        <div style="margin-bottom:8px">
          <div style="margin-bottom:4px">补充签到按钮文案（逗号分隔）</div>
          <input type="text" data-role="extra-words" value="${escapeHtml(settings.extraButtonWords)}"
                 placeholder="如 每日礼包, 点我领取" style="width:100%">
        </div>
        <label style="display:flex;gap:5px;align-items:center;margin-bottom:4px">
          <input type="checkbox" data-role="auto-close" ${settings.autoCloseTab ? 'checked' : ''}>
          签完自动关闭标签页
        </label>
        <div style="margin:0 0 8px 20px;font-size:11px;opacity:.65">
          默认留着，方便核对结果。需要你处理的标签页始终保留。
        </div>
        <div class="gm-actions">
          <button class="gm-btn" data-act="export">导出</button>
          <button class="gm-btn" data-act="import">导入</button>
        </div>
      ` : ''}
    </div>
  `);

  body.innerHTML = parts.join('');
  bindPanelEvents(panel, body);
}

// 失败结果给一个可操作的出口
function buildResultAction(result) {
  if (result.needsHuman) {
    return '<br><a href="#" data-act="focus-tab" style="color:#0969da">切到那个标签页完成验证 →</a>';
  }
  if (result.needsLogin) {
    return '<br><a href="#" data-act="focus-tab" style="color:#0969da">切到那个标签页登录 →</a>';
  }
  if (Array.isArray(result.candidates) && result.candidates.length > 0) {
    return '<br><a href="#" data-act="teach" style="color:#0969da">按钮文案不对？点这里补充 →</a>';
  }
  return '';
}

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// ==================================================================
// 源文件: 72-ui-events.js
// ==================================================================
// ===== 面板事件 =====
function bindPanelEvents(panel, body) {
  body.querySelector('[data-act="start"]')?.addEventListener('click', () => {
    runBatchCheckIn().catch(error => showToast(`出错了: ${error.message}`));
  });

  body.querySelector('[data-act="abort"]')?.addEventListener('click', abortBatchCheckIn);

  function submitNewSite() {
    handleAddSite(
      body.querySelector('[data-role="new-site"]')?.value,
      body.querySelector('[data-role="new-visit"]')?.checked === true,
      body.querySelector('[data-role="new-name"]')?.value
    );
  }

  body.querySelector('[data-act="add"]')?.addEventListener('click', submitNewSite);

  for (const role of ['new-site', 'new-name']) {
    body.querySelector(`[data-role="${role}"]`)?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitNewSite();
    });
  }

  body.querySelector('[data-act="toggle-settings"]')?.addEventListener('click', () => {
    settingsExpanded = !settingsExpanded;
    renderPanel();
  });

  body.querySelector('[data-role="gap-min"]')?.addEventListener('change', (event) => {
    saveSettings({ gapMinMs: Math.max(0, Number(event.target.value) || 0) * 1000 });
    renderPanel();
  });

  body.querySelector('[data-role="gap-max"]')?.addEventListener('change', (event) => {
    saveSettings({ gapMaxMs: Math.max(0, Number(event.target.value) || 0) * 1000 });
    renderPanel();
  });

  body.querySelector('[data-role="extra-words"]')?.addEventListener('change', (event) => {
    saveSettings({ extraButtonWords: String(event.target.value || '').trim() });
    showToast('已保存，下次签到生效');
  });

  body.querySelector('[data-role="auto-close"]')?.addEventListener('change', (event) => {
    saveSettings({ autoCloseTab: event.target.checked === true });
  });

  body.querySelector('[data-act="close-tabs"]')?.addEventListener('click', () => {
    const closed = closeAllOpenedTabs();
    showToast(closed > 0 ? `已关闭 ${closed} 个标签页` : '标签页都已经关了');
    renderPanel();
  });

  body.querySelector('[data-act="export"]')?.addEventListener('click', handleExport);
  body.querySelector('[data-act="import"]')?.addEventListener('click', handleImport);

  for (const link of body.querySelectorAll('[data-act="focus-tab"]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const siteId = link.closest('.gm-msg')?.previousElementSibling?.dataset?.site;
      const site = getSites().find(s => s.siteId === siteId);
      if (!site) {
        showToast('找不到对应站点');
        return;
      }
      handleFocusSiteTab(site);
    });
  }

  for (const link of body.querySelectorAll('[data-act="teach"]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const siteId = link.closest('.gm-msg')?.previousElementSibling?.dataset?.site;
      handleTeachButtonWords(siteId);
    });
  }

  for (const row of body.querySelectorAll('.gm-site')) {
    const siteId = row.dataset.site;

    row.querySelector('[data-act="toggle"]')?.addEventListener('change', (event) => {
      const site = getSites().find(s => s.siteId === siteId);
      if (!site) return;
      saveRawSites(getRawSites().map(raw =>
        raw.domain === site.domain ? { ...raw, enabled: event.target.checked } : raw
      ));
      renderPanel();
    });

    row.querySelector('[data-act="open"]')?.addEventListener('click', () => {
      const site = getSites().find(s => s.siteId === siteId);
      if (site) GM_openInTab(site.visitUrl, { active: true, insert: true });
    });

    row.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
      runBatchCheckIn([siteId]).catch(error => showToast(`出错了: ${error.message}`));
    });

    row.querySelector('[data-act="edit"]')?.addEventListener('click', () => handleEditSite(siteId));

    row.querySelector('[data-act="remove"]')?.addEventListener('click', async () => {
      const site = getSites().find(s => s.siteId === siteId);
      if (!site) return;
      if (!await showConfirm(`删除「${site.siteName}」？`)) return;
      saveRawSites(getRawSites().filter(raw => raw.domain !== site.domain));
      const results = getResults();
      delete results[siteId];
      saveResults(results);
      renderPanel();
    });
  }
}

// 切到那个站点的标签页。
// 油猴无法直接聚焦已存在的标签页，只能请它自己切到前台；
// 它已经被关掉时再退回新开一个。
function handleFocusSiteTab(site) {
  requestTabFocus(site.domain);
  showToast(`正在切到 ${site.siteName}`);

  // 给目标页一点时间响应。它若已不在，就没人清掉这条请求，
  // 那时才新开标签页。
  setTimeout(() => {
    const pending = readFocusRequest();
    if (pending?.domain !== site.domain) return;   // 已被响应
    clearFocusRequest();
    GM_openInTab(site.visitUrl, { active: true, insert: true });
    showToast('原标签页已关闭，重新打开了一个');
  }, 700);
}

function handleAddSite(rawInput, visitOnly, name = '') {
  const parsed = normalizeSiteInput(rawInput);
  if (!parsed) {
    showToast('地址看起来不对');
    return;
  }

  const sites = getRawSites();
  if (sites.some(site => site.domain === parsed.domain)) {
    showToast(`${parsed.domain} 已经在列表里了`);
    return;
  }

  const trimmedName = String(name || '').replace(/\s+/g, ' ').trim();
  sites.push({
    domain: parsed.domain,
    name: trimmedName || parsed.domain,
    // 添加时就填了名称，视为手动指定，不再被自动获取覆盖
    nameLocked: trimmedName !== '' && trimmedName !== parsed.domain,
    enabled: true,
    pageUrl: parsed.pageUrl || '',
    visitOnly: visitOnly === true
  });
  saveRawSites(sites);

  for (const role of ['new-site', 'new-name']) {
    const input = document.querySelector(`#${PANEL_ID} [data-role="${role}"]`);
    if (input) input.value = '';
  }
  const visitBox = document.querySelector(`#${PANEL_ID} [data-role="new-visit"]`);
  if (visitBox) visitBox.checked = false;

  showToast(`已添加 ${parsed.domain}`);
  renderPanel();
}

function handleEditSite(siteId) {
  const site = getSites().find(s => s.siteId === siteId);
  if (!site) return;

  showFormDialog(`编辑「${site.siteName}」`, [
    {
      key: 'name',
      label: '站点名称',
      value: site.siteName,
      placeholder: site.domain,
      hint: '留空则用域名。手动改过之后不会再被自动覆盖。'
    },
    {
      key: 'url',
      label: '签到页地址',
      value: site.visitUrl,
      placeholder: `https://${site.domain}/`,
      hint: '脚本会打开这个地址并在页面上找签到按钮'
    },
    {
      key: 'buttonWords',
      label: '签到按钮文案（可选）',
      value: site.buttonWords.join(', '),
      placeholder: '如 立即签',
      hint: '填了以后只精确匹配这里的文案；多个文案用逗号分隔'
    },
    {
      key: 'resultWords',
      label: '成功结果文案（可选）',
      value: site.resultWords.join(', '),
      placeholder: '如 奖励已发放',
      hint: '结果提示不在通用词表时再填，不会主动发请求'
    },
    {
      key: 'visitOnly',
      label: '仅访问（不用点签到按钮）',
      type: 'checkbox',
      value: site.visitOnly,
      hint: '打开页面就算完成。适合每天访问一次即可的站点。'
    }
  ], {
    onConfirm: ({ name, url, buttonWords, resultWords, visitOnly }) => {
      const edited = buildEditedSite(getRawSites(), site.domain, {
        name, url, buttonWords, resultWords, visitOnly
      });
      if (edited.error) {
        showToast(edited.error);
        return false;
      }
      saveRawSites(edited.sites);
      showToast('已更新');
      renderPanel();
      return true;
    }
  });
}

// 没找到按钮时，把页面上的候选文案列出来让你挑
function handleTeachButtonWords(siteId) {
  const result = getResults()[siteId];
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  const current = getSettings().extraButtonWords;

  const listing = candidates.length
    ? `页面上的可点击文案：\n${candidates.map(t => `  ${t}`).join('\n')}\n\n`
    : '';

  showTextDialog('补充签到按钮文案', current, {
    rows: 3,
    hint: `${listing}把签到按钮的文案填进来（逗号分隔），下次就能识别了`,
    onConfirm: (text) => {
      saveSettings({ extraButtonWords: String(text || '').trim() });
      showToast('已保存，重试看看');
      renderPanel();
      return true;
    }
  });
}

// ===== 导入导出 =====
function buildBackupPayload() {
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    sites: getRawSites().map(site => ({
      domain: site.domain,
      name: site.name || site.domain,
      nameLocked: site.nameLocked === true,
      enabled: site.enabled !== false,
      pageUrl: site.pageUrl || '',
      visitOnly: site.visitOnly === true,
      buttonWords: normalizeConfiguredWords(site.buttonWords),
      resultWords: normalizeConfiguredWords(site.resultWords)
    })),
    settings: getSettings()
  };
}

function parseBackupPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: '不是有效的 JSON' };
  }

  const rawSites = Array.isArray(parsed) ? parsed : parsed?.sites;
  if (!Array.isArray(rawSites)) return { error: '找不到站点列表' };

  const sites = [];
  for (const site of rawSites) {
    const domain = String(site?.domain || '').trim().toLowerCase();
    if (!domain || !domain.includes('.')) continue;
    const name = String(site.name || domain);
    sites.push({
      domain,
      name,
      // 旧版备份没有这个字段：名称与域名不同就当作手动指定过，
      // 避免导入后又被页面标题覆盖掉
      nameLocked: site.nameLocked === true || (name !== domain && name !== ''),
      enabled: site.enabled !== false,
      pageUrl: String(site.pageUrl || ''),
      // 兼容旧版扩展导出的 mode 字段
      visitOnly: site.visitOnly === true || site.mode === 'visit',
      buttonWords: normalizeConfiguredWords(site.buttonWords),
      resultWords: normalizeConfiguredWords(site.resultWords)
    });
  }

  if (sites.length === 0) return { error: '没有可导入的站点' };
  return { sites, settings: parsed?.settings || null };
}

function handleExport() {
  showTextDialog('导出配置', JSON.stringify(buildBackupPayload(), null, 2), {
    readOnly: true,
    copyable: true
  });
}

function handleImport() {
  showTextDialog('导入配置', '', {
    hint: '粘贴之前导出的 JSON。扩展版导出的配置也能用。',
    onConfirm: (text) => {
      const parsed = parseBackupPayload(text);
      if (parsed.error) {
        showToast(`导入失败: ${parsed.error}`);
        return false;
      }
      saveRawSites(parsed.sites);
      if (parsed.settings) saveSettings(parsed.settings);
      showToast(`已导入 ${parsed.sites.length} 个站点`);
      renderPanel();
      return true;
    }
  });
}

// ==================================================================
// 源文件: 73-ui-dialog.js
// ==================================================================
// ===== 自定义对话框 =====
// 沿用扩展版约定：不使用原生 confirm / prompt
const DIALOG_ID = 'gm-checkin-dialog';

function removeDialog() {
  document.getElementById(DIALOG_ID)?.remove();
}

function createDialogShell(title) {
  removeDialog();
  injectStyle();

  const overlay = document.createElement('div');
  overlay.id = DIALOG_ID;
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483002;
    background: rgba(0,0,0,.42); display: flex;
    align-items: center; justify-content: center;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    width: min(460px, 92vw); background: #fff; color: #1f2328;
    border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.24);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
    overflow: hidden;
  `;
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    box.style.background = '#1c2128';
    box.style.color = '#e6edf3';
  }

  box.innerHTML = `
    <div style="padding:12px 14px;background:#667eea;color:#fff;font-weight:600">${escapeHtml(title)}</div>
    <div data-role="content" style="padding:14px"></div>
    <div data-role="footer" style="padding:0 14px 14px;display:flex;gap:8px;justify-content:flex-end"></div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) removeDialog();
  });
  document.addEventListener('keydown', function onEsc(event) {
    if (event.key === 'Escape') {
      removeDialog();
      document.removeEventListener('keydown', onEsc);
    }
  });

  return {
    overlay,
    content: box.querySelector('[data-role="content"]'),
    footer: box.querySelector('[data-role="footer"]')
  };
}

function makeDialogButton(label, variant = 'default') {
  const button = document.createElement('button');
  button.textContent = label;
  const isPrimary = variant === 'primary';
  const isDanger = variant === 'danger';
  button.style.cssText = `
    padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px;
    border: 1px solid ${isPrimary ? '#667eea' : isDanger ? '#ffccc7' : '#d0d7de'};
    background: ${isPrimary ? '#667eea' : isDanger ? '#fff1f0' : '#f6f8fa'};
    color: ${isPrimary ? '#fff' : isDanger ? '#cf1322' : '#1f2328'};
  `;
  return button;
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const { content, footer } = createDialogShell('请确认');
    content.textContent = message;

    const cancel = makeDialogButton('取消');
    const ok = makeDialogButton('确定', 'danger');

    cancel.addEventListener('click', () => { removeDialog(); resolve(false); });
    ok.addEventListener('click', () => { removeDialog(); resolve(true); });

    footer.append(cancel, ok);
    ok.focus();
  });
}

// 多字段表单对话框。fields: [{ key, label, value, placeholder, hint, type }]
// onConfirm 收到 { [key]: value }，返回 false 表示校验不通过、保持对话框打开
function showFormDialog(title, fields, options = {}) {
  const { content, footer } = createDialogShell(title);
  const inputs = {};

  const isDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;

  for (const field of fields) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:12px';

    // 复选框把标签和控件放在同一行，读起来更像一句话
    if (field.type === 'checkbox') {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = field.value === true;
      input.style.cssText = 'cursor:pointer;flex:none';
      row.appendChild(input);

      const text = document.createElement('span');
      text.textContent = field.label;
      row.appendChild(text);

      wrap.appendChild(row);
      inputs[field.key] = input;

      if (field.hint) {
        const hint = document.createElement('div');
        hint.textContent = field.hint;
        hint.style.cssText = 'margin-top:4px;margin-left:22px;font-size:11px;opacity:.65';
        wrap.appendChild(hint);
      }

      content.appendChild(wrap);
      continue;
    }

    const label = document.createElement('div');
    label.textContent = field.label;
    label.style.cssText = 'margin-bottom:4px;font-size:12px;font-weight:500';
    wrap.appendChild(label);

    const input = document.createElement('input');
    input.type = field.type || 'text';
    input.value = field.value == null ? '' : String(field.value);
    input.placeholder = field.placeholder || '';
    input.style.cssText = `
      width: 100%; padding: 7px 9px; border-radius: 6px;
      border: 1px solid #d0d7de; font-size: 13px;
      background: #fff; color: #1f2328;
    `;
    if (isDark) {
      input.style.background = '#0d1117';
      input.style.borderColor = '#30363d';
      input.style.color = '#e6edf3';
    }
    wrap.appendChild(input);
    inputs[field.key] = input;

    if (field.hint) {
      const hint = document.createElement('div');
      hint.textContent = field.hint;
      hint.style.cssText = 'margin-top:4px;font-size:11px;opacity:.65';
      wrap.appendChild(hint);
    }

    content.appendChild(wrap);
  }

  function collect() {
    const values = {};
    for (const [key, input] of Object.entries(inputs)) {
      values[key] = input.type === 'checkbox' ? input.checked : input.value;
    }
    return values;
  }

  function submit() {
    if (options.onConfirm(collect()) !== false) removeDialog();
  }

  const cancel = makeDialogButton('取消');
  cancel.addEventListener('click', removeDialog);
  const ok = makeDialogButton('保存', 'primary');
  ok.addEventListener('click', submit);
  footer.append(cancel, ok);

  // 回车直接提交，省一次点击
  for (const input of Object.values(inputs)) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
  }

  // 焦点给第一个文本框，复选框不抢焦点
  const firstText = Object.values(inputs).find(input => input.type !== 'checkbox');
  firstText?.focus();
  firstText?.select();
}

function showTextDialog(title, initialText, options = {}) {
  const { content, footer } = createDialogShell(title);

  if (options.hint) {
    const hint = document.createElement('div');
    hint.textContent = options.hint;
    hint.style.cssText = 'margin-bottom:8px;font-size:12px;opacity:.75;white-space:pre-wrap';
    content.appendChild(hint);
  }

  const textarea = document.createElement('textarea');
  textarea.value = initialText || '';
  textarea.placeholder = options.placeholder || '';
  textarea.readOnly = options.readOnly === true;
  const rows = Number(options.rows) || 0;
  const height = rows > 0 ? `${Math.max(48, rows * 22)}px` : '220px';
  textarea.style.cssText = `
    width: 100%; height: ${height}; padding: 8px; border-radius: 6px;
    border: 1px solid #d0d7de; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    resize: vertical; background: ${options.readOnly ? '#f6f8fa' : '#fff'}; color: #1f2328;
  `;
  content.appendChild(textarea);

  const close = makeDialogButton(options.onConfirm ? '取消' : '关闭');
  close.addEventListener('click', removeDialog);
  footer.appendChild(close);

  if (options.copyable) {
    const copy = makeDialogButton('复制', 'primary');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textarea.value);
        showToast('已复制到剪贴板');
      } catch (e) {
        textarea.select();
        showToast('请手动复制（已全选）');
      }
    });
    footer.appendChild(copy);
  }

  if (options.onConfirm) {
    const confirm = makeDialogButton('确定', 'primary');
    confirm.addEventListener('click', () => {
      const accepted = options.onConfirm(textarea.value);
      if (accepted !== false) removeDialog();
    });
    footer.appendChild(confirm);
  }

  textarea.focus();
  if (options.readOnly) textarea.select();
}

// ==================================================================
// 源文件: 90-main.js
// ==================================================================
// ===== 入口 =====
function getHostname() {
  try {
    return location.hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

// 当前域名在不在站点列表里
function isKnownSite(host) {
  return getRawSites().some(site => site.domain === host);
}

function registerMenuCommands(known) {
  GM_registerMenuCommand('打开签到面板', () => togglePanel(true));

  GM_registerMenuCommand('开始签到（全部启用站点）', () => {
    togglePanel(true);
    runBatchCheckIn().catch(error => showToast(`出错了: ${error.message}`));
  });

  GM_registerMenuCommand('关闭本轮打开的标签页', () => {
    const closed = closeAllOpenedTabs();
    showToast(closed > 0
      ? `已关闭 ${closed} 个标签页`
      : '没有可关的标签页（只有发起签到的那个页面能关）');
  });

  if (known) {
    GM_registerMenuCommand('只签当前站点', () => {
      togglePanel(true);
      const site = getSites().find(s => s.domain === getHostname());
      if (site) {
        runBatchCheckIn([site.siteId]).catch(error => showToast(`出错了: ${error.message}`));
      }
    });
  } else {
    GM_registerMenuCommand('把当前页面加为签到页', () => {
      togglePanel(true);
      handleAddSite(location.href, false);
    });
  }
}

async function main() {
  const host = getHostname();
  if (!host) return;

  const known = isKnownSite(host);

  // hook 必须在 document-start 装，否则抓不到页面早期发出的签到请求
  if (known) installNetworkHooks();

  await waitForBodyReady();
  registerMenuCommands(known);

  // 不在列表里的站点：只留菜单入口，不做任何自动动作
  if (!known) return;

  // 认领任务：域名对得上，且任务是刚派出来的。
  // 时间窗口用来排除你手上其它同域标签页——它们如果稍后发生导航，
  // 那时任务早已被清掉或超出窗口，不会重复签到。
  // 已知站点一律监听聚焦请求：面板上点"切过来"时，
  // 由这个页面自己调 window.focus()，而不是新开一个标签页
  watchFocusRequests(host);

  const job = getJob();
  if (isJobFresh(job, host)) {
    // 立刻标记已认领，防止同域的另一个页面也把这个任务执行一遍
    saveJob({ ...job, claimedAt: Date.now() });
    await runWorker(job);
    return;
  }

  // 没被派活：批量进行中时显示面板跟进度
  if (getRunState().running === true) {
    togglePanel(true);
    watchSharedState();
  }
}

// 让非协调者页面也能看到进度更新
function watchSharedState() {
  try {
    GM_addValueChangeListener(KEY_RESULTS, (name, oldValue, newValue, remote) => {
      if (remote && panelVisible) renderPanel();
    });
    GM_addValueChangeListener(KEY_RUN, (name, oldValue, newValue, remote) => {
      if (remote && panelVisible) renderPanel();
    });
  } catch (e) { /* 不支持就靠手动刷新 */ }
}

function waitForBodyReady() {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.documentElement, { childList: true });
    setTimeout(() => {
      observer.disconnect();
      resolve();
    }, 8000);
  });
}

main().catch((error) => {
  console.error('[签到助手] 初始化失败:', error);
});
})();
