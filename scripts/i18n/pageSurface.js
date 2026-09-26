#!/usr/bin/env node
/**
 * 🔴 量"一个页面到底由哪几块拼成"（i18n 批次切分前的**必做**测量）。
 *
 * ## 为什么要有这个工具（本项目已实测踩到 4 次）
 * "按页面切批次"这条规矩的前提是**知道页面有哪些块**。前 4 次都是靠人读 import 列表，
 * 结果每次都漏：`StaticForm`（图床设置页）、`ObjTable`（图片信息弹窗）、`UpdateModal`（草稿页）、
 * 🔴 `RevisionHistory`（文章页，**由 columns.jsx 引入**、不在 index.jsx 的 import 里）。
 * 漏掉的后果是"半页中文"——而那种状态比整页中文更难让人相信这个产品支持英文。
 *
 * ## 它做什么
 * 从一个入口文件出发，**递归**跟着相对导入与 `@/` 别名走（跳过语言包与 node_modules），
 * 对每个文件用共享模块 `astInventory.bareChinese` 量"真实剩余"（与棘轮同口径），
 * 并按 bare 数从多到少打印；末尾给出合计与"这一批要做几个文件"。
 *
 * 用法：`node scripts/i18n/pageSurface.js packages/admin/src/pages/Article/index.jsx`
 */
'use strict';
const fs = require('fs');
const path = require('path');
const astInventory = require('./astInventory.js');

const ROOT = path.resolve(__dirname, '../..');
const ADMIN_SRC = path.join(ROOT, 'packages/admin/src');
const EXTS = ['.tsx', '.jsx', '.ts', '.js'];

function resolveImport(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = path.join(ADMIN_SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // 第三方包
  for (const e of EXTS) {
    if (fs.existsSync(base + e) && fs.statSync(base + e).isFile()) return base + e;
  }
  for (const e of EXTS) {
    const idx = path.join(base, 'index' + e);
    if (fs.existsSync(idx)) return idx;
  }
  return null;
}

function walk(entry) {
  const seen = new Map();
  const queue = [path.resolve(entry)];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) { seen.set(file, { missing: true }); continue; }
    const src = fs.readFileSync(file, 'utf8');
    let items = [];
    try {
      items = [...astInventory.bareChinese(src, file)];
    } catch (e) {
      seen.set(file, { parseError: String(e.message).slice(0, 80) });
      continue;
    }
    seen.set(file, { items });
    for (const m of src.matchAll(/(?:import|export)[\s\S]{0,200}?from\s+'([^']+)'|require\(\s*'([^']+)'\s*\)/g)) {
      const spec = m[1] || m[2];
      if (!spec) continue;
      const target = resolveImport(spec, file);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function main() {
  const entry = process.argv[2];
  if (!entry) {
    console.error('用法：node scripts/i18n/pageSurface.js <入口文件>');
    process.exit(2);
  }
  const abs = path.resolve(ROOT, entry);
  const seen = walk(abs);
  const rows = [];
  let total = 0;
  for (const [file, info] of seen) {
    const rel = path.relative(ROOT, file);
    if (info.missing) { console.log(`  ⚠️ 解析不到：${rel}`); continue; }
    if (info.parseError) { console.log(`  ⚠️ 解析失败：${rel} → ${info.parseError}`); continue; }
    if (!info.items.length) continue;
    total += info.items.length;
    rows.push([info.items.length, rel, info.items]);
  }
  rows.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  console.log(`=== 页面表面（从 ${path.relative(ROOT, abs)} 递归 import 得到，共 ${seen.size} 个文件）===`);
  for (const [n, rel, items] of rows) {
    console.log(`  ${String(n).padStart(3)} 条  ${rel}`);
    if (process.env.SHOW_ITEMS) items.slice(0, 6).forEach((x) => console.log(`         · ${x.slice(0, 68)}`));
  }
  console.log(`  ---- 合计 ${total} 条 / ${rows.length} 个文件（口径 = bareChinese，与棘轮一致）----`);
  console.log('  🔴 切批次时把这张表**整个**看完：漏掉任何一个文件都会留下"半页中文"。');
}

main();
