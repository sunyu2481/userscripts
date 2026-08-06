#!/usr/bin/env node
// 把 src/ 下的分片按文件名顺序拼成单文件油猴脚本
//
//   node build.js            构建（不递增版本号）
//   node build.js --bump     构建并递增 patch 版本号（发新版用）
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, 'src');
const outFile = path.join(__dirname, 'api-auto-checkin.user.js');
const headerFile = path.join(srcDir, '00-header.js');

const bumpVersion = process.argv.includes('--bump');

// 构造时递增 patch 版本：3.0.0 → 3.0.1
function bumpPatch(version) {
  const parts = String(version || '').split('.');
  while (parts.length < 3) parts.push('0');
  parts[2] = String(Number(parts[2] || 0) + 1);
  return parts.join('.');
}

if (bumpVersion) {
  const header = fs.readFileSync(headerFile, 'utf8');
  const match = header.match(/^\/\/ @version\s+(\S+)/m);
  if (!match) {
    console.error('00-header.js 里没找到 @version');
    process.exit(1);
  }
  const next = bumpPatch(match[1]);
  fs.writeFileSync(headerFile, header.replace(/^\/\/ @version\s+\S+/m, `// @version      ${next}`));
  console.log(`版本号 ${match[1]} → ${next}`);
}

const files = fs.readdirSync(srcDir)
  .filter(name => name.endsWith('.js'))
  .sort();

if (files.length === 0) {
  console.error('src/ 下没有找到源文件');
  process.exit(1);
}

const chunks = files.map((name) => {
  const body = fs.readFileSync(path.join(srcDir, name), 'utf8').trimEnd();
  // 头尾片不加分隔注释，保持 UserScript 元数据块紧贴文件开头
  if (name === '00-header.js' || name === '99-footer.js') return body;
  return `\n// ${'='.repeat(66)}\n// 源文件: ${name}\n// ${'='.repeat(66)}\n${body}`;
});

fs.writeFileSync(outFile, `${chunks.join('\n')}\n`, 'utf8');

const lines = fs.readFileSync(outFile, 'utf8').split('\n').length;
console.log(`已生成 ${path.relative(process.cwd(), outFile)}`);
console.log(`合并 ${files.length} 个源文件，共 ${lines} 行`);
