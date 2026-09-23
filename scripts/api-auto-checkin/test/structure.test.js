const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { srcDir } = require('./load-src.js');

const rootDir = path.join(__dirname, '..');
const allSrcNames = fs.readdirSync(srcDir).filter(name => name.endsWith('.js'));

function readSrc(name) {
  return fs.readFileSync(path.join(srcDir, name), 'utf8');
}

function readBuilt() {
  const file = path.join(rootDir, 'api-auto-checkin.user.js');
  assert.ok(fs.existsSync(file), '构建产物不存在，先运行 node build.js');
  return fs.readFileSync(file, 'utf8');
}

test('根级测试入口会传播预构建失败', () => {
  const rootTest = fs.readFileSync(path.join(rootDir, '..', '..', 'test.js'), 'utf8');
  assert.match(rootTest, /const buildResult = spawnSync/);
  assert.match(rootTest, /if \(buildResult\.error\)/);
  assert.match(rootTest, /if \(buildResult\.status !== 0\) process\.exit/);
});

// ===== 这条是整个脚本的立足点 =====
test('脚本不主动发起任何签到请求', () => {
  for (const name of allSrcNames) {
    const source = readSrc(name);

    // 不用 GM_xmlhttpRequest 发请求
    assert.doesNotMatch(source, /GM_xmlhttpRequest/,
      `${name} 不该用 GM_xmlhttpRequest，签到请求必须由页面自己发出`);

    // 不拼接签到接口地址
    assert.doesNotMatch(source, /['"`]\/api\/[\w/-]*(?:check|sign|attend)/i,
      `${name} 不该拼接签到接口路径`);
    assert.doesNotMatch(source, /https:\/\/\$\{[^}]*\}\/api\//,
      `${name} 不该拼接接口地址`);
  }
});

test('脚本不预设站点类型', () => {
  for (const name of allSrcNames) {
    const source = readSrc(name);
    assert.doesNotMatch(source, /normalizeSiteType|apiBasePathByType|signExecUrl/,
      `${name} 不该有站点类型相关的接口派生`);
  }
});

