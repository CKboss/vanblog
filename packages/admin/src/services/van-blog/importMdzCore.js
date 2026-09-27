/**
 * .mdz 导入的纯逻辑（CommonJS，node:test 直接跑，不需要 DOM）。
 *
 * 契约（与服务端 utils/mdzImport.ts + ArticleController.importMdz 对齐，两边各有钉子）：
 *   POST /api/admin/article/import-mdz（multipart，文件字段名 file）
 *   → { statusCode:200, data:{ title, content, frontMatter, importedImages,
 *       dedupedImages, skippedImages:[{name,reason}], notes:[], passwordDropped } }
 *
 * password 永远不在 frontMatter 里（服务端白名单保证）；passwordDropped=true 时
 * 必须明确告诉用户"导入后需要重新设置密码"。
 */
const { pathnameFromFrontMatter } = require('./importPathname');

/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。这是纯逻辑模块（被 `node --test` 直接 require），
 * 拿不到 umi 运行时 ⇒ 由调用方在渲染期把 t 传进来；🔴 不传 t ⇒ 输出与改造前**逐字相同**
 * （`tests/unit/importMdzCore.test.js` 的既有断言一条都没改就全绿）。
 * ⚠️ 下面大写常量是 **identity 视图**。
 * 🔴 **`mdzFailureMessage` 里那些正则是在匹配服务端返回的中文**（zip-slip / 没有找到 Markdown / 超过上限 …）
 *    ⇒ 它们是**线路契约**，任何语言下都不许动（与 `requestError.js` 的 `登录失效` 同族）；
 *    只有**返回给用户看的那句**走 t。
 */
const IDENTITY_T = (id, defaultMessage, values) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);

/** 导入阶段的进度文案：上传是浏览器侧真实进度，ingest 是服务端解包+图床入库阶段 */
const importPhaseText = (t = IDENTITY_T) => ({
  upload: t('import.phaseUpload', '正在上传 .mdz…'),
  ingest: t(
    'import.phaseIngest',
    '正在导入图片…（服务端解压并把图片写入图床，可能需要几秒到几十秒）',
  ),
});

/** identity 视图 */
const IMPORT_PHASE_TEXT = importPhaseText();

function isMdzFileName(name) {
  return /\.mdz$/i.test(String(name || '').trim());
}

/**
 * 失败文案：每种拒绝都要有自己的说法（任务要求，不许一句"导入失败"打天下）。
 * 按服务端 message 的关键词分类；认不出来时原样带上服务端的话。
 */
// 🔴 t 是**尾参**（调用点判据按"最后一个实参是不是 t"看）。
// ⚠️ 下面每个 `if` 的正则都在**匹配服务端返回的中文** ⇒ 线路契约，不译（见文件头注释）。
function mdzFailureMessage(rawMessage, t = IDENTITY_T) {
  const msg = String(rawMessage || '');
  if (/之外|zip-slip|\.\./i.test(msg) && /成员|解包|拒绝/.test(msg)) {
    // 🔴 模板 → 带 {server} 的 ICU 整句（英文语序不同，拼接必出接缝）
    return t(
      'import.errZipSlip',
      '这个 .mdz 里含有会写到解包目录之外的成员（zip-slip 攻击特征），已在写入任何数据之前拒绝导入。服务端说：{server}',
      { server: msg },
    );
  }
  if (/没有找到 Markdown|没有 Markdown/.test(msg)) {
    return t(
      'import.errNoMarkdown',
      '这个 .mdz 里没有找到 Markdown 文件（*.md）。.mdz 应该是「一个 .md + 同名 .assets 图片目录」的 zip 包（后台「导出」的 Typora 图片包就是这个形状）。服务端说：{server}',
      { server: msg },
    );
  }
  if (/超过上限|总体积|单文件上限|成员数|炸弹/.test(msg)) {
    return t(
      'import.errTooLarge',
      '这个 .mdz 解压后超过了体积或成员数上限（防 zip 炸弹），已拒绝导入。服务端说：{server}',
      { server: msg },
    );
  }
  if (/解压|不是.*zip|有效的 zip|损坏/.test(msg)) {
    return t(
      'import.errNotMdz',
      '这不是一个有效的 .mdz 文件（.mdz 本质是 zip，文件可能已损坏或后缀被改过）。服务端说：{server}',
      { server: msg },
    );
  }
  if (/为空|没有收到文件/.test(msg)) {
    return t('import.errNoFile', '服务端没有收到文件：请重新选择 .mdz 文件上传。{server}', {
      server: msg,
    });
  }
  if (/登录|Unauthorized|401/.test(msg)) {
    return t('import.errAuth', '登录已失效或权限不足，请重新登录后再导入。{server}', {
      server: msg,
    });
  }
  return msg || t('import.errNoReason', '导入失败：服务端没有给出原因');
}

