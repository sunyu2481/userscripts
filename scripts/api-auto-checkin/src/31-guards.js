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
