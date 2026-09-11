const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const repoRoot = path.join(adminRoot, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('附件管理：后台入口', () => {
  it('在图片管理旁边加了 /static/file 菜单', () => {
    const routes = read('config/routes.js');
    assert.match(routes, /name: '附件管理'/);
    assert.match(routes, /path: '\/static\/file'/);
    assert.match(routes, /component: '\.\/Static\/file'/);
    // umi 的解析规则是 toHump(首字母大写) + 'Outlined'：
    // 'paperclip' 会拼出不存在的 PaperclipOutlined，菜单里就直接显示成 "paperclip附件管理"。
    assert.match(routes, /icon: 'paper-clip'/);
    assert.doesNotMatch(routes, /icon: 'paperclip'/);
    // 顺序上紧跟图片管理，方便找
    assert.ok(routes.indexOf("name: '图片管理'") < routes.indexOf("name: '附件管理'"));
  });

  it('页面提供列表 / 搜索 / 上传 / 复制链接 / 删除 / 导出', () => {
    const page = read('src/pages/Static/file/index.tsx');
    assert.match(page, /getAttachments/);
    assert.match(page, /deleteAttachmentBySign/);
    assert.match(page, /exportAllAttachments/);
    assert.match(page, /searchArtclesByLink/);
    assert.match(page, /\/api\/admin\/file\/upload/);
    assert.match(page, /title: '文件名'/);
    assert.match(page, /按文件名模糊搜索/);
    assert.match(page, /复制链接/);
    assert.match(page, /复制 Markdown/);
    assert.match(page, /导出全部附件/);
    // 删除按钮受协作者权限控制
    assert.match(page, /file:delete/);
    assert.match(page, /确定删除该附件吗/);
  });

  it('API 封装对上服务端路由', () => {
    const api = read('src/services/van-blog/api.js');
    assert.match(api, /export async function getAttachments/);
    assert.match(api, /\/api\/admin\/file\?/);
    assert.match(api, /query\.set\('name', name\)/);
    assert.match(api, /export async function getAllAttachments/);
    assert.match(api, /\/api\/admin\/file\/all/);
    assert.match(api, /export async function deleteAttachmentBySign/);
    assert.match(api, /\/api\/admin\/file\/\$\{sign\}/);
    assert.match(api, /export async function exportAllAttachments/);
    assert.match(api, /\/api\/admin\/file\/export/);
  });

  it('链接工具复用图片那套 URL 规则，并能复制 Markdown', () => {
    const tools = read('src/pages/Static/file/tools.ts');
    assert.match(tools, /getImgLink/);
    assert.match(tools, /getAttachmentLink/);
    assert.match(tools, /\[\$\{displayName \|\| '附件'\}\]\(\$\{url\}\)/);
    assert.match(tools, /downloadAttachment/);
  });
});

describe('附件管理：编辑器入口', () => {
  it('工具栏注册了「上传附件并插入链接」', () => {
    const editor = read('src/components/Editor/index.tsx');
    assert.match(editor, /fileUploadPlugin/);
    assert.match(editor, /from '\.\/fileUpload'/);

    const plugin = read('src/components/Editor/fileUpload.tsx');
    assert.match(plugin, /上传附件并插入链接/);
    assert.match(plugin, /\/api\/admin\/file\/upload/);
    assert.match(plugin, /\[\$\{file\.name\}\]\(\$\{url\}\)/);
  });
});

describe('附件管理：协作者权限', () => {
  it('后台可授予「删除-附件」', () => {
    const modal = read('src/components/CollaboratorModal/index.tsx');
    assert.match(modal, /label: '删除-附件'/);
    assert.match(modal, /value: 'file:delete'/);
  });

  it('服务端把 file:delete 映射到删除接口，上传/列表对协作者开放', () => {
    const access = readRepo('packages/server/src/types/access/access.ts');
    assert.match(access, /\| 'file:delete'/);
    assert.match(access, /'file:delete': 'delete-\/api\/admin\/file\/:sign'/);
    assert.match(access, /'delete-\/api\/admin\/file\/:sign': 'file:delete'/);
    assert.match(access, /'get-\/api\/admin\/file'/);
    assert.match(access, /'get-\/api\/admin\/file\/all'/);
    assert.match(access, /'post-\/api\/admin\/file\/upload'/);
  });
});

describe('附件管理：服务端存储与安全', () => {
  it('新增 file 静态类型与目录', () => {
    const dto = readRepo('packages/server/src/types/setting.dto.ts');
    assert.match(dto, /StaticType = 'img' \| 'customPage' \| 'file'/);
    assert.match(dto, /file: `file`/);

    const main = readRepo('packages/server/src/main.ts');
    assert.match(main, /ATTACHMENT_FOLDER/);
    assert.match(main, /checkOrCreate\(path\.join\(globalConfig\.staticPath, ATTACHMENT_FOLDER\)\)/);
  });

  it('附件只落本地、按内容去重、文件名安全化', () => {
    const provider = readRepo('packages/server/src/provider/static/static.provider.ts');
    assert.match(provider, /async uploadAttachment/);
    assert.match(provider, /getOneBySignAndType\(sign, 'file'\)/);
    assert.match(provider, /buildStoredFileName\(sign, decodeUploadFileName/);
    assert.match(provider, /type == 'customPage' \|\| type == 'file'/);

    const local = readRepo('packages/server/src/provider/static/local.provider.ts');
    assert.match(local, /async saveAttachment/);
    assert.match(local, /非法的附件文件名/);
    assert.match(local, /async exportAllAttachments/);
  });

  it('危险类型强制下载，所有附件都带 nosniff', () => {
    const attachment = readRepo('packages/server/src/utils/attachment.ts');
    assert.match(attachment, /ATTACHMENT_MAX_BYTES = 200 \* 1024 \* 1024/);
    for (const ext of ['html', 'svg', 'xml', 'js']) {
      assert.match(attachment, new RegExp(`'${ext}'`));
    }
    assert.match(attachment, /X-Content-Type-Options': 'nosniff'|'X-Content-Type-Options': 'nosniff'/);

    const imgCompress = readRepo('packages/server/src/utils/imgCompress.ts');
    assert.match(imgCompress, /isAttachmentPath\(filePath\)/);
    assert.match(imgCompress, /attachmentHeadersFor\(filePath\)/);
  });
});
