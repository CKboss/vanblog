/**
 * 🔴 编辑器（bytemd）的界面文案**跟随站点语言** —— 这是正向性质守卫。
 *
 * 历史：本文件的前身叫 `i18nEditorLocalesKnownGap.test.js`，钉的是**已知缺陷的现状**
 * （`Editor/locales.ts` 只导出一个单语常量 `cn`、对 umi locale 运行时引用数为 0
 * ⇒ 编辑器界面永远中文）。那条守卫在写下来时就注明「期 2 改造时本条应当被有意改红」，
 * 而 2026-09-25 的期 2 改造正是这么做的 ⇒ **本文件是它的反转版**，钉的是期望行为。
 *
 * 🔴 实现形状（实测依据都写在 `Editor/locales.ts` 的文件头注释里）：
 *   66 条旧文案中有 62 条是上游 locale 文件的**逐字副本**（bytemd 47 + plugin-gfm 6 + plugin-mermaid 9），
 *   所以现在**直接复用上游 JSON**，只手写上游不提供的部分：
 *     - `@bytemd/plugin-mermaid` **不提供 `zh_Hant.json`** ⇒ 繁中 11 个图表名手写（地区用词）；
 *     - `@bytemd/plugin-math-ssr` **完全不带 locale 文件**（只有内置英文默认值）⇒ 公式 4 条三语手写。
 *   合成后每种语言 **68 条**，三份 key 集合完全相同。
 *
 * 🔴 本守卫钉的五类性质：
 *   A 上游契约（三份文件存在、各自同形、mermaid 确实没有繁中）；
 *   B 我们手写的部分与上游 key 集合一致（防上游加/改键名后我们静默漏译）；
 *   C 合成后三份同形 + 叶子值差异白名单（防"复制中文当英文/繁中"）；
 *   D 接线正确（渲染期选择、四处消费、稳定引用、无裸 `cn`）；
 *   E 尺子反证（合成输入必须被点名，证明上面的比对真的在比）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// 🔴 __dirname 是 packages/admin/tests/unit ⇒ 要回退两层才是 packages/admin（此前只退了一层，
// 结果把 `packages/admin/tests/src/...` 当成源文件路径 ⇒ 守卫报"必须存在"而失败）
const ADMIN = path.resolve(__dirname, '../..');
const REPO = path.resolve(ADMIN, '../..');
const SRC = path.join(ADMIN, 'src');
const LOCALES_TS = path.join(SRC, 'components/Editor/locales.ts');
const EDITOR_TSX = path.join(SRC, 'components/Editor/index.tsx');
const SHARED = path.join(REPO, 'scripts/i18n/astInventory.js');
const INVENTORY = path.join(REPO, 'scripts/i18n/inventory.js');

const readOrFail = (p) => {
  assert.ok(fs.existsSync(p), `必须存在：${p}（找不到就说明被改名/挪走了，请先更新本守卫的路径）`);
  return fs.readFileSync(p, 'utf8');
};
/** 🔴 从 admin 自己的 node_modules 解析上游 locale（不要拼 pnpm 的哈希目录名，那会随版本漂）。 */
const upstream = (spec) => JSON.parse(fs.readFileSync(require.resolve(spec, { paths: [ADMIN] }), 'utf8'));
const keys = (o) => Object.keys(o).sort();
const sameKeys = (a, b) => JSON.stringify(keys(a)) === JSON.stringify(keys(b));

/** 🔴 从 locales.ts 的源码里取出手写常量（用共享 AST 模块解析，不用正则）。 */
function handWritten() {
  const m = require(SHARED);
  const ast = m.parseSource(readOrFail(LOCALES_TS), 'Editor/locales.ts');
  const out = {};
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'VariableDeclarator' && n.id && n.id.name && n.init && n.init.type === 'ObjectExpression') {
      const o = {};
      let allStrings = true;
      for (const p of n.init.properties) {
        if (p.type === 'ObjectProperty' && p.value && p.value.type === 'StringLiteral') o[p.key.name || p.key.value] = p.value.value;
        else allStrings = false;
      }
      // 只收"全是字符串字面量"的对象 ⇒ EDITOR_LOCALES（含 spread）不会被误收
      if (allStrings && Object.keys(o).length > 0) out[n.id.name] = o;
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && v.type) walk(v);
    }
  };
  walk(ast);
  return out;
}

