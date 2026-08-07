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
const MAX_CONFIGURED_WORDS = 30;

function normalizeConfiguredWords(value, maxLength = 40, maxItems = MAX_CONFIGURED_WORDS) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
  const words = [];
  for (const item of raw) {
    const word = String(item || '').replace(/\s+/g, ' ').trim();
    if (!word || word.length > maxLength || words.includes(word)) continue;
    words.push(word);
    if (words.length >= maxItems) break;
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

function isValidSiteHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host.length > 253 || !host.includes('.') || host.endsWith('.')) return false;
  return host.split('.').every(label =>
    label.length > 0 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}

// 解析用户输入的地址，域名和完整路径都留着。脚本只匹配 HTTPS 页面，
// 因此显式 HTTP、带账号密码或非法主机名的地址直接拒绝。
function normalizeSiteInput(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (!isValidSiteHostname(parsed.hostname)) return null;
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
