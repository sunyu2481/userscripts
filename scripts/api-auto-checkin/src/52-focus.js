// ===== 自我聚焦 =====
// 油猴没有"把某个已存在的标签页切到前台"的接口：GM_openInTab 只会新开一个。
// 所以改由目标标签页自己响应——它还活着，能调 window.focus()。
// 协调者往存储写一条请求，目标页收到就把自己切到前台。

const FOCUS_REQUEST_TTL_MS = 15000;

function isFocusRequestForMe(request, host, now = Date.now()) {
  if (!request?.domain) return false;
  if (request.domain !== host) return false;
  // 过期请求不响应，避免刷新页面时被历史请求带到前台
  return now >= Number(request.at || 0) &&
    now - Number(request.at || 0) <= FOCUS_REQUEST_TTL_MS;
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