/**
 * 🔴 用 AST 收集「调用了哪些函数名」与「导出了哪些绑定名」。
 * 为什么不用源码文本搜索：本文件的判据必须**与注释无关** ——
 * `locales.ts` 的头注释里就写着旧形状的 `export const cn` 与 `getLocale()`（用来说明历史与约束），
 * 裸文本搜索会把注释里的提及当成代码 ⇒ 假红。
 * （这正是手册里「注释里不要写别处要断言的字面量」那条的反面教训：
 *   与其要求所有人不写，不如让判据本身剥掉注释。）
 */
function astFacts(file) {
  const m = require(SHARED);
  const ast = m.parseSource(readOrFail(file), path.basename(file));
  const calls = [];
  const exportedBindings = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (c && c.type === 'Identifier') calls.push(c.name);
      if (c && c.type === 'MemberExpression' && c.property && c.property.type === 'Identifier') calls.push(c.property.name);
    }
    if (n.type === 'ExportNamedDeclaration' && n.declaration) {
      const d = n.declaration;
      // 🔴 三种导出形状都要收：变量（`export const X`）、函数（`export function X`）、类
      if (d.type === 'VariableDeclaration') {
        for (const x of d.declarations) if (x.id && x.id.name) exportedBindings.push(x.id.name);
      } else if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id && d.id.name) {
        exportedBindings.push(d.id.name);
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && v.type) walk(v);
    }
  };
  walk(ast);
  return { calls, exportedBindings };
}

