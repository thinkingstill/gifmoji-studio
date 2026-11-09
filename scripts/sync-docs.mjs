#!/usr/bin/env node
// 把 public/ 的前端产物同步到 docs/（GitHub Pages 目录）。
// 差异只有三处：<html data-env="static">、资源路径改相对、去掉服务端专用头。
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'public');
const dest = join(root, 'docs');
const COPY_AS_IS = ['app.js', 'backend.js', 'giflite.js', 'directgen.js', 'styles.css'];

mkdirSync(dest, { recursive: true });

for (const name of COPY_AS_IS) {
  copyFileSync(join(src, name), join(dest, name));
}

let html = readFileSync(join(src, 'index.html'), 'utf8');
// 1. 标记静态托管，让 app.js 跳过同源探测、直接走浏览器本地链路
html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-env="static">');
// 2. 绝对路径 -> 相对路径（Pages 部署在 /gifmoji-studio/ 子路径下）
html = html.replace(/(href|src)="\/(?!\/)/g, '$1="./');
// 3. 静态托管无需服务端注入的描述，保留即可；但 og:url 之类如果写死本地地址要干掉
html = html.replace(/\s*<meta property="og:url"[^>]*>/g, '');

writeFileSync(join(dest, 'index.html'), html);
writeFileSync(join(dest, '.nojekyll'), '');

console.log('docs/ 已同步：', [...COPY_AS_IS, 'index.html', '.nojekyll'].join(', '));
