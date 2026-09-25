/**
 * 🔴 上游组件库的**繁中**语言包审计（antd + @ant-design/pro-provider）。
 *
 * ## 为什么会有这个守卫（一次**错误结论**换来的）
 * 2026-09-26 期 3 第三批的活体探针里，高级设置页 ProForm 自带的提交按钮在 zh-TW 下渲染成「提 交」，
 * 当时**用眼睛判断**它是简体、并写进手册与提交信息，说"上游 pro-provider 的繁中包没翻干净"。
 * 🔴 **那个结论是错的**：`提` 与 `交` 两个字**简繁同形**（都不在简体专用字表里），
 * 「提 交」中间那个空格是 antd 给**两个汉字**的按钮插的（zh-CN 下同样有）。
 * 用仓库既有的权威尺子（`SIMPLIFIED_ONLY_ZH`，67 字）实测：
 * `pro-provider/es/locale/zh_TW.js` 有 **77** 个不同汉字、**命中 0 个**；
 * 同目录的 `zh_CN.js` 命中 **12** 个（复确认开请输设录时数据闭）⇒ 尺子在这批文件上**确实能测出简体**。
 *
 * 👉 **教训（本仓库第 N 次同源错误）**：
 * 🔴 **"这是简体字"这种判断必须走字符级审计，不能靠眼睛** —— 汉字里**简繁同形**的比例很高
 * （提/交/名/容/文/件/管/理…），两个字的按钮尤其容易看走眼；
 * 而本仓库**早就有**这把尺子（`--zh-tw-audit` 用的就是它），却没在下结论前用一次。
 *
 * ## 这个守卫守什么
 * admin 界面上有一部分文字**不是我们的 key**，而是 antd / pro-components 自己的语言包
 * （提交/重置按钮、分页文案、空状态、日期选择器…）。它们跟着 locale 走，
 * 所以 🔴 **上游繁中包里混进简体字，用户在 zh-TW 下就会看到简体** —— 那是我们的责任范围，
 * 但不是我们的文案 ⇒ 只能靠**审计 + 升级时重测**，不能靠翻译。
 *
 * ⚠️ 版本升级（antd / pro-components）时这条会重新量一遍：
 * 若哪天上游真的混进简体字，这条会红，并打印**具体是哪些字**。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const astInventory = require('../../../../scripts/i18n/astInventory.js');

const ADMIN = path.resolve(__dirname, '../..');
const SIMP = astInventory.SIMPLIFIED_ONLY_ZH;
const HAN = /[㐀-䶿一-鿿豈-﫿]/;

/** 用 admin 自己的解析路径找文件（🔴 不要手写 node_modules/.pnpm/… 那种路径：pnpm 的哈希目录会变）。 */
function resolveFromAdmin(request) {
  try {
    return require.resolve(request, { paths: [ADMIN, path.join(ADMIN, 'src')] });
  } catch (e) {
    return null;
  }
}

/**
 * 🔴 解析**间接依赖**：`@ant-design/pro-provider` 不是 admin 的直接依赖（它是 pro-form/pro-table 的依赖），
 * 而 pnpm 的严格 node_modules 布局下从 admin 直接 `require.resolve` 它**会失败**（第一版就是这么红的：
 * "解析不到 @ant-design/pro-provider"）。正确做法是**从直接依赖出发**再解析一层。
 */
function resolveThrough(directDep, request) {
  try {
    const pkgJson = require.resolve(`${directDep}/package.json`, { paths: [ADMIN] });
    return require.resolve(request, { paths: [path.dirname(pkgJson), ADMIN] });
  } catch (e) {
    return null;
  }
}

/** 一个 locale 文件的实测结果（不同汉字数 + 命中简体专用字表的字）。 */
function audit(file) {
  const src = fs.readFileSync(file, 'utf8');
  const chars = [...new Set(src.split('').filter((c) => HAN.test(c)))];
  const hits = chars.filter((c) => SIMP.includes(c));
  return { file, chars: chars.length, hits };
}

// 🔴 两份"用户在 zh-TW 下会看到"的上游繁中包（pro-* 全家共用 pro-provider 那一份，实测 7 个路径同一内容）
const UPSTREAM_TW = [
  ['antd', resolveFromAdmin('antd/es/locale/zh_TW')],
  ['@ant-design/pro-provider', resolveThrough('@ant-design/pro-form', '@ant-design/pro-provider/es/locale/zh_TW')],
];
// 对照组：同一批包的**简体**包 —— 用来证明尺子在这些文件上确实能测出简体（否则"0 命中"可能是空转）
const UPSTREAM_CN = [
  ['antd', resolveFromAdmin('antd/es/locale/zh_CN')],
  ['@ant-design/pro-provider', resolveThrough('@ant-design/pro-form', '@ant-design/pro-provider/es/locale/zh_CN')],
];

