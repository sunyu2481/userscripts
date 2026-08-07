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
