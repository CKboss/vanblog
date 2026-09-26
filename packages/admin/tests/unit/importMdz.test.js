const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const serverRoot = path.join(adminRoot, '..', 'server');
const read = (rel, root = adminRoot) => readFileSync(path.join(root, rel), 'utf8');

/** 断言前剔除注释（注释里常引用契约原文，不剔除会自己匹配自己） */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

const {
  IMPORT_PHASE_TEXT,
  isMdzFileName,
  mdzFailureMessage,
  frontMatterPatchForEditor,
  describeImportOutcome,
} = require('../../src/services/van-blog/importMdzCore');

describe('importMdzCore：文件类型与阶段文案', () => {
  it('isMdzFileName 只认 .mdz 后缀（大小写不敏感）', () => {
    assert.equal(isMdzFileName('文章.MDZ'), true);
    assert.equal(isMdzFileName('文章.mdz'), true);
    assert.equal(isMdzFileName('文章.md'), false);
    assert.equal(isMdzFileName('mdz.txt'), false);
    assert.equal(isMdzFileName(''), false);
  });
  it('两个阶段各有各的文案，ingest 阶段必须说"正在导入图片"', () => {
    assert.match(IMPORT_PHASE_TEXT.upload, /上传/);
    assert.match(IMPORT_PHASE_TEXT.ingest, /正在导入图片/);
    assert.notEqual(IMPORT_PHASE_TEXT.upload, IMPORT_PHASE_TEXT.ingest);
  });
});

describe('importMdzCore：失败文案按拒绝原因分类（不许一句"导入失败"打天下）', () => {
  it('zip-slip / 没有 md / 超限 / 不是 zip / 没收到文件 各有专属说法', () => {
    assert.match(
      mdzFailureMessage('压缩包里有可能写到解包目录之外的成员（../evil.png），已拒绝导入'),
      /zip-slip/,
    );
    assert.match(
      mdzFailureMessage('压缩包里没有找到 Markdown 文件（*.md）：…'),
      /没有找到 Markdown/,
    );
    assert.match(mdzFailureMessage('解压后总体积超过上限（419430400 字节），疑似 zip 炸弹'), /上限/);
    assert.match(mdzFailureMessage('无法解压这个 .mdz（文件可能已损坏，或它根本不是 zip）：xx'), /有效的 \.mdz/);
    assert.match(mdzFailureMessage('没有收到文件：请用 multipart 上传'), /没有收到文件/);
  });
  it('认不出来的原因原样带上服务端的话；空消息也有兜底', () => {
    assert.match(mdzFailureMessage('数据库炸了'), /数据库炸了/);
    assert.ok(mdzFailureMessage('').length > 0);
  });
});

describe('importMdzCore：frontMatter → 修改信息表单补丁', () => {
  it('白名单字段透传、布尔归一、pathname 走 importPathname 的既有优先级', () => {
    const patch = frontMatterPatchForEditor({
      title: '往返',
      tags: ['a', 'b'],
      category: '技术',
      slug: 'my-slug',
      top: 2,
      hidden: 'true',
      private: true,
      createdAt: '2024-07-07T10:00:00.000Z',
      cover: '/static/img/c.webp',
    });
    assert.equal(patch.title, '往返');
    assert.deepEqual(patch.tags, ['a', 'b']);
    assert.equal(patch.category, '技术');
    assert.equal(patch.pathname, 'my-slug');
    assert.equal(patch.hidden, true);
    assert.equal(patch.private, true);
    assert.equal(patch.cover, '/static/img/c.webp');
    assert.equal(patch.slug, undefined); // slug 已折算成 pathname，不重复进表单
  });
  it('password/hasPassword/clearPassword 就算混进输入也绝不进补丁', () => {
    const patch = frontMatterPatchForEditor({
      title: 't',
      password: 'scrypt$aa$bb',
      hasPassword: true,
      clearPassword: true,
    });
    assert.equal('password' in patch, false);
    assert.equal('hasPassword' in patch, false);
    assert.equal('clearPassword' in patch, false);
  });
});

describe('importMdzCore：导入结果报告（对齐导出报告 UX）', () => {
  it('干净导入 → success；有跳过/notes/密码丢弃 → warn 且逐条列出', () => {
    const clean = describeImportOutcome({ title: 't', importedImages: 2, skippedImages: [], notes: [] });
    assert.equal(clean.tone, 'success');
    assert.match(clean.lines[0], /图片入库 2 张/);
    const warn = describeImportOutcome({
      title: 't',
      importedImages: 1,
      dedupedImages: 1,
      passwordDropped: true,
      skippedImages: [{ name: 'x.png', reason: '包里找不到对应的图片文件' }],
      notes: ['包里有 1 个图片文件未被正文引用'],
    });
    assert.equal(warn.tone, 'warn');
    assert.match(warn.lines.join('\n'), /重新设置/);
    assert.match(warn.lines.join('\n'), /去重命中/);
    assert.match(warn.lines.join('\n'), /x\.png/);
    assert.match(warn.lines.join('\n'), /未被正文引用/);
    assert.match(warn.title, /尚未|保存后才生效/);
  });
});

describe('接线钉子：Editor / 服务层 / 服务端三方契约不漂移', () => {
  const editor = codeOnly(read('src/pages/Editor/index.jsx'));
  const svc = codeOnly(read('src/services/van-blog/importMdz.ts'));
  const controller = codeOnly(
    read('src/controller/admin/article/article.controller.ts', serverRoot),
  );
  const serverUtil = codeOnly(read('src/utils/mdzImport.ts', serverRoot));

  it('Editor 的文件选择器同时接受 .md 和 .mdz，导入进行中禁用控件', () => {
    assert.match(editor, /accept=\{'\.md,\.mdz'\}/);
    assert.match(editor, /disabled=\{!!mdzImportPhase\}/);
    assert.match(editor, /isMdzFileName\(file\?\.name\)/);
    assert.match(editor, /importMdzFile\(/);
  });
  it('.md 的浏览器端老路径没被动过（parseMarkdownFile 仍在）', () => {
    // 🔴 期 6 第四批起 Editor 页已接 i18n ⇒ 调用点带上尾参 t（锚点换形状，性质没放）
    assert.match(editor, /parseMarkdownFile\(file, undefined, t\)/);
  });
  it('服务层：端点、multipart 字段名 file、token 头，与服务端一致', () => {
    assert.match(svc, /'\/api\/admin\/article\/import-mdz'/);
    assert.match(svc, /form\.append\('file'/);
    assert.match(svc, /setRequestHeader\('token'/);
    assert.match(controller, /@Post\('import-mdz'\)/);
    assert.match(controller, /FileInterceptor\('file', MDZ_IMPORT_UPLOAD_OPTIONS\)/);
    assert.match(controller, /@Controller\('\/api\/admin\/article'\)/);
  });
  it('服务端 front matter 白名单里没有 password（密码永不下发）', () => {
    const block = /FRONT_MATTER_WHITELIST = \[([\s\S]*?)\]/.exec(serverUtil);
    assert.ok(block, 'whitelist not found');
    assert.ok(!/'password'/.test(block[1]), 'password must never be whitelisted');
    assert.match(serverUtil, /passwordDropped/);
    assert.match(controller, /importMdzBuffer/);
  });
});
