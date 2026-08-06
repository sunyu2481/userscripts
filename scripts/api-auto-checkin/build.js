#!/usr/bin/env node
// 把 src/ 下的分片按文件名顺序拼成单文件油猴脚本
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, 'src');
const outFile = path.join(__dirname, 'api-auto-checkin.user.js');

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
