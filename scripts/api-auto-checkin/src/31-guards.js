// ===== 需要停下来的情况 =====
// 人机验证和未登录都不自动处理，交回给你。

// 只收明确要求用户完成验证的文案。"身份验证"、"验证码"、"Turnstile"等
// 单独出现时常常只是安全设置或帮助说明，不能作为当前挑战的证据。
const HUMAN_VERIFICATION_PATTERN = /(?:Security Check|请(?:先)?完成(?:页面上的|当前的|本次)?(?:人机|安全|滑块)?验证(?:后(?:继续|提交|操作))?|请(?:先)?验证你是人类|验证你是人类|verify(?: that)? you are human|Checking your browser|Just a moment|请稍候.{0,12}正在验证)/i;

const HUMAN_VERIFICATION_TITLE_PATTERN = /(?:Security Check|Checking your browser|Just a moment|verify(?: that)? you are human)/i;

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

// 文案只有出现在这些语义区域时才作为验证提示；普通页面正文不做全文扫描。
const HUMAN_VERIFICATION_TEXT_SELECTORS = [
  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
  '[role="alert"]', '[role="status"]',
  '[class*="challenge" i]', '[class*="captcha" i]', '[class*="turnstile" i]',
  '[class*="hcaptcha" i]', '[class*="recaptcha" i]',
  '[id*="challenge" i]', '[id*="captcha" i]', '[id*="turnstile" i]'
].join(', ');

// 这些组件可能只是站点常驻的被动徽章或 invisible widget，不要求用户操作。
const PASSIVE_VERIFICATION_SELECTOR = [
  '[class*="badge" i]', '[class*="invisible" i]',
  '[data-size="invisible"]', '[data-widget-size="invisible"]',
  '[aria-hidden="true"]'
].join(', ');

function isPassiveVerificationElement(el) {
  try {
    return Boolean(el?.closest?.(PASSIVE_VERIFICATION_SELECTOR));
  } catch (e) {
    return false;
  }
}

function isActiveVerificationElement(el) {
  return Boolean(el && isVisible(el) && !isPassiveVerificationElement(el));
}

function normalizeVerificationText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function matchesHumanVerificationText(text, maxLength = Infinity) {
  const normalized = normalizeVerificationText(text);
  return normalized.length > 0 && normalized.length <= maxLength &&
    HUMAN_VERIFICATION_PATTERN.test(normalized);
}

function hasHumanVerificationWidget() {
  for (const selector of HUMAN_VERIFICATION_SELECTORS) {
    try {
      for (const el of document.querySelectorAll(selector)) {
        if (isActiveVerificationElement(el)) return true;
      }
    } catch (e) { /* 选择器不支持时跳过 */ }
  }
  return false;
}

function hasHumanVerificationText() {
  if (HUMAN_VERIFICATION_TITLE_PATTERN.test(String(document.title || ''))) return true;

  try {
    for (const el of document.querySelectorAll(HUMAN_VERIFICATION_TEXT_SELECTORS)) {
      if (!isActiveVerificationElement(el)) continue;
      if (matchesHumanVerificationText(el.innerText)) return true;
    }
  } catch (e) { /* 选择器不支持时跳过 */ }

  // 只有内容很短、明显是专门的验证页时才看正文，避免扫到侧栏/帮助文案。
  return matchesHumanVerificationText(document.body?.innerText, 320);
}

function hasHumanVerification() {
  return hasHumanVerificationWidget() || hasHumanVerificationText();
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

  // 全页正文里的“登录后可用”常常只是帮助说明。只有短小、像专门提示页的
  // 正文才直接采信；长页面只看提示框和登录按钮。
  const bodyText = String(document.body?.innerText || '').slice(0, 401).replace(/\s+/g, ' ').trim();
  if (bodyText.length <= 400 && LOGIN_TEXT_PATTERN.test(bodyText)) return true;

  const notices = document.querySelectorAll(
    '[role="alert"], [role="status"], [role="dialog"], [class*="toast" i], ' +
    '[class*="message" i], [class*="notification" i]'
  );
  for (const notice of notices) {
    if (!isVisible(notice)) continue;
    const text = String(notice.innerText || '').replace(/\s+/g, ' ').trim();
    if (text.length <= 300 && LOGIN_TEXT_PATTERN.test(text)) return true;
  }

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
    if (matchesHumanVerificationText(dialogText)) continue;
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
