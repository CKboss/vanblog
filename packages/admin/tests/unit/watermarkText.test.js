const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const repoRoot = path.join(adminRoot, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * 后台「可见水印文字」的中文闸门。
 *
 * 这道闸门（`checkNoChinese` → Modal「目前水印文字不支持中文！因为用了纯 js 库节约资源」）
 * 是 jimp + `.fnt` 位图字体时代加的，那时确实渲染不了汉字。2026-09 渲染整个重写成
 * sharp/libvips + SVG `<text>`（字体栈 DejaVu Sans → Noto Sans CJK SC → WenQuanYi Zen Hei），
 * 前提就不成立了：服务端能盖中文，官方镜像也装了 `ttf-dejavu` + `wqy-zenhei`
 * （由 scripts/tests/dockerfile-alpine-sharp.test.sh 钉住，含"不许匹配到注释"的防假绿）。
 *
 * 留着闸门的代价是**功能被前端白白禁用**：服务端支持、镜像有字体，用户却存不进一个中文水印。
 * 同一批还要改的是那两处过时文案（默认样式早已不是"右下角"，门槛也不是 128px）。
 */
describe('可见水印文字：中文闸门已随渲染重写拆掉', () => {
  // ⚠️ 断言"某段代码已经不存在"之前必须先剥注释：表单里留了一段**解释为什么拆掉闸门**的
  // 注释，里面就写着 `checkNoChinese` —— 直接 doesNotMatch 会匹配到那段注释而假红。
  // 本仓库在 server 侧同一个坑踩过四次（见 src/test-utils/anchorCode.ts 的文件注释），
  // 在 shell 守卫里也踩过（dockerfile-alpine-sharp.test.sh 的 vips-dev 假绿）。
  const noComments = (s) =>
    s
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .map((l) => l.replace(/(\s|^)\/\/.*$/, '$1'))
      .join('\n');

  it('表单不再拦中文，那个 helper 也删干净了（它只有这一处调用方）', () => {
    const form = noComments(read('src/components/WaterMarkForm/index.tsx'));
    assert.doesNotMatch(form, /checkNoChinese/);
    assert.doesNotMatch(form, /checkString/);
    assert.doesNotMatch(form, /不支持中文/);
    assert.doesNotMatch(form, /纯 js 库/);
    assert.ok(
      !existsSync(path.join(adminRoot, 'src/services/van-blog/checkString.ts')),
      'checkString.ts 应该已删除（escape() 早已 deprecated，且没有别的调用方）',
    );
    // 「开启水印必须指定水印文字」这条**要留着**：它是真空值校验，与中文无关
    assert.match(form, /开启水印必须指定水印文字/);
  });

  it('反证：闸门在的时候这条断言真的会红（免得上面那条是空断言）', () => {
    // 把旧闸门那两行原样贴回来，noComments + doesNotMatch 必须能抓到它
    const resurrected = noComments(
      [
        "import { checkNoChinese } from '@/services/van-blog/checkString';",
        'const x = 1; // 行尾注释里提到 checkNoChinese 也不算',
        'if (!checkNoChinese(data.waterMarkText)) {',
        "  Modal.info({ title: '目前水印文字不支持中文！' });",
        '}',
      ].join('\n'),
    );
    assert.match(resurrected, /checkNoChinese/);
    assert.match(resurrected, /不支持中文/);
    // 而注释里提到不算数：整行注释被剥掉了
    assert.doesNotMatch(noComments('// 以前这里有一道 checkNoChinese 闸门'), /checkNoChinese/);
  });

  it('文案说的是现在这套渲染：支持中文、默认满图平铺、短边 52px 以下跳过', () => {
    const form = read('src/components/WaterMarkForm/index.tsx');
    assert.match(form, /支持中文/);
    assert.match(form, /满图斜排平铺/);
    assert.match(form, /短边小于 52px/);
    // 样式与位置是服务端 env 决定的，表单里要指路（否则用户找不到怎么改成右下角）
    assert.match(form, /VANBLOG_WATERMARK_STYLE/);
    assert.match(form, /VANBLOG_WATERMARK_POSITION/);
    // 旧文案的两个具体错误不许回来：默认样式不是"右下角"，跳过门槛也不是 128px
    assert.doesNotMatch(form, /加到图片右下角/);
    assert.doesNotMatch(form, /小于 128px/);
  });

  it('跨包钉子：文案里的 52px 与"跳过而不是失败"必须与服务端实现一致', () => {
    const wm = readRepo('packages/server/src/utils/watermark.ts');
    // 门槛：短边小于阈值时按原图返回（改了实现就要改文案，反之亦然）。
    // ⚠️ 这里**不要**钉字面的 "52"：服务端现在把阈值抽成了导出常量
    //    `WATERMARK_MIN_SHORT_SIDE_PX`，判定（smallImageTileStep）与 WARN 文案都取它 ——
    //    以前正是"判定写死 48、文案与文档写 52"才出现 48…51px 那段"日志说跳过、其实照盖"。
    //    钉字面数字会把两者重新解耦，所以钉"同源"这件事本身：
    assert.match(wm, /export const WATERMARK_MIN_SHORT_SIDE_PX = 52/);
    assert.match(wm, /短边 \$\{minSide\}px < \$\{WATERMARK_MIN_SHORT_SIDE_PX\}px/);
    assert.match(wm, /Math\.max\(WATERMARK_MIN_SHORT_SIDE_PX, minSide - 4\)/);
    assert.match(wm, /按原图返回/);
    // 表单文案里那个数字必须与常量一致（表单是纯文本，只能写死，所以在这里对账）
    const formHere = read('src/components/WaterMarkForm/index.tsx');
    assert.match(formHere, /短边小于 52px/);
    // 文字过长时先自动缩字号，缩到下限还放不下才跳过 —— 文案说的就是这条
    assert.match(wm, /MIN_RENDER_FONT_PX = 8/);
    // 缺字体是"WARN + 原图"，不是上传失败（所以表单不需要拦，只需要说清代价）
    assert.match(wm, /宁可不盖/);
  });
});
