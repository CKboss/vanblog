const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const repoRoot = path.join(adminRoot, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('图片设置：缩放 / 缩略图 / 隐写水印', () => {
  it('图床设置里多了四个开关和两个数值', () => {
    const form = read('src/components/WaterMarkForm/index.tsx');
    assert.match(form, /ProFormDigit/);
    for (const name of [
      'enableResize',
      'maxImageEdge',
      'enableThumb',
      'thumbWidth',
      'enableStegoWaterMark',
      'stegoWaterMarkText',
    ]) {
      assert.match(form, new RegExp(`name="${name}"`), `缺少字段 ${name}`);
    }
    // 原来的「水印」改名成「可见水印」，和隐写水印区分开
    assert.match(form, /label="可见水印"/);
    assert.match(form, /label="大图自动缩放"/);
    assert.match(form, /label="隐写水印"/);
    assert.match(form, /1080p/);
    assert.match(form, /默认 300/);
  });

  it('拿不到设置时给出合理默认值（全部开启，1920 / 300）', () => {
    const form = read('src/components/WaterMarkForm/index.tsx');
    assert.match(form, /enableResize: true/);
    assert.match(form, /maxImageEdge: 1920/);
    assert.match(form, /enableThumb: true/);
    assert.match(form, /thumbWidth: 300/);
    assert.match(form, /enableStegoWaterMark: true/);
  });
});

describe('图片管理：缩略图视图与工具栏', () => {
  it('可以在小图/大图之间切换，并且记住选择', () => {
    const page = read('src/pages/Static/img/index.tsx');
    assert.match(page, /VAN_BLOG|van-blog-admin-img-view-mode/);
    assert.match(page, /<Radio\.Group/);
    assert.match(page, /value="thumb">小图/);
    assert.match(page, /value="large">大图/);
    assert.match(page, /window\.localStorage\.setItem\(VIEW_MODE_KEY/);
  });

  it('小图模式加载缩略图，预览仍然是原图', () => {
    const page = read('src/pages/Static/img/index.tsx');
    assert.match(page, /getThumbLink/);
    assert.match(page, /src=\{thumbMode \? getThumbLink\(item\) : `\$\{item\.realPath\}`\}/);
    assert.match(page, /preview=\{\{ src: getImgLink\(item\.realPath\) \}\}/);
  });

  it('没有「全部删除」按钮（误点代价太大）', () => {
    const page = read('src/pages/Static/img/index.tsx');
    assert.doesNotMatch(page, /全部删除/);
    assert.doesNotMatch(page, /deleteAllIMG/);
    assert.doesNotMatch(page, /DEV ONLY/);
  });

  it('列表视图给出图片/时间/引用/替换/删除', () => {
    const page = read('src/pages/Static/img/index.tsx');
    assert.match(page, /<Radio.Button value="list">列表<\/Radio.Button>/);
    assert.match(page, /listMode \? \(/);
    for (const title of ['图片', '名称', '格式', '尺寸', '大小', '上传时间', '引用文章', '操作']) {
      assert.match(page, new RegExp(`title: '${title}'`), `列表缺少列 ${title}`);
    }
    assert.match(page, /formatDateTime/);
    assert.match(page, /displayImgName/);
    // 行内操作
    assert.match(page, /复制链接/);
    assert.match(page, />Markdown</);
    assert.match(page, /下载/);
    assert.match(page, />替换</);
    assert.match(page, /检测水印/);
    assert.match(page, />\s*删除\s*</);
    // 右键菜单也能替换
    assert.match(page, /data="replace"/);
    assert.match(page, /替换图片/);
  });

  it('引用文章按页批量查一次，不是每行一个请求', () => {
    const page = read('src/pages/Static/img/index.tsx');
    assert.match(page, /getImgReferences\(data\.map/);
    assert.match(page, /if \(!listMode \|\| !data\.length\)/);
    const api = read('src/services/van-blog/api.js');
    assert.match(api, /export async function getImgReferences/);
    assert.match(api, /\/api\/admin\/img\/references/);
  });

  it('替换保持原链接，并且要 img:replace 权限', () => {
    const page = read('src/pages/Static/img/index.tsx');
    assert.match(page, /replaceImgBySign/);
    assert.match(page, /链接保持不变/);
    assert.match(page, /img:replace/);
    assert.match(page, /replaceInputRef/);

    const api = read('src/services/van-blog/api.js');
    assert.match(api, /export async function replaceImgBySign/);
    assert.match(api, /\/api\/admin\/img\/\$\{sign\}\/replace/);

    const modal = read('src/components/CollaboratorModal/index.tsx');
    assert.match(modal, /label: '替换-图片'/);
    assert.match(modal, /value: 'img:replace'/);

    const access = readRepo('packages/server/src/types/access/access.ts');
    assert.match(access, /'img:replace': 'post-\/api\/admin\/img\/:sign\/replace'/);
    assert.match(access, /'post-\/api\/admin\/img\/:sign\/replace': 'img:replace'/);
    // 引用统计是只读的，协作者也能用
    assert.match(access, /'post-\/api\/admin\/img\/references'/);
  });

  it('小图模式一屏放更多张', () => {
    const page = read('src/pages/Static/img/index.tsx');
    assert.match(page, /thumb: \{ desktop: 60, mobile: 24 \}/);
    assert.match(page, /thumb: \{ desktop: \[12, '7\.6%'\], mobile: \[6, '15%'\] \}/);
    assert.match(page, /maxHeight: thumbMode \? 72 : 200/);
    // 每页数量跟着模式走，不再由 resize 观察器写死 9/15
    assert.match(page, /const pageSize = PAGE_SIZE\[viewMode\]/);
    assert.doesNotMatch(page, /setPageSize/);
  });

  it('工具栏有补缩略图和检测水印，右键菜单能检测单张', () => {
    const page = read('src/pages/Static/img/index.tsx');
    assert.match(page, /backfillThumbnails/);
    assert.match(page, /补缩略图/);
    assert.match(page, /detectStegoByFile/);
    assert.match(page, /detectStegoBySign/);
    assert.match(page, /检测水印/);
    assert.match(page, /data="detectStego"/);
    assert.match(page, /检测隐写水印/);
    // 补缩略图只有管理员能用（服务端接口没进 publicRoutes）
    assert.match(page, /showBackfillBtn/);
  });

  it('API 封装与工具函数', () => {
    const api = read('src/services/van-blog/api.js');
    assert.match(api, /export async function backfillThumbnails/);
    assert.match(api, /\/api\/admin\/img\/thumb\/backfill/);
    assert.match(api, /export async function detectStegoBySign/);
    assert.match(api, /\/api\/admin\/img\/stego\/detect/);
    assert.match(api, /export async function detectStegoByFile/);

    const tools = read('src/pages/Static/img/tools.tsx');
    assert.match(tools, /export const getThumbLink/);
    // 没有缩略图时要退回原图，老数据才不至于裂图
    assert.match(tools, /item\?\.realPath/);
    assert.match(tools, /thumb: '缩略图'/);
  });
});

describe('服务端：上传管线顺序', () => {
  it('缩放 → 隐写 → 压缩 → 缩略图，顺序不能乱', () => {
    const provider = readRepo('packages/server/src/provider/static/static.provider.ts');
    const resizeAt = provider.indexOf('capImageResolution(buf');
    const stegoAt = provider.indexOf('embedStegoWatermark(buf');
    const compressAt = provider.indexOf('compressImg(buf');
    const thumbAt = provider.indexOf('generateThumbnail(');
    const saveAt = provider.indexOf('await this.saveFile(');

    assert.ok(resizeAt > 0 && stegoAt > 0 && compressAt > 0 && thumbAt > 0 && saveAt > 0);
    // 缩放会重采样，必须在隐写之前；隐写要能被有损压缩读回来，所以在压缩之前
    assert.ok(resizeAt < stegoAt, '缩放必须在隐写之前');
    assert.ok(stegoAt < compressAt, '隐写必须在压缩之前');
    // 缩略图基于最终要落盘的 buffer，所以在 saveFile 之前算好塞进 meta
    assert.ok(thumbAt < saveAt, '缩略图要在落盘前生成');
    assert.match(provider, /extraMeta = \{ thumb: thumbPath/);
    assert.match(provider, /stego: stegoEmbedded/);
  });

  it('GIF 不做隐写，favicon 不生成缩略图', () => {
    const provider = readRepo('packages/server/src/provider/static/static.provider.ts');
    assert.match(provider, /enableStegoWaterMark\) && fileType != 'gif'/);
    assert.match(provider, /type == 'img' && !isFavicon && checkTrue\(staticConfigInDB\.enableThumb\)/);
  });

  it('删图时连带删掉缩略图', () => {
    const provider = readRepo('packages/server/src/provider/static/static.provider.ts');
    const del = provider.slice(provider.indexOf('async deleteOneBySign'));
    assert.match(del, /deleteStaticFile\(thumb\)/);
  });

  it('补缩略图只处理本地存储，失败的计入 failed', () => {
    const provider = readRepo('packages/server/src/provider/static/static.provider.ts');
    assert.match(provider, /async backfillThumbnails/);
    assert.match(provider, /item\.storageType !== 'local'/);
    assert.match(provider, /result\.failed \+= 1/);
  });
});

describe('服务端：设置与密钥', () => {
  it('默认值与字段定义', () => {
    const dto = readRepo('packages/server/src/types/setting.dto.ts');
    assert.match(dto, /DEFAULT_MAX_IMAGE_EDGE = 1920/);
    assert.match(dto, /DEFAULT_THUMB_WIDTH = 300/);
    assert.match(dto, /THUMB_FOLDER = 'thumb'/);
    assert.match(dto, /enableResize: true/);
    assert.match(dto, /enableThumb: true/);
    assert.match(dto, /enableStegoWaterMark: true/);
    assert.match(dto, /stegoKey\?: string/);
  });

  it('密钥只生成一次，而且不会返回给前端', () => {
    const setting = readRepo('packages/server/src/provider/setting/setting.provider.ts');
    assert.match(setting, /async getStegoKey/);
    assert.match(setting, /makeSalt\(\)/);
    assert.match(setting, /delete safe\.stegoKey/);
    // 保存设置时必须保留旧密钥，否则每次保存都会把水印换掉
    assert.match(setting, /const oldValue = await this\.readStaticSetting\(\)/);
  });

  it('数值范围有兜底', () => {
    const options = readRepo('packages/server/src/utils/imageOptions.ts');
    assert.match(options, /MIN_IMAGE_EDGE = 320/);
    assert.match(options, /MAX_IMAGE_EDGE = 8192/);
    assert.match(options, /MIN_THUMB_WIDTH = 64/);
    assert.match(options, /MAX_THUMB_WIDTH = 1024/);
    assert.match(options, /\[domain, who, when\]\.filter\(Boolean\)\.join\('\|'\)/);
  });
});

describe('服务端：替换图片', () => {
  it('写回原 URL，并按原格式重新编码', () => {
    const provider = readRepo('packages/server/src/provider/static/static.provider.ts');
    assert.match(provider, /async replaceBySign/);
    assert.match(provider, /forceFormat: targetFormat/);
    assert.match(provider, /overwriteStaticFile\(realPath, processed\.buffer\)/);
    // 远程图床不支持替换（URL 会变）
    assert.match(provider, /远程图床（PicGo \/ OSS）暂不支持替换/);

    const encode = readRepo('packages/server/src/utils/imgEncode.ts');
    assert.match(encode, /export async function encodeImageToFormat/);
    assert.match(encode, /canEncodeFormat/);

    const local = readRepo('packages/server/src/provider/static/local.provider.ts');
    assert.match(local, /async overwriteStaticFile/);
    assert.match(local, /resolveStaticAbs\(realPath\)/);
  });

  it('上传和替换共用同一条管线', () => {
    const provider = readRepo('packages/server/src/provider/static/static.provider.ts');
    assert.match(provider, /private async runImagePipeline/);
    // upload 和 replace 都调它，逻辑不会分叉
    assert.equal(provider.match(/this\.runImagePipeline\(/g).length, 2);
  });

  it('批量统计引用只查一次库，并转义正则元字符', () => {
    const article = readRepo('packages/server/src/provider/article/article.provider.ts');
    assert.match(article, /async countArticlesByLinks/);
    assert.match(article, /cleaned\.map\(escapeRegExp\)\.join\('\|'\)/);
    assert.match(article, /\.slice\(0, 200\)/);
    assert.match(article, /entry\.articles\.length < 10/);
  });
});

describe('服务端：隐写算法与权限', () => {
  it('块均值格点量化，改动幅度受限，载荷带 magic + CRC', () => {
    const stego = readRepo('packages/server/src/utils/stego.ts');
    assert.match(stego, /STEGO_BLOCK = 8/);
    assert.match(stego, /STEGO_DELTA = 16/);
    assert.match(stego, /STEGO_MAX_DELTA = 4/);
    assert.match(stego, /STEGO_MAGIC = 'VBL1'/);
    assert.match(stego, /export function crc32/);
    assert.match(stego, /nearestLattice/);
    assert.match(stego, /foldDiff/);
    // 提取时 magic 和 CRC 都要过，避免误报
    assert.match(stego, /const payload = decodePayload\(bitsToBytes\(all\.bits\)\)/);
  });

  it('只处理静态位图，gif/svg 跳过', () => {
    const stegoImage = readRepo('packages/server/src/utils/stegoWatermark.ts');
    assert.match(stegoImage, /SUPPORTED_FORMATS = new Set\(\['jpeg', 'jpg', 'png', 'webp', 'avif', 'tiff', 'bmp'\]\)/);
    const resize = readRepo('packages/server/src/utils/imgResize.ts');
    assert.match(resize, /SKIP_TYPES = \['gif', 'svg', 'svgz'\]/);
    assert.match(resize, /withoutEnlargement: true/);
  });

  it('检测水印对协作者开放，补缩略图只给管理员', () => {
    const access = readRepo('packages/server/src/types/access/access.ts');
    assert.match(access, /'post-\/api\/admin\/img\/stego\/detect'/);
    assert.ok(
      !access.includes('post-/api/admin/img/thumb/backfill'),
      '补缩略图会写文件，不应该进 publicRoutes',
    );
  });

  it('启动时创建缩略图目录', () => {
    const main = readRepo('packages/server/src/main.ts');
    assert.match(main, /THUMB_FOLDER/);
    assert.match(main, /checkOrCreate\(path\.join\(globalConfig\.staticPath, 'img', THUMB_FOLDER\)\)/);
  });
});

describe('文档', () => {
  it('图床文档写清了缩放、缩略图和隐写水印', () => {
    const doc = readRepo('docs/features/image-storage.md');
    assert.match(doc, /### 大图自动缩放/);
    assert.match(doc, /### 缩略图/);
    assert.match(doc, /### 隐写水印（肉眼不可见）/);
    assert.match(doc, /1920/);
    assert.match(doc, /300px/);
    assert.match(doc, /域名\|上传者\|上传时间/);
    // 明确说明缩放/裁剪之后读不出来，别让用户误以为是万能水印
    assert.match(doc, /缩放、裁剪、旋转/);
    assert.match(readRepo('docs/reference/dir.md'), /img\/thumb\//);
  });
});
