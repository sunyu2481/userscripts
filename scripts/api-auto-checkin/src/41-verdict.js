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