test('唯一的 fetch 引用是为了 hook 页面请求', () => {
  const verdict = readSrc('41-verdict.js');
  // hook 里保存并调用原始 fetch 是允许的
  assert.match(verdict, /const originalFetch = window\.fetch/);
  assert.match(verdict, /originalFetch\.apply/);

  // 其它文件不该出现 fetch 调用
  for (const name of allSrcNames) {
    if (name === '41-verdict.js') continue;
    assert.doesNotMatch(readSrc(name), /(?<![.\w])fetch\s*\(/,
      `${name} 不该调用 fetch`);
  }
});

test('元数据只申请必要权限，不含网络权限', () => {
  const header = readSrc('00-header.js');
  for (const grant of ['GM_setValue', 'GM_getValue', 'GM_openInTab',
                       'GM_getTab', 'GM_saveTab',
                       'GM_registerMenuCommand', 'GM_addValueChangeListener',
                       'GM_removeValueChangeListener']) {
    assert.match(header, new RegExp(`@grant\\s+${grant}`), `缺少 @grant ${grant}`);
  }
  assert.doesNotMatch(header, /@grant\s+GM_xmlhttpRequest/, '不需要网络请求权限');
  assert.doesNotMatch(header, /@connect/, '不需要 @connect');

  assert.match(header, /@run-at\s+document-start/);
  assert.match(header, /@match\s+https:\/\/\*\/\*/);
  assert.match(header, /@noframes/);
});

test('发布脚本带更新地址，否则油猴无法自动更新', () => {
  const header = readSrc('00-header.js');
  // 作者和命名空间对得上仓库
  assert.match(header, /@author\s+sunyu2481/);
  assert.match(header, /@namespace\s+https:\/\/github\.com\/sunyu2481\/userscripts/);
  // 更新和下载都必须指向仓库的 dist 产物
  assert.match(header, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/sunyu2481\/userscripts\/main\/dist\/api-auto-checkin\.user\.js/);
  assert.match(header, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/sunyu2481\/userscripts\/main\/dist\/api-auto-checkin\.user\.js/);
  // 版本号必须存在且是合法的 x.y.z
  const version = header.match(/@version\s+(.+)/)?.[1]?.trim();
  assert.ok(version, '发布脚本必须有 @version');
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('入口对陌生站点不做任何自动动作', () => {
  const main = readSrc('90-main.js');
  const guardIndex = main.indexOf('if (!known) return;');
  const workerIndex = main.indexOf('runWorker');
  assert.notEqual(guardIndex, -1, '缺少陌生站点提前退出');
  assert.ok(guardIndex < workerIndex, '陌生站点必须在派活处理之前退出');
});

test('网络 hook 只在已知站点安装且早于 DOM 就绪', () => {
  const main = readSrc('90-main.js');
  const hookIndex = main.indexOf('installNetworkHooks()');
  const bodyIndex = main.indexOf('await waitForBodyReady()');
  assert.notEqual(hookIndex, -1);
  assert.ok(hookIndex < bodyIndex, 'hook 必须在等 body 之前装，否则抓不到早期请求');
  assert.match(main, /if \(known\) installNetworkHooks/);
});

test('人机验证一律停下，不尝试绕过', () => {
  const checkin = readSrc('40-checkin.js');
  const guards = readSrc('31-guards.js');
  assert.match(checkin, /needsHuman: true/);
  assert.match(guards, /HUMAN_VERIFICATION_TEXT_SELECTORS/);
  assert.match(guards, /PASSIVE_VERIFICATION_SELECTOR/);
  assert.doesNotMatch(guards, /slice\(0, 4000\)/,
    '不能再对整页前 4000 字做宽泛验证关键词扫描');

  const forbidden = /solveCaptcha|bypassTurnstile|cf_clearance\s*=|recaptchaToken\s*=|autoSolve/i;
  for (const name of allSrcNames) {
    assert.doesNotMatch(readSrc(name), forbidden, `${name} 不该包含绕过验证的代码`);
  }
});

test('点击前清空已捕获响应，避免拿旧请求当结果', () => {
  const checkin = readSrc('40-checkin.js');
  const clearIndex = checkin.indexOf('capturedResponses.length = 0');
  const clickIndex = checkin.indexOf('const clicked = clickElement');
  assert.notEqual(clearIndex, -1, '缺少清空已捕获响应');
  assert.ok(clearIndex < clickIndex, '必须在点击前清空');
});

test('点击派发完整鼠标事件序列且逐个隔离', () => {
  const checkin = readSrc('40-checkin.js');
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    assert.match(checkin, new RegExp(`'${type}'`), `缺少 ${type} 事件`);
  }
  assert.match(checkin, /el\.click\(\)/);
  // 每个事件单独 try：某个类型不存在不该影响后续事件
  assert.match(checkin, /function dispatchQuietly/);
  assert.match(checkin, /typeof Ctor !== 'function'/);
});

test('点击后没有明确结果时不把置灰当成功', () => {
  const checkin = readSrc('40-checkin.js');
  const body = checkin.slice(checkin.indexOf('async function waitForCheckInOutcome'));
  assert.doesNotMatch(body, /findDisabledCheckInButton\(/,
    '点击后的置灰状态不能单独作为成功证据');
  assert.match(body, /status: 'unknown'/);
});

test('自定义按钮模式不使用全局已签到文案作为点击前结论', () => {
  const detect = readSrc('30-detect.js');
  const checkin = readSrc('40-checkin.js');
  assert.match(detect, /function findInitialAlreadyCheckedIn/);
  assert.match(detect, /if \(normalizeButtonWords\(buttonWords\)\.length > 0\) return null/);
  assert.equal((checkin.match(/findInitialAlreadyCheckedIn\(site\.buttonWords\)/g) || []).length, 2);
});

test('点击前禁用按钮不单独判为已签', () => {
  const checkin = readSrc('40-checkin.js');
  const beforeClick = checkin.slice(
    checkin.indexOf('async function checkInOnThisPage'),
    checkin.indexOf('// 点击前清空已捕获的响应')
  );
  assert.match(beforeClick, /disabledButton = findDisabledCheckInButton\(site\.buttonWords\)/);
  assert.match(beforeClick, /status: 'unknown'/);
  assert.doesNotMatch(beforeClick, /签到按钮已置灰/);
});

test('结果弹窗不被当公告关掉', () => {
  const guards = readSrc('31-guards.js');
  const verdict = readSrc('41-verdict.js');
  assert.match(guards, /isCheckInOutcomeText\(dialogText\)/);
  assert.match(verdict, /function isCheckInOutcomeText/);
  // 进行中的文案集中管理，便于补词
  assert.match(readSrc('30-detect.js'), /IN_PROGRESS_PATTERN/);
});

test('找不到按钮时给出页面候选文案', () => {
  const checkin = readSrc('40-checkin.js');
  const body = checkin.slice(checkin.indexOf('if (!button) {'));
  assert.match(body, /listClickableTexts\(\)/);
  assert.match(body, /candidates/);
  assert.match(body, /hint/);
});

test('容器文案不会被误判为按钮', () => {
  const detect = readSrc('30-detect.js');
  // getOwnText 优先用 aria-label / value，长度上限限制容器
  assert.match(detect, /function getOwnText/);
  assert.match(detect, /normalized\.length > 24/);
});

test('禁用状态覆盖多种表达方式', () => {
  const detect = readSrc('30-detect.js');
  const body = detect.slice(detect.indexOf('function isDisabled'));
  assert.match(body, /aria-disabled/);
  assert.match(body, /pointerEvents === 'none'/);
  assert.match(body, /cursor === 'not-allowed'/);
});

test('打开站点时不改动目标地址', () => {
  const coordinator = readSrc('60-coordinator.js');
  // 必须原样传入 visitUrl：站点可能用 hash 路由（/#/checkin），
  // 往 URL 上加任何标记都会把路由改坏
  assert.match(coordinator, /GM_openInTab\(site\.visitUrl, \{/);
  for (const name of allSrcNames) {
    assert.doesNotMatch(readSrc(name), /parsed\.hash\s*=\s*original/,
      `${name} 不该往目标地址的 hash 上追加内容`);
  }
});

test('首次认领靠时间窗口，跳转接续限于原标签页和当前任务', () => {
  const coordinator = readSrc('60-coordinator.js');
  const main = readSrc('90-main.js');
  const worker = readSrc('50-worker.js');
  assert.match(coordinator, /function isJobFresh/);
  assert.match(coordinator, /JOB_CLAIM_WINDOW_MS/);
  assert.match(coordinator, /if \(job\.claimedAt\) return false/);
  assert.match(main, /await claimWorkerJob\(host\)/);
  assert.match(worker, /isJobFresh\(job, host\)/);
  // 认领后立刻打标记，避免同域两个页面同时执行
  assert.match(worker, /claimedAt: Date\.now\(\)/);
  assert.match(worker, /isSameJob\(job, tab\?\.checkInJob\)/);
  assert.match(worker, /isWorkerJobActive\(job\)/);
  assert.match(coordinator, /expiresAt: assignedAt \+ settings\.siteTimeoutMs/);

  // 派发时必须写入 claimBy，窗口跟着用户配置的站点超时走。
  // 漏写就退回固定 40s：超时设 5s 的人会在之后几十秒里
  // 被任意一次同域导航把残留任务捡走，悄悄多签一次。
  assert.match(coordinator, /function pickClaimDeadline/);
  assert.match(coordinator, /claimBy: pickClaimDeadline\(settings\.siteTimeoutMs, assignedAt\)/,
    '派发任务时必须写入 claimBy');
  assert.match(coordinator, /const claimBy = Number\(job\.claimBy \|\| 0\)/,
    'isJobFresh 必须优先读任务自带的截止时间');
});

test('hash 路由页面会被纠正到目标路由', () => {
  const checkin = readSrc('40-checkin.js');
  assert.match(checkin, /function getTargetHash/);
  assert.match(checkin, /async function ensureHashRoute/);
  // 纠正必须在找按钮之前发生
  const ensureIndex = checkin.indexOf('await ensureHashRoute(site)');
  const findIndex = checkin.indexOf('findCheckInButton(site.buttonWords)');
  assert.ok(ensureIndex !== -1 && ensureIndex < findIndex, 'hash 纠正要在找按钮之前');
  // 轮询中途被冲掉也要纠正，但有次数上限
  assert.match(checkin, /hashFixes < 2/);
});

test('协调者接收本地和远程结果，并检查本轮身份与监听间隙', () => {
  const coordinator = readSrc('60-coordinator.js');
  assert.doesNotMatch(coordinator, /if \(!remote\) return/);
  assert.match(coordinator, /result\.runId !== runId/);
  const preCheck = coordinator.indexOf('const existing = getResults()');
  const listener = coordinator.indexOf('listenerId = GM_addValueChangeListener');
  assert.ok(preCheck !== -1 && preCheck < listener, '必须先查已有结果再装监听');
  assert.match(coordinator, /GM_removeValueChangeListener/);
  assert.match(coordinator, /setInterval\(checkStoredResult, 1000\)/);
});

test('批量开始时清空余额，单站点重试只清自己', () => {
  const coordinator = readSrc('60-coordinator.js');
  const body = coordinator.slice(coordinator.indexOf('async function runBatchCheckIn'));
  assert.match(body, /for \(const siteId of siteIds\) delete kept\[siteId\]/);
  assert.match(body, /saveResults\(\{\}\)/);
});

test('面板定时器不因运行态过期就清共享状态', () => {
  const events = readSrc('72-ui-events.js');
  const timer = events.slice(events.indexOf('panelRefreshTimer = setInterval'),
                             events.indexOf('data-act="start"'));

  // 旁观页面分不清"协调者页面已关"和"协调者只是被浏览器冻结"。
  // 定时器里动共享状态会终止另一个页面正跑着的那一轮。
  assert.doesNotMatch(timer, /forceStopRunState|saveRunState|saveResults|clearJob|abortBatchCheckIn/,
    '面板定时器不该写共享状态，过期只解锁本页按钮');
  // 过期时只重绘一次，否则每 2s 清空一次正在输入的框
  assert.match(timer, /stalePanelPainted/);

  // 强制结束只能由用户点击触发，且必须带上 runId 闸门
  const coordinator = readSrc('60-coordinator.js');
  assert.match(coordinator, /function forceStopRunState\(expectedRunId/);
  assert.match(coordinator, /if \(expectedRunId && state\.runId !== expectedRunId\) return false/);
  assert.match(events, /forceStopRunState\(forceStopBtn\.dataset\.runId/);
});

test('默认保留标签页，可一键关闭', () => {
  const coordinator = readSrc('60-coordinator.js');
  const events = readSrc('72-ui-events.js');
  const panel = readSrc('71-ui-panel.js');

  // 句柄攒起来供一键关闭
  assert.match(coordinator, /function rememberOpenedTab/);
  assert.match(coordinator, /function closeAllOpenedTabs/);
  assert.match(coordinator, /rememberOpenedTab\(site\.siteId, site\.siteName, handle\)/);

  // 只有显式开启自动关才关
  assert.match(coordinator, /settings\.autoCloseTab === true && !shouldKeepTabOpen\(result\)/);

  // 需要你处理的标签页始终保留
  assert.match(coordinator, /function shouldKeepTabOpen/);
  assert.match(coordinator, /result\?\.needsHuman === true \|\| result\?\.needsLogin === true/);

  // 面板有入口
  assert.match(panel, /data-act="close-tabs"/);
  assert.match(events, /closeAllOpenedTabs\(\)/);
});

test('自动关闭默认关掉', () => {
  const storage = readSrc('10-storage.js');
  assert.match(storage, /autoCloseTab: false/);
  // 旧的反向设置项已经移除
  for (const name of allSrcNames) {
    assert.doesNotMatch(readSrc(name), /keepFailedTabOpen/, `${name} 还留着旧设置项`);
  }
});

test('余额功能已完全移除', () => {
  // 余额只能靠字段名和 class 猜，容易显示错的数字，不如不显示
  for (const name of allSrcNames) {
    const source = readSrc(name);
    assert.doesNotMatch(source, /extractBalance|readBalanceFromPage|formatBalance|BALANCE_KEYS|QUOTA_UNIT/,
      `${name} 还留着余额代码`);
    assert.doesNotMatch(source, /result\.balance|gm-bal/, `${name} 还在显示余额`);
  }
});

test('切到标签页是请它自己聚焦，不是新开一个', () => {
  const events = readSrc('72-ui-events.js');
  const body = events.slice(events.indexOf('function handleFocusSiteTab'),
                            events.indexOf('function handleAddSite'));

  // 必须先发聚焦请求
  const requestIndex = body.indexOf('requestTabFocus(site.domain)');
  const openIndex = body.indexOf('GM_openInTab');
  assert.ok(requestIndex !== -1, '缺少聚焦请求');
  assert.ok(requestIndex < openIndex, '必须先请求聚焦，新开只是兜底');

  // 新开必须在超时回调里，且以请求未被响应为条件
  assert.match(body, /setTimeout\(\(\) => \{/);
  assert.match(body, /pending\?\.domain !== site\.domain\) return/);
});

test('站点页面一律监听聚焦请求', () => {
  const main = readSrc('90-main.js');
  const watchIndex = main.indexOf('watchFocusRequests(host)');
  const jobIndex = main.indexOf('await claimWorkerJob(host)');
  assert.ok(watchIndex !== -1, '缺少聚焦监听');
  // 必须在派活判断之前装：没被派活的页面也要能被切过来
  assert.ok(watchIndex < jobIndex, '监听要在认领任务之前装');
});

test('聚焦请求有过期时间', () => {
  const focus = readSrc('52-focus.js');
  assert.match(focus, /FOCUS_REQUEST_TTL_MS/);
  assert.match(focus, /now - Number\(request\.at \|\| 0\) <= FOCUS_REQUEST_TTL_MS/);
  // 区分本地与远程写入
  assert.match(focus, /if \(!remote\) return/);
});

test('被保留的标签页显示不自动消失的提示', () => {
  const worker = readSrc('50-worker.js');
  const style = readSrc('70-ui-style.js');
  assert.match(worker, /showStickyNotice/);
  assert.match(worker, /result\.needsHuman \|\| result\.needsLogin/);
  assert.match(style, /function showStickyNotice/);
  // 点击才关，不设定时器
  const body = style.slice(style.indexOf('function showStickyNotice'));
  assert.match(body, /notice\.remove\(\)/);
  assert.doesNotMatch(body, /setTimeout/, '不该自动消失');
});

test('站点间隔随机且可配置', () => {
  const coordinator = readSrc('60-coordinator.js');
  assert.match(coordinator, /function pickGap/);
  assert.match(coordinator, /Math\.random\(\)/);
  assert.match(coordinator, /settings\.gapMinMs/);
  assert.match(coordinator, /settings\.gapMaxMs/);
});

test('手动改过的站点名不被自动获取覆盖', () => {
  const site = readSrc('20-site.js');
  const worker = readSrc('50-worker.js');
  assert.match(site, /function canAutoUpdateName/);
  assert.match(site, /site\.nameLocked === true/);
  // 工作者必须先问过再写
  assert.match(worker, /canAutoUpdateName\(raw\)/);
  const guardIndex = worker.indexOf('canAutoUpdateName(raw)');
  const writeIndex = worker.indexOf('patchRawSite(site.domain, { name })');
  assert.ok(guardIndex !== -1 && guardIndex < writeIndex, '写名称前必须先判断是否锁定');
});

test('自动取名过滤掉功能词', () => {
  const site = readSrc('20-site.js');
  assert.match(site, /PAGE_FUNCTION_WORDS/);
  assert.match(site, /function isUsableSiteName/);
  // 整体判断必须在按分隔符拆分之前，否则 Check-in 会漏过
  const body = site.slice(site.indexOf('function readSiteNameFromPage'));
  const wholeCheck = body.indexOf('PAGE_FUNCTION_PATTERN.test(title)');
  const splitCall = body.indexOf('title\n    .split(');
  assert.ok(wholeCheck !== -1 && wholeCheck < splitCall, '先判整体再拆分');
});

test('编辑校验是纯函数，便于测试', () => {
  const site = readSrc('20-site.js');
  const events = readSrc('72-ui-events.js');
  assert.match(site, /function buildEditedSite/);
  // 校验函数不碰存储
  const body = site.slice(site.indexOf('function buildEditedSite'),
                          site.indexOf('function canAutoUpdateName'));
  assert.doesNotMatch(body, /saveRawSites|GM_setValue/, '校验函数不该直接写存储');
  // UI 层负责落盘
  assert.match(events, /buildEditedSite\(getRawSites\(\)/);
});

test('名称、地址、仅访问模式都能编辑', () => {
  const events = readSrc('72-ui-events.js');
  const dialog = readSrc('73-ui-dialog.js');
  assert.match(dialog, /function showFormDialog/);
  // 表单支持复选框字段
  assert.match(dialog, /field\.type === 'checkbox'/);
  assert.match(dialog, /input\.type === 'checkbox' \? input\.checked : input\.value/);

  const body = events.slice(events.indexOf('function handleEditSite'));
  assert.match(body, /key: 'name'/);
  assert.match(body, /key: 'url'/);
  assert.match(body, /key: 'visitOnly'/);
  assert.match(body, /type: 'checkbox'/);
  assert.match(body, /key: 'buttonWords'/);
  assert.match(body, /key: 'resultWords'/);
});

test('站点级按钮和结果文案会进入备份', () => {
  const site = readSrc('20-site.js');
  const events = readSrc('72-ui-events.js');
  assert.match(site, /buttonWords: normalizeConfiguredWords/);
  assert.match(site, /resultWords: normalizeConfiguredWords/);
  assert.ok(events.includes('buttonWords: normalizeConfiguredWords(site.buttonWords)'));
  assert.ok(events.includes('resultWords: normalizeConfiguredWords(site.resultWords)'));
});

test('仅访问模式漏传时保持原值', () => {
  const site = readSrc('20-site.js');
  const body = site.slice(site.indexOf('function buildEditedSite'));
  assert.match(body, /visitOnly === undefined/);
  assert.match(body, /existing\.visitOnly === true/);
});

test('仅访问模式仍检查登录态', () => {
  const checkin = readSrc('40-checkin.js');
  const body = checkin.slice(checkin.indexOf('if (site.visitOnly)'));
  assert.match(body, /looksLoggedOut\(\)/, '仅访问也要确认没落在登录页');
  assert.match(body, /needsLogin: true/);
});

test('面板标出仅访问的站点', () => {
  const panel = readSrc('71-ui-panel.js');
  assert.match(panel, /site\.visitOnly \? '<span class="gm-mode"/);
  assert.match(readSrc('70-ui-style.js'), /\.gm-mode/);
});

test('备份带上名称锁定标记', () => {
  const events = readSrc('72-ui-events.js');
  assert.match(events, /nameLocked: site\.nameLocked === true/);
  // 旧版备份没这个字段时要推断，避免导入后名称被覆盖
  assert.match(events, /nameLocked: site\.nameLocked === true \|\| \(name !== domain/);
});

test('面板不用原生对话框且输出经过转义', () => {
  for (const name of allSrcNames) {
    const calls = readSrc(name).match(/(?<![.\w])(?:confirm|prompt)\s*\(/g) || [];
    assert.deepEqual(calls, [], `${name} 使用了原生对话框`);
  }
  const panel = readSrc('71-ui-panel.js');
  assert.match(panel, /function escapeHtml/);
  assert.match(panel, /escapeHtml\(site\.siteName\)/);
  assert.match(panel, /escapeHtml\(result\.message\)/);
  assert.match(panel, /escapeHtml\(site\.visitUrl\)/);
});

test('构建产物是完整可加载的单文件脚本', () => {
  const built = readBuilt();
  assert.ok(built.startsWith('// ==UserScript=='), '必须以元数据块开头');
  assert.match(built, /\/\/ ==\/UserScript==/);
  assert.ok(built.trimEnd().endsWith('})();'), '必须以 IIFE 收尾');

  const metaEnd = built.indexOf('// ==/UserScript==');
  assert.ok(metaEnd > 0 && metaEnd < 1200, '元数据块必须紧贴文件开头');
});

test('构建产物包含所有源文件片段', () => {
  const built = readBuilt();
  for (const name of allSrcNames) {
    if (name === '00-header.js' || name === '99-footer.js') continue;
    assert.ok(built.includes(`源文件: ${name}`), `构建产物缺少 ${name}`);
  }
});
