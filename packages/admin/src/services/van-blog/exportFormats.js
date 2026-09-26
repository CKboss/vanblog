/**
 * 文章导出的格式选项（纯数据 + 纯函数，方便 node:test 直接跑，不需要 DOM）。
 *
 * 为什么要这个下拉：以前点「导出」**永远**回一个外层 zip（里面是原样 `.md` + 有图才有的
 * `.mdz` + 可能的 `导出说明.md`），想要一个能直接拖进 Typora/Obsidian 的 `.md` 还得先解包。
 * 现在三种格式并列，各说清代价：
 *   md  —— 只要正文，图片链接仍指向站点；服务端**完全不抓图**（快，也不碰外链）
 *   mdz —— Typora 风格图片包（相对路径 md + `<标题>.assets/`）；正文没有图片时服务端会回 400 说明
 *   zip —— 老行为，一次拿到全部（含导出说明）
 */
/**
 * 🔴 多语言：**注入式翻译器**（与 accessPassword.js / coverBackfill.js / revisionCore.js / tagTokens.js 同一套模式）。
 * 本模块是纯数据 + 纯函数（`node --test` 直接 require），模块加载期拿不到 umi 运行时 ⇒ 翻译器由消费方在渲染期注入。
 * 🔴 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前**逐字相同**（`exportFormats.test.js` / `markdownExport.test.js`
 * 的黄金样本一个字都不用改）。
 * 🔴 **函数体内不许引用 identity 常量**（那就等于"注入了 t 也不生效"，localePackParity 有一条判据专门盯这件事）。
 * ⚠️ `导出说明.md` 是**服务端产物的文件名**（`markdownExport.provider.ts` 里写死的 `relativePath`）⇒
 * 三种语言都必须保留这个字面名，英文那份也是（用户要在压缩包里找到它）。
 */
function interpolate(template, values) {
  if (!values) return String(template);
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
}
const IDENTITY_T = (id, defaultMessage, values) => interpolate(defaultMessage, values);

/**
 * 🔴 **服务端产物的文件名**（`packages/server/src/provider/export/markdownExport.provider.ts` 里
 * 写死的 `relativePath: '导出说明.md'`）⇒ 这是**线路契约**，不是文案：
 * 三种语言的界面都必须显示这个字面名，否则用户在压缩包里找不到那个文件。
 * 🔴 所以它**不进语言包**（语言包里那条文案用 `{note}` 占位符），也就不会污染
 * "en-US 不许出现汉字"与"zh-TW 不许出现简体专用字"那两条判据。
 * ⚠️ 它会让本文件的棘轮预算是 **1 而不是 0**（那是**有理由的**一条，不是漏网）；
 * 并且 `exportFormats.test.js` 里有一条**跨层反向断言**：服务端那个 `relativePath` 一旦改名，这里必须跟着改。
 */
const EXPORT_NOTE_FILENAME = '导出说明.md';

function exportFormats(t = IDENTITY_T) {
  return [
  {
    key: 'md',
    /** 下拉里的短标签 */
    label: 'Markdown (.md)',
    /** 一句话说明代价，放在下拉项的次要文字里 */
    hint: t('export.formatMdHint', '只要正文，图片仍指向站点（最快）'),
    ext: '.md',
  },
  {
    key: 'mdz',
    label: t('export.formatMdzLabel', 'Typora 图片包 (.mdz)'),
    hint: t('export.formatMdzHint', '正文 + 图片，链接改成相对路径'),
    ext: '.mdz',
  },
  {
    key: 'zip',
    label: t('export.formatZipLabel', '全部打包 (.zip)'),
    hint: t('export.formatZipHint', 'md + mdz + 导出说明，一次拿全'),
    ext: '-markdown.zip',
  },
  ];
}
/** 🔴 identity 视图：留给还没接 i18n 的消费方（`pages/Editor/index.jsx`）与黄金样本 */
const EXPORT_FORMATS = exportFormats();

const FORMAT_BY_KEY = EXPORT_FORMATS.reduce((acc, item) => {
  acc[item.key] = item;
  return acc;
}, {});

/** 归一化：只认这三个，其它（含 undefined / 乱写）一律回落到 zip = 老行为 */
function normalizeExportFormat(value) {
  return FORMAT_BY_KEY[value] ? value : 'zip';
}

/** 服务端没给 Content-Disposition 时的兜底文件名 */
function fallbackFileName(safeTitle, format) {
  const item = FORMAT_BY_KEY[normalizeExportFormat(format)];
  return `${safeTitle || 'article'}${item.ext}`;
}

/** 下载中提示：md 不打包图片，说"打包"是误导 */
function loadingText(format, t = IDENTITY_T) {
  return normalizeExportFormat(format) === 'md'
    ? t('export.loadingMd', '正在导出 Markdown…')
    : t('export.loadingPack', '正在打包 Markdown 与图片…');
}

/**
 * 导出成功后要不要提醒"图片没打进包"。
 *
 * ⚠️ 关键：`assetsPacked === false` 时（.md 格式）**根本不该弹那个警告** ——
 * 那个格式本来就不含图片，`packedImages=0` 不是失败。第一版没这个字段时，
 * 选 .md 导出带图文章会弹出「导出完成，但有图片没打进包」，看着像出了错。
 * 返回 null 表示不用弹；否则返回一段给 Modal 用的文案。
 */