test('上游繁中审计 · 反空转：文件都解析到了，且里面真的有汉字', () => {
  for (const [name, file] of UPSTREAM_TW.concat(UPSTREAM_CN)) {
    assert.ok(file, `解析不到 ${name} 的 locale 文件（依赖结构变了？这条守卫会退化成恒真）`);
    assert.ok(fs.existsSync(file), `${name} 的 locale 文件不存在：${file}`);
    const a = audit(file);
    assert.ok(
      a.chars >= 40,
      `${name} 的 locale 文件只量到 ${a.chars} 个不同汉字（下界 40）⇒ 文件被换空了或解析错了，审计会假绿`,
    );
  }
  assert.ok(SIMP.length >= 60, `简体专用字表只有 ${SIMP.length} 个字（下界 60）⇒ 尺子被削了`);
});

/**
 * 🔴 **刻意保留的例外**（与 `SIMPLIFIED_ZH_ALLOWED_IN_ZH_TW` 同一套纪律：每条都要有理由、
 * 而且下面有一条"不许有死条目"的反向断言 —— 上游修好了这条就会红，提醒把例外删掉）。
 *
 * 实测（2026-09-26，antd@4.24.15）：`es/locale/zh_TW.js:58` 是 `downloadFile: '下载文件'`
 * —— 🔴 **上游把简体串抄进了繁中包**（同一段里邻居都是正确的繁中：刪除檔案 / 上傳失敗 / 檔案預覽）。
 * 但它在**本项目里不可达**。🔴 机制要读准（第一版把前提写成了 `showUploadList={false}`，那是**错的**：
 * 实测有 4 个文件根本没设 `showUploadList`，按那个前提这条守卫会红，而实际文案照样不可达）：
 * `downloadFile` 只被 `antd/es/upload/UploadList/ListItem.js:102` 用作**下载图标的 title**，
 * 而那个图标的渲染条件是 🔴 `showDownloadIcon && mergedStatus === 'done'`（同一文件 :100），
 * `showDownloadIcon` 的默认值是 `!!onDownload` ⇒ **只有传了 `showDownloadIcon` 或 `onDownload` 才会出现**。
 * 实测：admin 源码里这两个属性**一次都没出现**（只在 `.umi/.cache` 的构建产物里，那是 antd 自己的代码）。
 * ⚠️ 这个"不可达"是**有前提的**，所以下面单独有一条断言钉住前提（谁打开了上传列表，那条就会红）。
 *
 * 🔴 真要修（前提破了的时候）的配方：在 `app.jsx` 的 `rootContainer` 里再包一层 antd `ConfigProvider`，
 * `locale={{ ...zhTW, Upload: { ...zhTW.Upload, downloadFile: '下載檔案' } }}`
 * （⚠️ 必须传**整份** locale 并按当前语言在渲染期取；只传 Upload 会把 DatePicker/分页等文案一起丢掉）。
 */
const UPSTREAM_TW_ALLOWED = [
  {
    pkg: 'antd',
    ch: '载',
    where: 'es/locale/zh_TW.js 的 Upload.downloadFile（上游把简体串抄进了繁中包）',
    why: '该文案只用于下载图标的 title，而那个图标要 showDownloadIcon（默认 = !!onDownload）为真才渲染；admin 源码里两者都没出现 ⇒ 不可达',
  },
];

test('🔴 上游繁中语言包里不许出现简体专用字（zh-TW 用户会直接看到这些字）', () => {
  const bad = [];
  const hitAllowed = [];
  for (const [name, file] of UPSTREAM_TW) {
    const a = audit(file);
    for (const ch of a.hits) {
      const allowed = UPSTREAM_TW_ALLOWED.find((x) => x.pkg === name && x.ch === ch);
      if (allowed) hitAllowed.push(`${name}:${ch}`);
      else bad.push(`${name}: 「${ch}」 （${path.relative(ADMIN, file)}）`);
    }
  }
  // 🔴 反向：例外表里不许有**死条目**（上游修好了、或字表变了 ⇒ 这条会红，提醒删掉例外）
  const dead = UPSTREAM_TW_ALLOWED.map((x) => `${x.pkg}:${x.ch}`).filter((k) => !hitAllowed.includes(k));
  assert.deepEqual(
    dead,
    [],
    '🔴 这些"刻意保留的例外"已经不再命中了（上游修好了？字表变了？）⇒ 请把例外条目删掉：\n  ' +
      dead.join('\n  '),
  );
  assert.deepEqual(
    bad,
    [],
    '🔴 上游组件库的繁中语言包里有简体字（admin 在 zh-TW 下会显示简体）：\n  ' +
      bad.join('\n  ') +
      '\n怎么办：① 先看是不是版本升级带进来的（`git log -p` 那个包）；' +
      '\n  ② 若上游确实没翻干净，用 pro-provider 的 ConfigProvider/intlMap 在 app.jsx 覆盖那几条，' +
      '或给对应组件传 submitter/locale 属性 —— 🔴 **不要去改 node_modules**。',
  );
});

