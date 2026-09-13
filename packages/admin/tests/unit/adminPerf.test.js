const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.umi' || name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(full);
  }
  return out;
}

describe('后台性能：按需加载重依赖', () => {
  it('不再从 @ant-design/pro-components 桶里导入（35 处已全部改成具体包）', () => {
    const offenders = walk(path.join(adminRoot, 'src')).filter((f) =>
      readFileSync(f, 'utf8').includes("'@ant-design/pro-components'"),
    );
    assert.deepEqual(
      offenders.map((f) => path.relative(adminRoot, f)),
      [],
    );
    // 用到的具体包本来就是依赖，别改回桶
    assert.match(read('src/pages/Article/index.jsx'), /@ant-design\/pro-table/);
    assert.match(read('src/pages/Article/index.jsx'), /@ant-design\/pro-layout/);
  });

  it('KaTeX 只在正文有公式时才加载', () => {
    const editor = read('src/components/Editor/index.tsx');
    assert.doesNotMatch(editor, /^import math from '@bytemd\/plugin-math-ssr';/m);
    assert.doesNotMatch(editor, /^import 'katex\/dist\/katex\.css';/m);
    assert.match(editor, /import\('@bytemd\/plugin-math-ssr'\)/);
    assert.match(editor, /import\('katex\/dist\/katex\.css'\)/);
    assert.match(editor, /\.\.\.\(mathPlugin \? \[mathPlugin\] : \[\]\)/);
    // 嗅探规则和前台一致：漏判会让公式显示成原文
    assert.match(editor, /hasMath/);
  });

  it('表情选择器点开才下载 @emoji-mart/data', () => {
    const emoji = read('src/components/Editor/emoji.tsx');
    assert.doesNotMatch(emoji, /^import data from '@emoji-mart\/data';/m);
    assert.doesNotMatch(emoji, /^import Picker from '@emoji-mart\/react';/m);
    assert.match(emoji, /import\('@emoji-mart\/react'\)/);
    assert.match(emoji, /import\('@emoji-mart\/data'\)/);
    assert.match(emoji, /function ensurePicker/);
    // editorEffect 只建容器，不渲染 Picker
    assert.match(emoji, /currentEditor = ctx\.editor/);
    assert.doesNotMatch(emoji, /editorEffect: \(ctx\) => \{\s*const el = \(/);
  });

  it('mermaid 只打一份产物（三个 import() 回退 = dist 里三份 mermaid）', () => {
    const safety = read('src/components/Editor/plugins/mermaidSafety.ts');
    // 只保留 UMD 压缩版这一条动态导入路径
    assert.match(safety, /return await import\('mermaid\/dist\/mermaid\.min\.js'\)/);
    // 非压缩版与 ESM 入口都会各自打一份产物（后者还是 #391 崩溃的那条路径）
    assert.doesNotMatch(safety, /loaders\s*=\s*\[/);
    const codeOnly = safety
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    const imports = codeOnly.match(/import\('mermaid[^']*'\)/g) || [];
    assert.equal(imports.length, 1, `mermaid 动态导入应为 1 处，实际 ${imports.length}`);
  });

  it('首页三个 tab 懒加载（@ant-design/plots 是 G2，很重）', () => {
    const welcome = read('src/pages/Welcome/index.jsx');
    assert.match(welcome, /lazy\(\(\) => import\('\.\/tabs\/overview'\)\)/);
    assert.match(welcome, /lazy\(\(\) => import\('\.\/tabs\/article'\)\)/);
    assert.match(welcome, /lazy\(\(\) => import\('\.\/tabs\/viewer'\)\)/);
    assert.equal((welcome.match(/<Suspense/g) || []).length, 3);
  });
});

describe('后台性能：构建配置与图片', () => {
  it('不再为 IE11 打 polyfill', () => {
    const cfg = read('config/config.js');
    // 只看真正的配置项（注释里会提到旧写法）
    const configLines = cfg
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(configLines, /ie:\s*11/);
    assert.match(configLines, /chrome:\s*80/);
  });

  it('图片管理页的缩略图懒加载 + 异步解码（一页最多 60 张）', () => {
    const img = read('src/pages/Static/img/index.tsx');
    assert.equal((img.match(/loading="lazy"/g) || []).length, 2);
    assert.equal((img.match(/decoding="async"/g) || []).length, 2);
    // 网格视图用缩略图，点开预览才拉原图
    assert.match(img, /thumbMode \? getThumbLink\(item\) : `\$\{item\.realPath\}`/);
  });

  it('MFSU 依赖的两个 pnpm patch 必须在（否则后台整页白屏）', () => {
    // umi3 的 MFSU 只读 main/module、不认 exports 映射：这两个 ESM-only 包没有 main，
    // 预打包会 AssertionError，mf-va_remoteEntry.js 生不出来 → ScriptExternalLoadError 白屏。
    const rootPkg = JSON.parse(read('../../package.json'));
    const patched = rootPkg?.pnpm?.patchedDependencies || {};
    assert.ok(patched['remark-supersub@1.0.0'], '缺少 remark-supersub 的 patch 登记');
    assert.ok(
      patched['remark-github-blockquote-alert@2.1.0'],
      '缺少 remark-github-blockquote-alert 的 patch 登记',
    );
    for (const rel of Object.values(patched)) {
      assert.match(read(`../../${rel}`), /\+.*"main": "lib\/index\.js"/);
    }
    // MFSU 是开着的（关掉的话 dev 冷启动从 ~25s 变 ~2min）
    assert.match(read('config/config.js'), /mfsu: \{\}/);
    // 已安装的包里确实带上了 main（patch 生效）
    for (const pkg of ['remark-supersub', 'remark-github-blockquote-alert']) {
      const installed = require(`${adminRoot}/node_modules/${pkg}/package.json`);
      assert.equal(installed.main, 'lib/index.js', `${pkg} 的 patch 没生效`);
    }
  });

  it('路由级代码分割与产物指纹仍然开着', () => {
    const cfg = read('config/config.js');
    assert.match(cfg, /dynamicImport: \{/);
    assert.match(cfg, /hash: true/);
    assert.match(cfg, /ignoreMomentLocale: true/);
    assert.match(cfg, /esbuild: \{\}/);
  });
});
