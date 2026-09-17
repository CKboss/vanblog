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

/** 导入阶段的进度文案：上传是浏览器侧真实进度，ingest 是服务端解包+图床入库阶段 */
const IMPORT_PHASE_TEXT = {
  upload: '正在上传 .mdz…',
  ingest: '正在导入图片…（服务端解压并把图片写入图床，可能需要几秒到几十秒）',
};

function isMdzFileName(name) {
  return /\.mdz$/i.test(String(name || '').trim());
}

/**
 * 失败文案：每种拒绝都要有自己的说法（任务要求，不许一句"导入失败"打天下）。
 * 按服务端 message 的关键词分类；认不出来时原样带上服务端的话。
 */
function mdzFailureMessage(rawMessage) {
  const msg = String(rawMessage || '');
  if (/之外|zip-slip|\.\./i.test(msg) && /成员|解包|拒绝/.test(msg)) {
    return `这个 .mdz 里含有会写到解包目录之外的成员（zip-slip 攻击特征），已在写入任何数据之前拒绝导入。服务端说：${msg}`;
  }
  if (/没有找到 Markdown|没有 Markdown/.test(msg)) {
    return `这个 .mdz 里没有找到 Markdown 文件（*.md）。.mdz 应该是「一个 .md + 同名 .assets 图片目录」的 zip 包（后台「导出」的 Typora 图片包就是这个形状）。服务端说：${msg}`;
  }
  if (/超过上限|总体积|单文件上限|成员数|炸弹/.test(msg)) {
    return `这个 .mdz 解压后超过了体积或成员数上限（防 zip 炸弹），已拒绝导入。服务端说：${msg}`;
  }
  if (/解压|不是.*zip|有效的 zip|损坏/.test(msg)) {
    return `这不是一个有效的 .mdz 文件（.mdz 本质是 zip，文件可能已损坏或后缀被改过）。服务端说：${msg}`;
  }
  if (/为空|没有收到文件/.test(msg)) {
    return `服务端没有收到文件：请重新选择 .mdz 文件上传。${msg}`;
  }
  if (/登录|Unauthorized|401/.test(msg)) {
    return `登录已失效或权限不足，请重新登录后再导入。${msg}`;
  }
  return msg || '导入失败：服务端没有给出原因';
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
function describeImportOutcome(data) {
  const d = data || {};
  const skipped = Array.isArray(d.skippedImages) ? d.skippedImages : [];
  const notes = Array.isArray(d.notes) ? d.notes : [];
  const lines = [];
  lines.push(
    `图片入库 ${Number(d.importedImages) || 0} 张` +
      (Number(d.dedupedImages) ? `（其中 ${Number(d.dedupedImages)} 张按内容去重命中已有图片，没有重复占空间）` : '') +
      '，正文里的相对链接已改写成图床地址。',
  );
  if (d.passwordDropped) {
    lines.push('原文设置了访问密码，导入后需要重新设置（出于安全，密码不会随文件迁移；「修改信息」里填新密码即可）。');
  }
  if (skipped.length) {
    lines.push(`有 ${skipped.length} 个图片引用没有导入（链接保持原样）：`);
    for (const item of skipped.slice(0, 5)) {
      lines.push(`· ${item && item.name ? item.name : '?'} —— ${item && item.reason ? item.reason : '未知原因'}`);
    }
    if (skipped.length > 5) {
      lines.push(`· …等共 ${skipped.length} 个`);
    }
  }
  for (const note of notes.slice(0, 5)) {
    lines.push(String(note));
  }
  const warn = Boolean(d.passwordDropped || skipped.length || notes.length);
  return {
    title: `已导入《${d.title || '未命名'}》—— 内容已填入编辑器，保存后才生效`,
    lines,
    tone: warn ? 'warn' : 'success',
  };
}

module.exports = {
  IMPORT_PHASE_TEXT,
  isMdzFileName,
  mdzFailureMessage,
  frontMatterPatchForEditor,
  describeImportOutcome,
  FORM_FIELDS,
  NEVER_MERGE,
};
