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
