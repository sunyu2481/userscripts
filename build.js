#!/usr/bin/env node
// 合集构建入口。
// 每个脚本目录自带 build.js，这里负责发现并逐个调用，最后把产物汇总到 dist/。
//
//   node build.js                   构建全部脚本
//   node build.js api-auto-checkin  只构建指定脚本
//   node build.js --bump            构建并递增全部脚本版本号（CI 发布用）
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rootDir = __dirname;
const scriptsDir = path.join(rootDir, 'scripts');
const distDir = path.join(rootDir, 'dist');

// --bump 是合集级开关，透传给每个脚本的 build.js
const BUMP = process.argv.includes('--bump');
const requested = process.argv.slice(2).filter((arg) => arg !== '--bump');

// 一个目录算脚本，前提是里面有 build.js
function discoverScripts() {
  if (!fs.existsSync(scriptsDir)) return [];
  return fs.readdirSync(scriptsDir)
    .filter((name) => {
      const dir = path.join(scriptsDir, name);
      return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'build.js'));
    })
    .sort();
}

function buildOne(name, copiedFiles) {
  const dir = path.join(scriptsDir, name);
  process.stdout.write(`\n[${name}]\n`);
  const args = ['build.js'];
  if (BUMP) args.push('--bump');
  execFileSync(process.execPath, args, { cwd: dir, stdio: 'inherit' });

  // 把产物复制到 dist/，方便统一取用
  const userScripts = fs.readdirSync(dir).filter((f) => f.endsWith('.user.js'));
  if (userScripts.length === 0) {
    throw new Error(`${name} 没有产出 .user.js`);
  }
  fs.mkdirSync(distDir, { recursive: true });
  for (const file of userScripts) {
    const owner = copiedFiles.get(file);
    if (owner) {
      throw new Error(`${name} 与 ${owner} 产出了同名文件 ${file}`);
    }
    copiedFiles.set(file, name);
    fs.copyFileSync(path.join(dir, file), path.join(distDir, file));
    process.stdout.write(`  → dist/${file}\n`);
  }
  return userScripts;
}

const available = discoverScripts();

if (available.length === 0) {
  console.error('scripts/ 下没有找到可构建的脚本（需要包含 build.js）');
  process.exit(1);
}

const targets = requested.length > 0 ? requested : available;
const unknown = targets.filter((name) => !available.includes(name));
if (unknown.length > 0) {
  console.error(`找不到脚本: ${unknown.join(', ')}`);
  console.error(`可用: ${available.join(', ')}`);
  process.exit(1);
}

let total = 0;
const copiedFiles = new Map();
for (const name of targets) {
  total += buildOne(name, copiedFiles).length;
}

// 全量构建时清掉已经没有来源的旧 bundle；定向构建不能动其它脚本的产物。
if (requested.length === 0 && fs.existsSync(distDir)) {
  for (const file of fs.readdirSync(distDir)) {
    if (!file.endsWith('.user.js') || copiedFiles.has(file)) continue;
    fs.unlinkSync(path.join(distDir, file));
    process.stdout.write(`  已移除过期产物 dist/${file}\n`);
  }
}

console.log(`\n完成：${targets.length} 个脚本，${total} 个产物在 dist/`);
