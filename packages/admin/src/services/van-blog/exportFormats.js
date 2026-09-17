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
const EXPORT_FORMATS = [
  {
    key: 'md',
    /** 下拉里的短标签 */
    label: 'Markdown (.md)',
    /** 一句话说明代价，放在下拉项的次要文字里 */
    hint: '只要正文，图片仍指向站点（最快）',
    ext: '.md',
  },
  {
    key: 'mdz',
    label: 'Typora 图片包 (.mdz)',
    hint: '正文 + 图片，链接改成相对路径',
    ext: '.mdz',
  },
  {
    key: 'zip',
    label: '全部打包 (.zip)',
    hint: 'md + mdz + 导出说明，一次拿全',
    ext: '-markdown.zip',
  },
];

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
function loadingText(format) {
  return normalizeExportFormat(format) === 'md'
    ? '正在导出 Markdown…'
    : '正在打包 Markdown 与图片…';
}

/**
 * 导出成功后要不要提醒"图片没打进包"。
 *
 * ⚠️ 关键：`assetsPacked === false` 时（.md 格式）**根本不该弹那个警告** ——
 * 那个格式本来就不含图片，`packedImages=0` 不是失败。第一版没这个字段时，
 * 选 .md 导出带图文章会弹出「导出完成，但有图片没打进包」，看着像出了错。
 * 返回 null 表示不用弹；否则返回一段给 Modal 用的文案。
 */
function describeExportOutcome(report, format) {
  const fmt = normalizeExportFormat(format);
  const r = report || {};
  if (fmt === 'md') {
    const refs = Number(r.imageRefs) || 0;
    if (refs <= 0) return null;
    return {
      title: '已导出 Markdown（不含图片）',
      lines: [
        `正文里识别到 ${refs} 个图片引用，链接仍指向站点 —— 这是 .md 格式的预期行为。`,
        '需要把图片一起带走（例如离线用 Typora/Obsidian 打开），请改选 Typora 图片包 (.mdz)。',
      ],
      tone: 'info',
    };
  }
  // 没有图片 ⇒ 不会有 .mdz。这件事必须说清楚，否则用户会以为导出坏了
  // （zip 里只有一个 .md，或者选的 .mdz 被服务端拒了）。这条在改成下拉之前就存在，
  // 迁移到纯函数时差点被丢掉 —— 由 markdownExport.test.js 的钉子守着。
  if (r.hasMdz === false && (Number(r.imageRefs) || 0) === 0) {
    return {
      title: fmt === 'mdz' ? '这篇内容没有图片' : '导出完成（这篇文章没有图片）',
      lines: [
        '这篇文章没有图片，所以没有 .mdz —— .mdz 的意义就是把图片一起带走并改成相对路径。',
        fmt === 'mdz' ? '请改选 Markdown (.md)，内容是一样的。' : '拿到的 .md 就是全部内容。',
      ],
      tone: 'info',
    };
  }
  const problems = (Number(r.failed) || 0) + (Number(r.skipped) || 0);
  if (problems <= 0) return null;
  return {
    title: '导出完成，但有图片没打进包',
    lines: [
      `正文里识别到 ${Number(r.imageRefs) || 0} 个图片引用，成功打包 ${Number(r.packedImages) || 0} 张` +
        `（本站 ${Number(r.localImages) || 0} / 外链 ${Number(r.remoteImages) || 0}）。`,
      r.failed ? `抓取失败 ${r.failed} 张，md 里保留了原链接。` : null,
      r.skipped ? `跳过 ${r.skipped} 个（data URI、无法定位的相对路径等）。` : null,
      fmt === 'zip' ? '压缩包里的「导出说明.md」有完整清单。' : null,
    ].filter(Boolean),
    tone: 'warn',
    failedUrls: r.failedUrls || [],
  };
}

module.exports = {
  EXPORT_FORMATS,
  normalizeExportFormat,
  fallbackFileName,
  loadingText,
  describeExportOutcome,
};