test('🔴 尺子自证：同一批包的**简体**包必须被测出简体（否则上面那条 0 命中是空转）', () => {
  const measured = UPSTREAM_CN.map(([name, file]) => ({ name, ...audit(file) }));
  for (const m of measured) {
    assert.ok(
      m.hits.length >= 3,
      `${m.name} 的 zh_CN 包只命中 ${m.hits.length} 个简体专用字（下界 3）⇒ ` +
        '尺子在这批文件上测不出简体，上面那条"繁中 0 命中"就没有意义了。' +
        `\n  实测：${JSON.stringify(measured)}`,
    );
  }
  // 🔴 并且把实测数字留在断言里（口径可复查）：这是"报数带口径"的最小实现
  assert.ok(
    measured.every((m) => m.chars >= 40),
    `对照组汉字数异常：${JSON.stringify(measured)}`,
  );
});

test('🔴 尺子自证（合成）：往繁中包的内容里塞一个简体字，必须被测出来', () => {
  const [, file] = UPSTREAM_TW[1];
  const src = fs.readFileSync(file, 'utf8');
  // 拿繁中包里**真实存在**的一个字做替换目标，保证注入后仍是"合法形状"的文件内容
  const victim = [...new Set(src.split('').filter((c) => HAN.test(c)))][0];
  const injected = SIMP[0]; // 简体专用字表里的第一个字
  assert.notStrictEqual(victim, injected, '样本字恰好就是简体字 ⇒ 换一个');
  const mutated = src.replace(victim, injected);
  const chars = [...new Set(mutated.split('').filter((c) => HAN.test(c)))];
  const hits = chars.filter((c) => SIMP.includes(c));
  assert.ok(
    hits.includes(injected),
    `注入 ${injected} 之后没被测出来（命中 ${JSON.stringify(hits)}）⇒ 判据是坏的`,
  );
});

test('🔴 例外的**前提**必须自己会检查：admin 里没有任何 Upload 会渲染出那个下载图标', () => {
  // 上面那条例外成立的理由是"downloadFile 这个 title 在本项目里不可达"。
  // 🔴 但"不可达"是**会被将来的改动打破的前提** ⇒ 与其写在注释里烂掉，不如让它自己会红。
  // 🔴 判据必须是**渲染条件本身**（showDownloadIcon / onDownload），不是"看着相关"的属性：
  //    第一版量的是 showUploadList={false}，结果 4 个文件没设它就红了 —— 那是**尺子选错**，不是前提破了。
  const SRC = path.join(ADMIN, 'src');
  const SKIP = new Set(['node_modules', '.umi', '.umi-production', 'locales']);
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const a = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(a);
      } else if (['.js', '.jsx', '.ts', '.tsx'].includes(path.extname(e.name))) files.push(a);
    }
  })(SRC);
  // 🔴 剔除注释再数（本仓库已三次栽在"注释里写了别处要搜索的字面量"）
  const codeOnly = (t) =>
    t
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => {
        const x = l.trim();
        return !x.startsWith('//') && !x.startsWith('*');
      })
      .join('\n');
  const risky = [];
  let uploads = 0;
  for (const f of files) {
    const src = codeOnly(fs.readFileSync(f, 'utf8'));
    const n = src.split('<Upload').length - 1;
    if (!n) continue;
    uploads += n;
    for (const prop of ['showDownloadIcon', 'onDownload']) {
      if (src.includes(prop)) risky.push(`${path.relative(ADMIN, f)}: <Upload 用了 ${prop}`);
    }
  }
  assert.ok(uploads >= 3, `只量到 ${uploads} 个 <Upload（下界 3）⇒ 判据或遍历坏了，这条会假绿`);
  assert.deepEqual(
    risky,
    [],
    '🔴 有 Upload 会让 antd 渲染下载图标 ⇒ 上面那条「载」的例外**前提破了**：\n  ' +
      risky.join('\n  ') +
      '\nantd@4.24.15 的繁中包在 Upload.downloadFile 上是简体（下载文件），现在它会被用户看到。' +
      '\n修法见本文件 UPSTREAM_TW_ALLOWED 上面的配方（app.jsx 里再包一层 ConfigProvider 覆盖那一条），' +
      '\n修完把例外条目删掉。',
  );
});

test('口径记录：两份上游繁中包的实测汉字数（升级依赖时会变，变了就要复核）', () => {
  const measured = UPSTREAM_TW.map(([name, file]) => `${name}=${audit(file).chars}`);
  // 🔴 这条不断言具体数字（依赖升级本来就会变），只把实测值**打印出来**留档；
  //    真正承重的是上面三条。⚠️ 刻意不写成断言：把"会随依赖变化的数字"钉死只会制造假红。
  assert.ok(measured.length === 2, `应该量到 2 份上游繁中包，实际 ${measured.length}`);
  console.log(`    上游繁中包汉字数：${measured.join(' / ')}（简体专用字表 ${SIMP.length} 字）`);
});
