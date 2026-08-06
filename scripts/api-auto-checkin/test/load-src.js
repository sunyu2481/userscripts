// 测试辅助：在主 realm 里求值 src/ 分片，导出其中的函数
// 测试跑的就是构建产物里的同一份代码，不维护副本
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src');

// 不依赖 DOM 的纯逻辑
const PURE_MODULES = ['20-site.js', '41-verdict.js'];

// 需要 DOM 的识别逻辑
const DOM_MODULES = ['20-site.js', '30-detect.js', '31-guards.js', '41-verdict.js'];

function readModules(names) {
  return names.map(name => fs.readFileSync(path.join(srcDir, name), 'utf8')).join('\n');
}

// 抽出顶层函数名和大写常量名，作为导出清单
function collectTopLevelNames(source) {
  const names = new Set();
  // 只收零缩进的顶层声明；嵌套函数（如 hook 内部的 record）不导出
  const patterns = [
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^const\s+([A-Z_][A-Z0-9_]*)\s*=/gm
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) names.add(match[1]);
  }
  return [...names];
}

// 纯逻辑：不注入 DOM，测试中不调用需要 DOM 的函数
function loadPureModules(extraGlobals = {}) {
  const source = readModules(PURE_MODULES);
  const names = collectTopLevelNames(source);
  const globalNames = Object.keys(extraGlobals);

  const factory = new Function(...globalNames, `
    ${source}
    return { ${names.join(', ')} };
  `);
  return factory(...globalNames.map(n => extraGlobals[n]));
}

// 带 DOM：调用方传入 document / window / location / getSettings 等
function loadDomModules(globals) {
  const source = readModules(DOM_MODULES);
  const names = collectTopLevelNames(source);
  const globalNames = Object.keys(globals);

  const factory = new Function(...globalNames, `
    ${source}
    return { ${names.join(', ')} };
  `);
  return factory(...globalNames.map(n => globals[n]));
}

module.exports = { loadPureModules, loadDomModules, PURE_MODULES, DOM_MODULES, srcDir };
