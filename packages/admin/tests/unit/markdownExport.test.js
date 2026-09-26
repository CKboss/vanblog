const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const repoRoot = path.join(adminRoot, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('导出 Markdown（含图片）：后台入口', () => {
  it('文章列表每行的「导出」走服务端打包', () => {
    const cols = read('src/pages/Article/columns.jsx');
    // 现在是**下拉三选一**（md / mdz / zip），不再写死"永远一个 zip"
    assert.match(cols, /<ExportFormatDropdown/);
    assert.match(cols, /payload=\{\{ id: record\.id, type: 'article', title: record\.title \}\}/);
    assert.match(cols, /import ExportFormatDropdown from '@\/components\/ExportFormatDropdown'/);
    // 老的纯前端导出（拿不到图片）不该留着
    assert.doesNotMatch(cols, /parseObjToMarkdown/);
    assert.doesNotMatch(cols, /URL\.createObjectURL/);
  });

  it('草稿列表每行的「导出」也走服务端，并带上 type: draft', () => {
    const cols = read('src/pages/Draft/columes.jsx');
    assert.match(cols, /<ExportFormatDropdown/);
    assert.match(cols, /payload=\{\{ id: record\.id, type: 'draft', title: record\.title \}\}/);
    assert.doesNotMatch(cols, /parseObjToMarkdown/);
  });

  it('编辑器导出带当前内容（未保存也能导），关于页走 raw', () => {
    const editor = read('src/pages/Editor/index.jsx');
    assert.match(editor, /downloadMarkdownExport/);
    // 关于页没有文章 id（调用改成多行后，这条钉子也顺带钉住 raw 路径把 format 带下去了）
    assert.match(
      editor,
      /type: 'raw',\s*\n\s*title: currObj\?\.title \|\| '关于',\s*\n\s*content: value,\s*\n\s*format,/,
    );
    // 文章/草稿把当前编辑器内容一起发过去，所见即所得
    assert.match(editor, /content: value,/);
    // 没保存过就先提示保存
    assert.match(editor, /还没保存过，先保存再导出/);
    assert.doesNotMatch(editor, /parseObjToMarkdown/);
  });

  it('批量导出的草稿 bug 修好了（以前写死了文章接口）', () => {
    const batch = read('src/services/van-blog/batch.ts');
    assert.match(batch, /const fn = isDraft \? getDraftById : getArticleById;/);
    assert.match(batch, /await fn\(id\)/);
    assert.doesNotMatch(batch, /const \{ data: obj \} = await getArticleById\(id\);/);
  });
});

describe('导出 Markdown（含图片）：前端封装', () => {
  it('API 用 POST + blob + getResponse，超时给足', () => {
    const api = read('src/services/van-blog/api.js');
    assert.match(api, /export async function exportMarkdownZip/);
    assert.match(api, /\/api\/admin\/export\/markdown/);
    assert.match(api, /responseType: 'blob'/);
    assert.match(api, /getResponse: true/);
    assert.match(api, /timeout: 10 \* 60 \* 1000/);
  });

  it('下载helper：读报告头、解析 filename\*、嗅探 JSON 错误、有问题时弹窗', () => {
    const helper = read('src/services/van-blog/exportMarkdown.tsx');
    assert.match(helper, /x-export-report/);
    assert.match(helper, /filename\\\*=UTF-8''/);
    assert.match(helper, /application\/json/);
    assert.match(helper, /URL\.createObjectURL/);
    assert.match(helper, /revokeObjectURL/);
    // 结果文案已移进纯函数 exportFormats.js（可 node:test 直接跑，不需要 DOM）
    // 🔴 期 7 第三批起 exportFormats 的函数收注入式翻译器（尾参 t）⇒ 锚点换形状，性质没放
    assert.match(helper, /describeExportOutcome\(report, format, t\)/);
    const formats = read('src/services/van-blog/exportFormats.js');
    assert.match(formats, /导出完成，但有图片没打进包/);
    assert.match(formats, /导出说明\.md/);
    // 没有图片时要说清楚为什么没有 .mdz（这条从 tsx 迁过来时差点被丢掉）
    assert.match(formats, /这篇文章没有图片，所以没有 \.mdz/);
    // .md 格式**不该**弹"有图片没打进包"：那个格式本来就不含图片
    assert.match(formats, /已导出 Markdown（不含图片）/);
  });
});

describe('导出 Markdown（含图片）：服务端', () => {
  it('产物是 .md（原样）+ .mdz（Typora 风格带图包）', () => {
    const provider = readRepo('packages/server/src/provider/export/markdownExport.provider.ts');
    assert.match(provider, /relativePath: `\$\{baseName\}\.md`/);
    assert.match(provider, /relativePath: `\$\{baseName\}\.mdz`/);
    assert.match(provider, /导出说明\.md/);
    // 只有真有图片时才生成 .mdz
    assert.match(provider, /if \(assetEntries\.length\)/);
    // 本地图片直接按路径塞进 zip，不整块读进内存
    assert.match(provider, /source: abs,/);
    assert.match(provider, /compressing\.zip\.Stream/);
    // 临时目录发完就删
    assert.match(provider, /vanblog-md-export-/);
  });

  it('图片识别覆盖 md/html/引用式，且跳过代码块', () => {
    const util = readRepo('packages/server/src/utils/markdownExport.ts');
    assert.match(util, /export function maskCodeRegions/);
    assert.match(util, /export function extractImageRefs/);
    // html <img> 与引用式 ![alt][label] 都要认（用字面量判断，省得跟转义打架）
    assert.ok(util.includes('<img\\b[^>]*>'), '缺少 <img> 语法识别');
    assert.ok(util.includes('!\\[[^\\]]*\\]\\['), '缺少引用式图片识别');
    assert.match(util, /export function rewriteImageUrls/);
  });

  it('外链抓取有 SSRF 防护与体积/超时上限', () => {
    const util = readRepo('packages/server/src/utils/markdownExport.ts');
    assert.match(util, /export async function assertSafeRemoteUrl/);
    assert.match(util, /isPrivateAddress/);
    assert.match(util, /dns\.lookup/);
    const provider = readRepo('packages/server/src/provider/export/markdownExport.provider.ts');
    assert.match(provider, /REMOTE_TIMEOUT_MS = 15000/);
    assert.match(provider, /REMOTE_MAX_BYTES = 50 \* 1024 \* 1024/);
    assert.match(provider, /maxRedirects: 3/);
  });

  it('文件名安全化，链接不需要转义', () => {
    const util = readRepo('packages/server/src/utils/markdownExport.ts');
    assert.match(util, /export function safeExportName/);
    assert.ok(
      util.includes(".replace(/[\\s()\\[\\]{}'\"#%]+/g, '-')"),
      '文件名没有把空格和括号等换成 -',
    );
    assert.match(util, /return `\$\{assetsDir\}\/\$\{fileName\}`/);
  });

  it('接口在 AdminGuard 后，且协作者（只读）可用', () => {
    const controller = readRepo('packages/server/src/controller/admin/export/export.controller.ts');
    assert.match(controller, /@UseGuards\(\.\.\.AdminGuard\)/);
    assert.match(controller, /@Controller\('\/api\/admin\/export'\)/);
    assert.match(controller, /X-Export-Report/);
    assert.match(controller, /Access-Control-Expose-Headers/);
    // 三种格式都在发完之后删临时目录（不再只对 zip 那一个路径负责）
    assert.match(controller, /fs\.rmSync\(built\.tmpDir/);
    // 格式白名单：未知格式明确 400，不静默回落到 zip
    assert.match(controller, /不支持的导出格式/);
    // 选了 .mdz 但这篇没有图片：400 说清原因，而不是静默改发 .md
    assert.match(controller, /没有可打包的图片/);

    const access = readRepo('packages/server/src/types/access/access.ts');
    assert.match(access, /'post-\/api\/admin\/export\/markdown'/);
  });
});

describe('导出 Markdown（含图片）：文档', () => {
  it('写清了 .mdz 是什么、包含什么、怎么用', () => {
    const doc = readRepo('docs/advanced/backup.md');
    assert.match(doc, /## 导出单篇文章（含图片）/);
    assert.match(doc, /\.mdz/);
    assert.match(doc, /\.assets/);
    assert.match(doc, /Typora/);
    assert.match(doc, /原样/);
    assert.match(doc, /导出说明\.md/);
  });
});
