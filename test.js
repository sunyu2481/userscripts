#!/usr/bin/env node
// 合集测试入口：把各脚本目录下的 test/*.test.js 交给 node --test 跑。
//
//   node test.js              跑全部脚本的测试
//   node test.js api-auto-checkin   只跑指定脚本
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptsDir = path.join(__dirname, 'scripts');

function discoverScripts() {
  if (!fs.existsSync(scriptsDir)) return [];
  return fs.readdirSync(scriptsDir)
    .filter((name) => fs.statSync(path.join(scriptsDir, name)).isDirectory())
    .sort();
}

function testFilesOf(name) {
  const testDir = path.join(scriptsDir, name, 'test');
  if (!fs.existsSync(testDir)) return [];
  return fs.readdirSync(testDir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => path.join(testDir, f));
}

const requested = process.argv.slice(2);
const available = discoverScripts();
const targets = requested.length > 0 ? requested : available;

const unknown = targets.filter((name) => !available.includes(name));
if (unknown.length > 0) {
  console.error(`找不到脚本: ${unknown.join(', ')}`);
  process.exit(1);
}

const files = targets.flatMap(testFilesOf);
if (files.length === 0) {
  console.log('没有找到测试文件');
  process.exit(0);
}

// 构建产物参与结构测试，先确保它们是最新的
spawnSync(process.execPath, ['build.js', ...targets], {
  cwd: __dirname,
  stdio: 'ignore'
});

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: __dirname,
  stdio: 'inherit'
});
process.exit(result.status ?? 1);
