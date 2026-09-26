/**
 * 「从正文首图补封面」的纯函数：缩略图地址、统计摘要、items 规范化、撤销载荷。
 *
 * 单独抽出来的原因：预览弹窗（components/CoverBackfillModal）只管状态与请求，
 * 而「预览用哪张图」「摘要显示哪几个数字」「撤销时回传什么字段」都是无副作用的映射，
 * 抽成 CJS 模块就能被 node:test 直接 require() 做行为测试
 * （见 tests/unit/coverBackfill.test.js），不用去测 JSX。
 *
 * 用 module.exports（与 requestError.js / commentAdmin.js 一致）而不是 ESM export：
 * 单测跑在裸 node 下，require() 不了 ESM；界面里仍然用 `import { ... } from` 引它，
 * umi 的 babel 会把 CJS 互操作好。
 */

// 服务端图片管理把 300px 缩略图放在 /static/img/thumb/<与原图同名> 下（AGENTS.md §7.5），
// 一次预览最多 200 张图，全拉原图（每张几百 KB ~ 几 MB）会把弹窗卡死。
const STATIC_IMG_PREFIX = '/static/img/';
const STATIC_THUMB_PREFIX = '/static/img/thumb/';

// 服务端 items 最多回 200 条，界面文案与本地裁剪都按这个上限来
const PREVIEW_LIMIT = 200;

// dryRun 一条都没匹配上时必须说清原因，否则用户会以为接口坏了
/**
 * 🔴 多语言：**注入式翻译器**（与 accessPassword.js / recycleCore.js / batch.ts 同一套模式）。
 * 本模块是纯逻辑（`node --test` 直接 require），模块加载期拿不到 umi 运行时 ⇒ 翻译器由调用方在渲染期注入。
 * 🔴 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前**逐字相同**：`coverBackfill.test.js` 那些黄金样本
 * （`label === '已写入'`、`EMPTY_RESULT_TEXT === '所有文章都已有封面…'`、`items[0].title === '文章 0'`）
 * 一个字都不用改就照旧通过 —— 这是本批最重要的兼容性证据。
 */
function interpolate(template, values) {
  if (!values) return String(template);
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
}
const IDENTITY_T = (id, defaultMessage, values) => interpolate(defaultMessage, values);

/** 空结果的文案（函数版：跟着语言走） */
function emptyResultText(t = IDENTITY_T) {
  return t('coverBackfill.emptyResult', '所有文章都已有封面，或正文里没有可用图片');
}
/** 🔴 identity 视图：留给还没接 i18n 的消费方与 `assert.equal(EMPTY_RESULT_TEXT, …)` 这类黄金样本 */
const EMPTY_RESULT_TEXT = emptyResultText();

function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return 0;
  }
  return Math.floor(num);
}

/**
 * 图床相对地址 → 缩略图地址。
 *
 * 只改写本站图床的 `/static/img/<md5>.<name>.webp`：
 * - 已经是 thumb 的原样返回（否则会变成 /thumb/thumb/…，404）；
 * - 外链（有些老文章正文用的是绝对域名图片）与其它路径原样返回，
 *   本站没有它们的缩略图，交给调用方的 onError 兜底；
 * - 空值返回 ''，让调用方好判断「这张没有预览图」。
 *
 * @param {unknown} url
 * @returns {string}
 */
function toThumbUrl(url) {
  const text = toText(url);
  if (!text) {
    return '';
  }
  if (text.startsWith(STATIC_THUMB_PREFIX)) {
    return text;
  }
  if (text.startsWith(STATIC_IMG_PREFIX)) {
    return STATIC_THUMB_PREFIX + text.slice(STATIC_IMG_PREFIX.length);
  }
  return text;
}

/**
 * 把接口回的 items 洗成界面能直接渲染的形状。
 *
 * 丢掉「没有 id」和「没有 cover」的条目：没有 id 既写不进去也撤销不了，
 * 没有 cover 写进去等于把别人的封面清空。同时顺手算好 thumb，
 * 免得渲染时每张图都再跑一次字符串判断。
 *
 * @param {unknown} data 接口 data 字段（或直接传 items 数组也认）
 * @returns {Array<{id:number,title:string,cover:string,previousCover:string,thumb:string}>}
 */