test('编辑器文案跟随语言：上游复用 + 手写补充 + 渲染期选择（期 2 改造后的正向性质）', async (t) => {
  const locales = readOrFail(LOCALES_TS);
  const editor = readOrFail(EDITOR_TSX);
  const hw = handWritten();

  await t.test('A 反空转：上游三个包的 locale 文件都真的解析到了（否则下面所有比对都是空的绿）', () => {
    const core = upstream('bytemd/locales/zh_Hans.json');
    const gfm = upstream('@bytemd/plugin-gfm/locales/zh_Hans.json');
    const mmd = upstream('@bytemd/plugin-mermaid/locales/zh_Hans.json');
    assert.ok(Object.keys(core).length >= 40, `bytemd zh_Hans 应当 ≥40 条（实测 ${Object.keys(core).length}）`);
    assert.ok(Object.keys(gfm).length >= 5, `plugin-gfm zh_Hans 应当 ≥5 条（实测 ${Object.keys(gfm).length}）`);
    assert.ok(Object.keys(mmd).length >= 9, `plugin-mermaid zh_Hans 应当 ≥9 条（实测 ${Object.keys(mmd).length}）`);
  });

  await t.test('A 上游同形性：bytemd 与 gfm 各自的三份 locale key 集合相同（我们依赖这个前提）', () => {
    assert.ok(sameKeys(upstream('bytemd/locales/zh_Hans.json'), upstream('bytemd/locales/zh_Hant.json')), 'bytemd zh_Hans 与 zh_Hant 不同形');
    assert.ok(sameKeys(upstream('bytemd/locales/zh_Hans.json'), upstream('bytemd/locales/en.json')), 'bytemd zh_Hans 与 en 不同形');
    assert.ok(sameKeys(upstream('@bytemd/plugin-gfm/locales/zh_Hans.json'), upstream('@bytemd/plugin-gfm/locales/zh_Hant.json')), 'gfm zh_Hans 与 zh_Hant 不同形');
    assert.ok(sameKeys(upstream('@bytemd/plugin-gfm/locales/zh_Hans.json'), upstream('@bytemd/plugin-gfm/locales/en.json')), 'gfm zh_Hans 与 en 不同形');
  });

  await t.test('A 🔴 mermaid 上游确实没有繁中 —— 这正是我们必须手写 11 条的理由；上游若补上，本条会红（那时应删掉手写副本）', () => {
    let has = true;
    try { upstream('@bytemd/plugin-mermaid/locales/zh_Hant.json'); } catch { has = false; }
    assert.strictEqual(has, false, '🔴 @bytemd/plugin-mermaid 现在提供 zh_Hant.json 了 ⇒ 手写副本可以删掉，请改本守卫与 locales.ts');
  });

  await t.test('B 手写的 mermaid 繁中 key 集合 == 上游 mermaid 简中的 key 集合（防上游改键名后我们静默漏译）', () => {
    const mmdHans = upstream('@bytemd/plugin-mermaid/locales/zh_Hans.json');
    assert.ok(hw.MERMAID_ZH_HANT, 'locales.ts 里必须能手写常量 MERMAID_ZH_HANT');
    assert.ok(sameKeys(hw.MERMAID_ZH_HANT, mmdHans), `key 集合不一致：手写=${keys(hw.MERMAID_ZH_HANT).join(',')} 上游=${keys(mmdHans).join(',')}`);
  });

  await t.test('B 公式插件的三语 key 集合相同（上游不提供任何 locale，四条全靠我们）', () => {
    for (const n of ['MATH_ZH_HANS', 'MATH_ZH_HANT', 'MATH_EN']) assert.ok(hw[n], `缺少手写常量 ${n}`);
    assert.ok(sameKeys(hw.MATH_ZH_HANS, hw.MATH_ZH_HANT) && sameKeys(hw.MATH_ZH_HANS, hw.MATH_EN), '公式三语 key 集合不同形');
    assert.strictEqual(keys(hw.MATH_ZH_HANS).length, 4, `公式应当恰好 4 条（实测 ${keys(hw.MATH_ZH_HANS).length}）`);
  });

  await t.test('C 🔴 合成后三份 key 集合完全相同，且各 68 条（递归同形的扁平版）', () => {
    const core = { hans: upstream('bytemd/locales/zh_Hans.json'), hant: upstream('bytemd/locales/zh_Hant.json'), en: upstream('bytemd/locales/en.json') };
    const gfm = { hans: upstream('@bytemd/plugin-gfm/locales/zh_Hans.json'), hant: upstream('@bytemd/plugin-gfm/locales/zh_Hant.json'), en: upstream('@bytemd/plugin-gfm/locales/en.json') };
    const mmdHans = upstream('@bytemd/plugin-mermaid/locales/zh_Hans.json');
    const mmdEn = upstream('@bytemd/plugin-mermaid/locales/en.json');
    const cn = { ...core.hans, ...gfm.hans, ...mmdHans, ...hw.MATH_ZH_HANS };
    const tw = { ...core.hant, ...gfm.hant, ...hw.MERMAID_ZH_HANT, ...hw.MATH_ZH_HANT };
    const en = { ...core.en, ...gfm.en, ...mmdEn, ...hw.MATH_EN };
    assert.strictEqual(keys(cn).length, 68, `zh-CN 应当 68 条（实测 ${keys(cn).length}）`);
    assert.ok(sameKeys(cn, tw), 'zh-CN 与 zh-TW 的 key 集合不同');
    assert.ok(sameKeys(cn, en), 'zh-CN 与 en-US 的 key 集合不同');
    // 🔴 三个上游来源零重叠（否则合并顺序会影响结果）
    const ov = (a, b) => keys(a).filter((k) => k in b);
    assert.deepStrictEqual(ov(core.hans, gfm.hans), [], 'bytemd 与 gfm 的 key 有重叠');
    assert.deepStrictEqual(ov(core.hans, mmdHans), [], 'bytemd 与 mermaid 的 key 有重叠');
    assert.deepStrictEqual(ov(gfm.hans, mmdHans), [], 'gfm 与 mermaid 的 key 有重叠');
    t.cn = cn; t.tw = tw; t.en = en;
  });

  await t.test('C 🔴 en-US 的叶子值必须与 zh-CN 不同，例外恰好是实测白名单（防"复制中文当英文"）', () => {
    const { cn, en } = t;
    const WHITELIST = ['imageAlt']; // 值就是拉丁字母 'alt'，两种语言本来就一样
    const same = keys(cn).filter((k) => cn[k] === en[k]);
    assert.deepStrictEqual(same.sort(), WHITELIST.slice().sort(), `en-US 与 zh-CN 相同的 key 应当恰好是 ${JSON.stringify(WHITELIST)}，实测 ${JSON.stringify(same)}`);
  });

  await t.test('C 🔴 zh-TW 与 zh-CN 相同的叶子必须恰好等于实测白名单（简繁同形词；多一条少一条都红）', () => {
    const { cn, tw } = t;
    const WHITELIST = ['blockText', 'exitFullscreen', 'fullscreen', 'imageAlt', 'inlineText', 'quote', 'quotedText', 'strikeText', 'table'];
    const same = keys(cn).filter((k) => cn[k] === tw[k]);
    assert.deepStrictEqual(same.sort(), WHITELIST.slice().sort(), `简繁同形的 key 应当恰好是这 ${WHITELIST.length} 个，实测 ${JSON.stringify(same)}`);
  });

  await t.test('C 🔴 繁中的地区用词真的用了（不是字形转换）—— 抽查几个只有地区用词才对的', () => {
    const { tw, cn } = t;
    assert.strictEqual(tw.mindmap, '心智圖', 'mindmap 的繁中应当是地区用词「心智圖」');
    assert.strictEqual(tw.pie, '圓餅圖', 'pie 的繁中应当是地区用词「圓餅圖」');
    assert.strictEqual(tw.uj, '使用者旅程圖', 'uj 的繁中应当用「使用者」而不是「用户」');
    assert.notStrictEqual(tw.link, cn.link, 'link 的简繁应当不同（上游给的是 链接 / 連結）');
  });

  await t.test('D 🔴 语言选择发生在渲染期，不在模块加载期（getLocale 依赖 umi 插件运行时已初始化）', () => {
    // 🔴 用 AST 判「有没有**调用**」，不是「文本里有没有出现」——头注释里提到 getLocale 是合法的说明
    const lf = astFacts(LOCALES_TS);
    assert.strictEqual(lf.calls.filter((n) => n === 'getLocale').length, 0,
      '🔴 locales.ts 不许**调用** getLocale —— 模块加载期调用会拿到 undefined（注释里提到它是允许的）');
    assert.ok(/import\s*\{[^}]*\bgetLocale\b[^}]*\}\s*from\s*'umi'/.test(editor), "index.tsx 必须从 'umi' 导入 getLocale");
    assert.ok(/pickEditorLocale\(\s*getLocale\(\)\s*\)/.test(editor), 'index.tsx 必须在渲染期调用 pickEditorLocale(getLocale())');
  });

  await t.test('D 🔴 四处消费都改成了 editorLocale，且不再有裸 cn（旧的单语常量已彻底移除）', () => {
    assert.ok(!/\bcn\b/.test(editor), '🔴 index.tsx 里还有裸 cn —— 旧的单语常量没清干净');
    // 🔴 用 AST 判「有没有**导出** cn 这个绑定」，不是「文本里有没有 `export const cn`」
    const lf2 = astFacts(LOCALES_TS);
    assert.ok(!lf2.exportedBindings.includes('cn'),
      `🔴 locales.ts 还在导出旧的单语常量 cn（导出的绑定：${lf2.exportedBindings.join(', ')}）`);
    assert.ok(lf2.exportedBindings.includes('EDITOR_LOCALES') && lf2.exportedBindings.includes('pickEditorLocale'),
      `🔴 locales.ts 必须导出 EDITOR_LOCALES 与 pickEditorLocale（实测导出：${lf2.exportedBindings.join(', ')}）`);
    // 🔴 期 6 第一批新增第 5 处消费：**移动端工具栏**的 11 个标题改为读 editorLocale
    //    （它们以前是手抄的中文，与上游 bytemd 的 zh_Hans 值逐字相同 ⇒ 不该自己再维护一份）
    for (const frag of ['factory({ locale: editorLocale })', 'gfm({ locale: editorLocale, singleTilde: false })', 'mermaidForEditor({ locale: editorLocale })', 'locale={editorLocale}', 'locale: editorLocale,']) {
      assert.ok(editor.includes(frag), `缺少接线：${frag}`);
    }
    // 🔴 计数口径改成**只看代码行**（剔除注释）：上一版连注释一起数，
    //    于是"在注释里提到 editorLocale"也会改变这个数（本批加了一段说明注释就红了）。
    //    👉 计数量到的必须是**代码**，不是文本（同族教训：counters after head / 注释里的字面量）。
    const editorCode = editor
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n');
    assert.strictEqual(
      (editorCode.match(/editorLocale/g) || []).length,
      8,
      'editorLocale 在**代码**里应当出现 8 次（1 定义 + 5 消费 + 2 个依赖数组）',
    );
  });

  await t.test('C2 🔴 移动端工具栏那 11 个标题：上游三种语言的 locale 都必须有对应的 key（否则退化成显示 id）', () => {
    // ## 为什么要有这条（2026-09-26 期 6 第一批）
    // 工具栏标题从"手抄中文"改成"读上游 bytemd locale"（那 11 个值与上游 zh_Hans **逐字相同**）⇒
    // 🔴 新风险：上游哪天改名/删 key，按钮就会**静默退化成 id**（直接显示 `bold`）。
    // ⚠️ 这里**不 require `locales.ts`**（它是 .ts，裸 node 加载不了）⇒ 直接量上游 JSON + 那个 CJS 插件模块。
    const mt = require('../../src/components/Editor/plugins/mobileToolbar.js');
    const needed = mt.MOBILE_TOOLBAR_ACTION_KEYS.map((a) => a.localeKey)
      .concat(mt.HEADING_LEVELS.map((h) => h.localeKey));
    assert.strictEqual(needed.length, 11, `应当是 11 个标题，实测 ${needed.length}`);
    const sources = {
      'zh-CN': upstream('bytemd/locales/zh_Hans.json'),
      'zh-TW': upstream('bytemd/locales/zh_Hant.json'),
      'en-US': upstream('bytemd/locales/en.json'),
    };
    for (const [lang, locale] of Object.entries(sources)) {
      for (const key of needed) {
        assert.ok(
          typeof locale[key] === 'string' && locale[key].length > 0,
          `🔴 上游 ${lang} 的 locale 缺少 \`${key}\`（移动端工具栏会退化成显示 id）`,
        );
      }
    }
    // 🔴 identity 视图（不传 locale）必须与改造前**逐字相同** —— mobileToolbar.test.js 的黄金样本靠它
    assert.deepEqual(
      mt.MOBILE_TOOLBAR_ACTIONS.map((a) => a.title),
      ['标题', '粗体', '斜体', '引用', '链接', '图片', '无序列表', '代码'],
    );
    assert.deepEqual(
      mt.buildHeadingLevels(sources['zh-CN']).map((h) => h.title),
      ['一级标题', '二级标题', '三级标题'],
      'zh-CN 下三个标题级别必须与改造前逐字相同',
    );
    assert.deepEqual(
      mt.buildHeadingLevels(undefined).map((h) => h.title),
      ['h1', 'h2', 'h3'],
      '没有 locale 时退化成可见占位（不是空白、也不是中文）',
    );
    // 🔴 繁中要用**上游的地区用词**（不是字形转换）：实测 zh_Hant 给的是 標題/粗體/連結/圖像
    assert.equal(sources['zh-TW'].bold, '粗體');
    assert.equal(sources['zh-TW'].link, '連結');
    assert.equal(sources['zh-TW'].image, '圖像');
    assert.equal(sources['zh-TW'].h1, '一級標題');
    assert.equal(sources['en-US'].h1, 'Heading 1');
    // 🔴 locales.ts 必须仍然把上游 bytemd 的核心 locale 并进这三种语言（否则上面这些 key 到不了编辑器）
    const localesSrc = readOrFail(LOCALES_TS);
    for (const spec of ["bytemd/locales/zh_Hans.json", "bytemd/locales/zh_Hant.json", "bytemd/locales/en.json"]) {
      assert.ok(localesSrc.includes(spec), `🔴 locales.ts 必须并入上游 ${spec}（工具栏标题就靠它）`);
    }
  });

  await t.test('C3 🔴 容器模板与 remark 识别的标题是**同一套契约的两端**（改一边就会让存量文章的容器不渲染）', () => {
    // ## 为什么要有这条
    // `plugins/customContainer.tsx` 把 `:::info{title="相关信息"}` 这类**中文标题**插进用户文章正文，
    // 而 `plugins/customContainerRemark.js` 靠**同样那几个中文标题**识别并渲染容器。
    // 🔴 这 6 条模板因此是"内容 + 协议"，本轮**刻意不翻**（棘轮预算 6、REQUIRED_EXCEPTIONS 反向钉住）；
    // 但"两边必须一致"这件事以前**没有任何断言** ⇒ 谁改一边都不会红（存量文章的容器会静默变成普通段落）。
    const containerSrc = readOrFail(path.join(SRC, 'components/Editor/plugins/customContainer.tsx'));
    const remarkSrc = readOrFail(path.join(SRC, 'components/Editor/plugins/customContainerRemark.js'));
    for (const title of ['相关信息', '注', '注意', '警告', '提示']) {
      assert.ok(
        containerSrc.includes(`title="${title}"`),
        `🔴 容器模板里必须有 title="${title}"（它是插进用户正文的内容，也是识别契约的一端）`,
      );
      assert.ok(
        remarkSrc.includes(title),
        `🔴 remark 那端必须仍然识别「${title}」，否则存量文章里的这个容器会静默退化成普通段落`,
      );
    }
    for (const kind of ['info', 'note', 'warning', 'danger', 'tip']) {
      assert.ok(remarkSrc.includes(kind), `remark 端缺少容器类型 ${kind}`);
      assert.ok(containerSrc.includes(`:::${kind}`), `模板端缺少容器类型 ${kind}`);
    }
  });

  await t.test('D 🔴 editorLocale 进了两个依赖数组，且 pickEditorLocale 返回稳定引用（否则插件数组会被反复重建、编辑器状态被重置）', () => {
    // 🔴 期 6 第一批起依赖里还有 t（插件的标题现在由 t 产出）：t 必须是 useCallback([intl]) 的稳定引用，
    //    否则每次渲染都重建插件数组 ⇒ 编辑器状态被重置（这正是这条断言存在的理由）
    assert.ok(editor.includes('}, [themeClass, mathPlugin, editorLocale, t]);'), 'plugins 的 useMemo 依赖里必须有 editorLocale 与 t');
    assert.ok(/const t = useCallback\(/.test(editor), '🔴 t 必须用 useCallback 包成稳定引用（它会进 useMemo 依赖）');
    assert.ok(/\[intl\],\n?\s*\);/.test(editor) || editor.includes('[intl],'), '🔴 useCallback 的依赖必须是 [intl]');
    assert.ok(editor.includes('}, [hasMath, mathPlugin, editorLocale]);'), 'math 插件的 useEffect 依赖里必须有 editorLocale');
    assert.ok(/return EDITOR_LOCALES\[raw\];/.test(locales), 'pickEditorLocale 必须返回 EDITOR_LOCALES 里的引用（不是新建对象）');
    assert.ok(/return EDITOR_LOCALES\['en-US'\];/.test(locales), '兜底必须返回 en-US 那一份，绝不能返回 undefined（否则工具栏 tooltip 会显示 undefined）');
  });

  await t.test('E 🔴 尺子反证：本守卫的比对函数真的能抓出「少一个 key」与「多一个 key」', () => {
    const base = { a: '1', b: '2', c: '3' };
    assert.ok(sameKeys(base, { a: '1', b: '2', c: '3' }), '相同集合应当判为同形（正向）');
    assert.ok(!sameKeys(base, { a: '1', b: '2' }), '🔴 少一个 key 必须被判为不同形');
    assert.ok(!sameKeys(base, { a: '1', b: '2', c: '3', d: '4' }), '🔴 多一个 key 必须被判为不同形');
    assert.ok(!sameKeys(base, { a: '1', b: '2', x: '3' }), '🔴 改名必须被判为不同形');
  });

  await t.test('E 🔴 尺子反证：手写字段的解析器真的在解析（不是恒返回空对象）', () => {
    assert.ok(Object.keys(hw).length >= 4, `应当解析到 ≥4 个手写常量，实测 ${Object.keys(hw).length}：${Object.keys(hw).join(',')}`);
    assert.ok(!('EDITOR_LOCALES' in hw), 'EDITOR_LOCALES 含 spread，不应当被当成"全字符串字面量对象"收进来');
    assert.strictEqual(hw.MERMAID_ZH_HANT.pie, '圓餅圖', '解析出的值必须是真实内容，不能是空字符串');
  });

  await t.test('F 🔴 盘点归类：Editor/locales.ts 现在是「语言包（已多语言）」，不再是丙类"形似语言包"', () => {
    const inv = require(INVENTORY);
    const m = require(SHARED);
    const rel = 'src/components/Editor/locales.ts';
    const src = readOrFail(LOCALES_TS);
    const counts = m.collectChinese(src, rel);
    const cls = inv.classify(rel, src, counts);
    assert.ok(cls.startsWith('语言包'), `🔴 归类应当是「语言包（已多语言…）」，实测「${cls}」`);
    assert.ok(!cls.startsWith('丙'), '🔴 它不应当再被判为丙类（那只适用于"只提供单一语言"的文件）');
    // 🔴 反向：一个只提供单一语言的假语言包必须仍被判为丙类（证明判据没有被我改松）
    const fake = "export const cn = { bold: '粗体' };\n";
    const fakeCls = inv.classify('src/components/X/locales.ts', fake, m.collectChinese(fake, 'x/locales.ts'));
    assert.ok(fakeCls.startsWith('丙'), `🔴 单语假语言包应当仍判为丙类，实测「${fakeCls}」`);
  });
});