/** 表单认识的字段（与 UpdateModal / ImportArticleModal 的字段名一致）；password 类键绝不透传 */
const FORM_FIELDS = [
  'title',
  'tags',
  'category',
  'categories',
  'top',
  'hidden',
  'private',
  'createdAt',
  'updatedAt',
  'cover',
];
const NEVER_MERGE = ['password', 'hasPassword', 'clearPassword'];

/**
 * 把响应的 frontMatter 变成能直接 merge 进 Editor currObj 的补丁
 * （UpdateModal 的 initialValues/sanitizeRecordForForm 吃 currObj）。
 * pathname 走 importPathname 的既有优先级（pathname > slug > url > abbrlink），
 * 与 .md 客户端导入完全同一套解析。
 */
function frontMatterPatchForEditor(frontMatter) {
  const patch = {};
  const fm = frontMatter && typeof frontMatter === 'object' ? frontMatter : {};
  for (const key of FORM_FIELDS) {
    if (NEVER_MERGE.includes(key)) continue;
    const value = fm[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'hidden' || key === 'private') {
      patch[key] = value === true || value === 'true';
      continue;
    }
    patch[key] = value;
  }
  const pathname = pathnameFromFrontMatter(fm);
  if (pathname) {
    patch.pathname = pathname;
  }
  // 防御：就算服务端哪天漏了，密码类键也绝不进表单
  for (const key of NEVER_MERGE) {
    delete patch[key];
  }
  return patch;
}

/**
 * 导入结果报告（与 exportFormats.describeExportOutcome 同一 UX：弹 Modal 列明细）。
 * tone: 'success' 一切干净；'warn' 有跳过/提示/密码被丢弃 —— 都要让用户看见。
 */
function describeImportOutcome(data, t = IDENTITY_T) {
  const d = data || {};
  const skipped = Array.isArray(d.skippedImages) ? d.skippedImages : [];
  const notes = Array.isArray(d.notes) ? d.notes : [];
  const lines = [];
  // 🔴 原来是"模板 + 三元 + 拼接"三段合成一句 ⇒ 收成**一条** ICU 整句，
  //    可选的那半句用 {dedup} 占位符（没有去重时传空串）。英文可以整句重排而不出接缝。
  lines.push(
    t('import.imagesLine', '图片入库 {count} 张{dedup}，正文里的相对链接已改写成图床地址。', {
      count: Number(d.importedImages) || 0,
      dedup: Number(d.dedupedImages)
        ? t('import.imagesDedupNote', '（其中 {count} 张按内容去重命中已有图片，没有重复占空间）', {
            count: Number(d.dedupedImages),
          })
        : '',
    }),
  );
  if (d.passwordDropped) {
    lines.push(
      t(
        'import.passwordDroppedNote',
        '原文设置了访问密码，导入后需要重新设置（出于安全，密码不会随文件迁移；「修改信息」里填新密码即可）。',
      ),
    );
  }
  if (skipped.length) {
    lines.push(
      t('import.skippedHeader', '有 {count} 个图片引用没有导入（链接保持原样）：', {
        count: skipped.length,
      }),
    );
    for (const item of skipped.slice(0, 5)) {
      lines.push(
        t('import.skippedItem', '· {name} —— {reason}', {
          name: item && item.name ? item.name : '?',
          reason: item && item.reason ? item.reason : t('import.unknownReason', '未知原因'),
        }),
      );
    }
    if (skipped.length > 5) {
      lines.push(t('import.skippedMore', '· …等共 {count} 个', { count: skipped.length }));
    }
  }
  for (const note of notes.slice(0, 5)) {
    lines.push(String(note));
  }
  const warn = Boolean(d.passwordDropped || skipped.length || notes.length);
  return {
    title: t('import.importedTitle', '已导入《{title}》—— 内容已填入编辑器，保存后才生效', {
      title: d.title || t('import.untitled', '未命名'),
    }),
    lines,
    tone: warn ? 'warn' : 'success',
  };
}

module.exports = {
  IMPORT_PHASE_TEXT,
  importPhaseText,
  isMdzFileName,
  mdzFailureMessage,
  frontMatterPatchForEditor,
  describeImportOutcome,
  FORM_FIELDS,
  NEVER_MERGE,
};
