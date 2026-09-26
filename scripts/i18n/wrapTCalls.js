#!/usr/bin/env node
/**
 * 🔴 i18n 批量接线的**机械部分**：把一个文件里的中文字面量按给定映射改写成 `t('key', '中文')`。
 *
 * ## 为什么要有这个工具（2026-09-26 站长裁定"大块推进"之后）
 * 剩下的都是 50–90 条一个的**大文件**（`Backup.jsx` 89、`Theme.jsx` 59、`DataManage/Category.jsx` 58、
 * `CommentManage/BuiltinComments.jsx` 50、`About.tsx` 35 …）。手工一条条 `rep(s, old, new)` 的代价是：
 * ① 慢；② 🔴 **锚点撞车**（同一句中文在一个文件里出现多次、或缩进不同 ⇒ 本项目"锚点命中 0/2 次"已踩 6 次）；
 * ③ 容易漏（漏的那条要到活体反向判据才暴露，而那时已经建完栈了）。
 * 所以把"按**位置**改写"这件事交给 AST：映射表由人（或人复核过的草稿）给，改写由机器按 loc 精确做。
 *
 * ## 它做什么 / 不做什么
 * 做：① `StringLiteral`（含 JSX 属性里的 `label="中文"` ⇒ 自动补 `{}`）；② `JSXText`（保留原有前后空白）；
 *     ③ 可选插入 hook（`--hook-anchor` 指定"在哪个字符串后面插"）。
 * 🔴 **不做**：模板字符串（`` `已转存 ${n} 张` ``）—— 那需要人决定 ICU 占位符名与句子怎么合并
 *     （本项目已 8 次把"模板相加"收成一条整句，每次都涉及语义判断）。这类会被**列出来**让人手工改。
 * 🔴 也**不碰**注释与 `console.*` 的实参（与 `bareChinese` 的口径一致）。
 *
 * ## 用法
 *   node scripts/i18n/wrapTCalls.js <file> <map.json> [--hook-anchor '<源码片段>'] [--hook-body <file>] [--dry]
 * map.json 形状：`{"中文原文": "backup.exportFailed", …}`（原文必须与源码里的字面量**逐字**相同）。
 *
 * 🔴 输出必须复核：脚本会打印"改了几处 / 模板待手工几处 / 改完还剩几条裸中文"。
 *    "还剩几条"不为 0 就说明映射表不全（或有模板）——**不要**当成完成。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const astInventory = require('./astInventory.js');

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;

function parseArgs(argv) {
  const out = { file: null, map: null, hookAnchor: null, hookBody: null, dry: false };
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry') out.dry = true;
    else if (a === '--hook-anchor') out.hookAnchor = argv[++i];
    else if (a === '--hook-body') out.hookBody = argv[++i];
    else pos.push(a);
  }
  out.file = pos[0];
  out.map = pos[1];
  return out;
}

/** 把字符串安全地写回单引号 JS 字面量（保留中文原样，只转义必要的字符）。 */
function q(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file || !opts.map) {
    console.error('用法：node scripts/i18n/wrapTCalls.js <file> <map.json> [--hook-anchor <片段>] [--hook-body <file>] [--dry]');
    process.exit(2);
  }
  const abs = path.resolve(opts.file);
  const src = fs.readFileSync(abs, 'utf8');
  const map = JSON.parse(fs.readFileSync(path.resolve(opts.map), 'utf8'));
  const before = astInventory.bareChinese(src, opts.file).size;

  const ast = astInventory.parseSource(src, opts.file);
  const edits = []; // { start, end, text, kind, key, line }
  const templates = [];
  const unmapped = [];

  // 记录"已经是 t() 的 defaultMessage 位"与"console.* 的实参"，两类都不改
  const skipRanges = [];
  const pushSkip = (nd) => {
    if (nd && nd.loc) skipRanges.push([nd.start, nd.end]);
  };
  const inSkip = (node) => skipRanges.some(([a, b]) => node.start >= a && node.end <= b);

  const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
  const walk = (nd, parent) => {
    if (!nd || typeof nd !== 'object') return;
    // t(...) / formatMessage(...) 的第二个实参 = defaultMessage 位（本工具改写后不能再改一次）
    if (
      nd.type === 'CallExpression' && nd.callee &&
      ((nd.callee.type === 'Identifier' && (nd.callee.name === 't' || nd.callee.name === 'formatMessage')) ||
        (nd.callee.type === 'MemberExpression' && nd.callee.property && nd.callee.property.name === 'formatMessage'))
    ) {
      const args = nd.arguments || [];
      if (args[1]) pushSkip(args[1]);
      if (args[0] && args[0].type === 'ObjectExpression') {
        for (const pr of args[0].properties || []) {
          const k = pr.key && (pr.key.name || pr.key.value);
          if (k === 'defaultMessage') pushSkip(pr.value);
        }
      }
    }
    // console.* 的实参不改（与 bareChinese 同口径：那是给开发者看的日志）
    if (
      nd.type === 'CallExpression' && nd.callee && nd.callee.type === 'MemberExpression' &&
      nd.callee.object && nd.callee.object.type === 'Identifier' && nd.callee.object.name === 'console'
    ) {
      for (const a of nd.arguments || []) pushSkip(a);
    }

    const line = nd.loc ? nd.loc.start.line : 0;
    if (nd.type === 'StringLiteral' && HAN.test(nd.value) && !inSkip(nd)) {
      const key = map[nd.value];
      if (key) {
        // JSX 属性里的字符串要包一层 {}（`label="中文"` → `label={t(...)}`）
        const isJsxAttrValue = parent && parent.type === 'JSXAttribute' && parent.value === nd;
        edits.push({
          start: nd.start,
          end: nd.end,
          kind: isJsxAttrValue ? 'jsxAttr' : 'literal',
          key,
          line,
          text: isJsxAttrValue ? `{t(${q(key)}, ${q(nd.value)})}` : `t(${q(key)}, ${q(nd.value)})`,
        });
      } else {
        unmapped.push({ line, kind: 'StringLiteral', text: nd.value });
      }
    } else if (nd.type === 'JSXText' && HAN.test(nd.value)) {
      const trimmed = nd.value.trim();
      const key = map[trimmed] || map[nd.value];
      if (key) {
        const lead = nd.value.slice(0, nd.value.indexOf(trimmed));
        const tail = nd.value.slice(nd.value.indexOf(trimmed) + trimmed.length);
        // 🔴 JSX 文本节点里换行+缩进会被 React 折叠掉；这里保留**同一行内**的前后空白，跨行的按 JSX 规则不留
        const keepLead = /\n/.test(lead) ? '' : lead;
        const keepTail = /\n/.test(tail) ? '' : tail;
        edits.push({
          start: nd.start,
          end: nd.end,
          kind: 'jsxText',
          key,
          line,
          text: `${keepLead}{t(${q(key)}, ${q(trimmed)})}${keepTail}`,
        });
      } else if (trimmed) {
        unmapped.push({ line, kind: 'JSXText', text: trimmed });
      }
    } else if (nd.type === 'TemplateLiteral' && HAN.test(nd.value === undefined ? (nd.quasis || []).map((x) => x.value.raw).join('') : '')) {
      templates.push({ line, text: (nd.quasis || []).map((x) => x.value.raw).join('${…}') });
    }

    for (const k of Object.keys(nd)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'start' || k === 'end') continue;
      const v = nd[k];
      if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && x.type && walk(x, nd));
      else if (v && typeof v === 'object' && v.type) walk(v, nd);
    }
  };
  walk(ast.program, null);

  // 🔴 从后往前改（否则前面的改写会让后面的位置失效）
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  // 插 hook（只在文件里还没有 `const t =` 时）
  if (opts.hookAnchor && !/const\s+t\s*=/.test(out)) {
    const n = out.split(opts.hookAnchor).length - 1;
    if (n !== 1) {
      console.error(`🔴 --hook-anchor 命中 ${n} 次（期望 1）⇒ 没有插入 hook，请先修锚点`);
      process.exit(3);
    }
    let body = "  const intl = useIntl();\n  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);\n";
    if (opts.hookBody) body = fs.readFileSync(path.resolve(opts.hookBody), 'utf8');
    out = out.replace(opts.hookAnchor, opts.hookAnchor + '\n' + body.replace(/\n$/, ''));
  }

  const after = (() => {
    try {
      return astInventory.bareChinese(out, opts.file).size;
    } catch (e) {
      return `解析失败：${String(e.message).slice(0, 90)}`;
    }
  })();

  console.log(`=== ${path.relative(process.cwd(), abs)} ===`);
  console.log(`  改写 ${edits.length} 处（literal ${edits.filter((e) => e.kind === 'literal').length} / jsxAttr ${edits.filter((e) => e.kind === 'jsxAttr').length} / jsxText ${edits.filter((e) => e.kind === 'jsxText').length}）`);
  console.log(`  裸中文：${before} → ${after}${typeof after === 'number' && after === 0 ? ' ✅' : ' 🔴 还没清完'}`);
  if (templates.length) {
    console.log(`  🔴 模板字符串 ${templates.length} 处要**手工**改成 ICU 整句（本工具不动它们）：`);
    templates.forEach((t) => console.log(`     L${t.line}  ${t.text.slice(0, 96)}`));
  }
  if (unmapped.length) {
    console.log(`  🔴 映射表里没有的中文 ${unmapped.length} 处：`);
    unmapped.slice(0, 12).forEach((u) => console.log(`     L${u.line} [${u.kind}] ${JSON.stringify(u.text).slice(0, 88)}`));
    if (unmapped.length > 12) console.log(`     …还有 ${unmapped.length - 12} 处`);
  }
  if (opts.dry) {
    console.log('  （--dry：没有写文件）');
    return;
  }
  fs.writeFileSync(abs, out);
  console.log(`  已写入 ${abs}`);
  try {
    astInventory.parseSource(out, opts.file);
    console.log('  ✅ 改写后仍可被 AST 解析');
  } catch (e) {
    console.log(`  🔴🔴 改写后**解析失败**：${String(e.message).slice(0, 120)}（文件已写入，请立即回滚：git checkout -- ${opts.file}）`);
    process.exit(4);
  }
}

main();