function normalizeBackfillItems(data, t = IDENTITY_T) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const out = [];
  for (const raw of list) {
    const id = Number(raw?.id);
    if (!Number.isFinite(id)) {
      continue;
    }
    const cover = toText(raw?.cover);
    if (!cover) {
      continue;
    }
    out.push({
      id,
      title: toText(raw?.title) || t('coverBackfill.untitled', '文章 {id}', { id }),
      cover,
      // previousCover 可能是空串（原来就没封面），撤销时要把空串写回去，不能丢字段
      previousCover: typeof raw?.previousCover === 'string' ? raw.previousCover : '',
      thumb: toThumbUrl(cover),
    });
    if (out.length >= PREVIEW_LIMIT) {
      break;
    }
  }
  return out;
}

/**
 * 把接口 data 变成摘要：数字 + 可直接渲染的行 + 空结果文案。
 *
 * dryRun 时服务端的 changed 恒为 0，所以「将写入」这一行要取 matched，
 * 否则预览里永远显示 0 篇，用户以为什么都不会发生。
 *
 * @param {unknown} data
 */
function summarizeBackfill(data, t = IDENTITY_T) {
  // 🔴 **内部调用也要把 t 转发下去**（§7.156 A ③）：否则"标题为空时回退成 文章 <id>"那半句
  //    永远是中文 —— 而且 identity 黄金样本照样绿（它测的就是不传 t 的路径），只有注入路径会露馅。
  const items = normalizeBackfillItems(data, t);
  const dryRun = Boolean(data?.dryRun);
  const scanned = toCount(data?.scanned);
  const matched = toCount(data?.matched);
  const changed = toCount(data?.changed);
  const skippedHasCover = toCount(data?.skippedHasCover);
  const skippedNoImage = toCount(data?.skippedNoImage);
  const willChange = dryRun ? matched : changed;
  return {
    dryRun,
    scanned,
    matched,
    changed,
    skippedHasCover,
    skippedNoImage,
    willChange,
    items,
    ids: items.map((item) => item.id),
    rows: [
      { key: 'scanned', label: t('coverBackfill.rowScanned', '扫描'), value: scanned },
      { key: 'matched', label: t('coverBackfill.rowMatched', '有首图'), value: matched },
      {
        key: 'willChange',
        label: dryRun
          ? t('coverBackfill.rowWillWrite', '将写入')
          : t('coverBackfill.rowWritten', '已写入'),
        value: willChange,
        primary: true,
      },
      { key: 'skippedHasCover', label: t('coverBackfill.rowSkippedHasCover', '已有封面跳过'), value: skippedHasCover },
      { key: 'skippedNoImage', label: t('coverBackfill.rowSkippedNoImage', '无图跳过'), value: skippedNoImage },
    ],
    emptyText: items.length ? '' : emptyResultText(t),
  };
}

/**
 * 撤销载荷：服务端 `POST /api/admin/article/covers/revert` 收的是
 * `{ items: [{ id, cover }] }`，其中 **cover 字段要填旧值 previousCover**
 * （服务端把它原样写回，并且只在当前值不等于旧值时才改，避免覆盖用户后来的手动修改）。
 *
 * 字段名与含义不一致，所以单独一个函数把它钉住，别让调用方自己拼错。
 *
 * @param {unknown} items normalizeBackfillItems 的结果（也认接口的原始 items）
 * @returns {Array<{id:number,cover:string}>}
 */
function toRevertPayload(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const raw of list) {
    const id = Number(raw?.id);
    if (!Number.isFinite(id)) {
      continue;
    }
    out.push({
      id,
      cover: typeof raw?.previousCover === 'string' ? raw.previousCover : '',
    });
  }
  return out;
}

module.exports = {
  STATIC_IMG_PREFIX,
  STATIC_THUMB_PREFIX,
  PREVIEW_LIMIT,
  emptyResultText,
  EMPTY_RESULT_TEXT,
  toThumbUrl,
  normalizeBackfillItems,
  summarizeBackfill,
  toRevertPayload,
};