function describeExportOutcome(report, format, t = IDENTITY_T) {
  const fmt = normalizeExportFormat(format);
  const r = report || {};
  if (fmt === 'md') {
    const refs = Number(r.imageRefs) || 0;
    if (refs <= 0) return null;
    return {
      title: t('export.outcomeMdTitle', '已导出 Markdown（不含图片）'),
      lines: [
        // 🔴 计数句一律**整句一个 key + ICU 占位符**（不要拼接：英文语序与复数都跟中文不同，
        //    见 §7.152 B / §7.156 B / §7.160 C / §7.161 A 那四次）
        t('export.outcomeMdRefs', '正文里识别到 {refs} 个图片引用，链接仍指向站点 —— 这是 .md 格式的预期行为。', {
          refs,
        }),
        t(
          'export.outcomeMdPickMdz',
          '需要把图片一起带走（例如离线用 Typora/Obsidian 打开），请改选 Typora 图片包 (.mdz)。',
        ),
      ],
      tone: 'info',
    };
  }
  // 没有图片 ⇒ 不会有 .mdz。这件事必须说清楚，否则用户会以为导出坏了
  // （zip 里只有一个 .md，或者选的 .mdz 被服务端拒了）。这条在改成下拉之前就存在，
  // 迁移到纯函数时差点被丢掉 —— 由 markdownExport.test.js 的钉子守着。
  if (r.hasMdz === false && (Number(r.imageRefs) || 0) === 0) {
    return {
      title:
        fmt === 'mdz'
          ? t('export.outcomeNoImagesMdzTitle', '这篇内容没有图片')
          : t('export.outcomeNoImagesTitle', '导出完成（这篇文章没有图片）'),
      lines: [
        t(
          'export.outcomeNoImagesWhy',
          '这篇文章没有图片，所以没有 .mdz —— .mdz 的意义就是把图片一起带走并改成相对路径。',
        ),
        fmt === 'mdz'
          ? t('export.outcomeNoImagesPickMd', '请改选 Markdown (.md)，内容是一样的。')
          : t('export.outcomeNoImagesAllContent', '拿到的 .md 就是全部内容。'),
      ],
      tone: 'info',
    };
  }
  const problems = (Number(r.failed) || 0) + (Number(r.skipped) || 0);
  if (problems <= 0) return null;
  return {
    title: t('export.outcomeProblemsTitle', '导出完成，但有图片没打进包'),
    lines: [
      // 🔴 这一句原来是"两段模板字符串相加"（4 个插值分成两句拼）⇒ 收成**一条**带 4 个 ICU 占位符的整句
      t(
        'export.outcomeProblemsSummary',
        '正文里识别到 {refs} 个图片引用，成功打包 {packed} 张（本站 {local} / 外链 {remote}）。',
        {
          refs: Number(r.imageRefs) || 0,
          packed: Number(r.packedImages) || 0,
          local: Number(r.localImages) || 0,
          remote: Number(r.remoteImages) || 0,
        },
      ),
      r.failed
        ? t('export.outcomeProblemsFailed', '抓取失败 {failed} 张，md 里保留了原链接。', { failed: r.failed })
        : null,
      r.skipped
        ? t('export.outcomeProblemsSkipped', '跳过 {skipped} 个（data URI、无法定位的相对路径等）。', {
            skipped: r.skipped,
          })
        : null,
      fmt === 'zip'
        ? t('export.outcomeZipNote', '压缩包里的「{note}」有完整清单。', { note: EXPORT_NOTE_FILENAME })
        : null,
    ].filter(Boolean),
    tone: 'warn',
    failedUrls: r.failedUrls || [],
  };
}


/**
 * 导出失败时，先分清"这是错误"还是"这只是个提示"。
 *
 * ⚠️ 判据是服务端给的**机器可读 code**，不是中文文案 —— 靠匹配文案的分支改一个字就静默失效。
 * `NO_IMAGES_FOR_MDZ` 是"这篇文章没有图片，所以没有 .mdz"：这不是失败，
 * 用户想要的东西（正文）用 .md 就能拿到，所以应该**提示 + 一键改导 .md**，
 * 而不是弹一个红色报错让人以为导出坏了。
 */
const EXPORT_NO_IMAGES_CODE = 'NO_IMAGES_FOR_MDZ';

function classifyExportFailure(body, format, t = IDENTITY_T) {
  const b = body || {};
  if (b.code === EXPORT_NO_IMAGES_CODE) {
    const refs = Number(b.imageRefs) || 0;
    return {
      kind: 'no-images',
      // 服务端的消息仍然照实显示（它是权威文案），但用 info 而不是 error
      message: b.message || t('export.noImagesFallback', '这篇内容没有图片，所以没有 .mdz。'),
      tone: 'info',
      offerMd: normalizeExportFormat(format) === 'mdz',
      detail:
        refs > 0
          ? t('export.noImagesDetailRefs', '正文里识别到 {refs} 个图片引用，但都不是能打包进 .mdz 的本地/可抓取图片。', {
              refs,
            })
          : t('export.noImagesDetailNone', '正文里没有任何图片引用，.mdz 与 .md 的内容完全相同。'),
    };
  }
  return {
    kind: 'error',
    message: b.message || t('export.failed', '导出失败！'),
    tone: 'error',
    offerMd: false,
    detail: '',
  };
}

module.exports = {
  IDENTITY_T,
  EXPORT_NOTE_FILENAME,
  exportFormats,
  EXPORT_NO_IMAGES_CODE,
  classifyExportFailure,
  EXPORT_FORMATS,
  normalizeExportFormat,
  fallbackFileName,
  loadingText,
  describeExportOutcome,
};
