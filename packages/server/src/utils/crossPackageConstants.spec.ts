/**
 * 跨包常量对账：同一个数字在 server / website / admin 各写一遍，谁改了另一边没改就红。
 *
 * ## 为什么不直接抽公共模块
 * 这三个包各自独立构建（server 是 Nest、website 是 Next、admin 是 umi3 + React17），
 * 跨包 import 会把构建耦合起来，代价远大于"写两遍 + 一条对账断言"。所以**不重构**，
 * 只把"它们必须相等"这件事变成可执行的契约。
 *
 * ## 对账的三组
 * 1. 摘要长度 200：`server/src/utils/articleExcerpt.ts` ↔ `website/utils/articleExcerpt.ts`
 *    （服务端生成摘要、前台也算一次，两边不一致会出现"列表摘要与卡片摘要长度不同"）
 * 2. 缩略图默认宽 300：`server/src/types/setting.dto.ts` ↔ `admin/.../WaterMarkForm`
 * 3. 长边默认 1920 / 上限 8192、缩略图 64–1024：`server/src/{types/setting.dto,utils/imageOptions}.ts`
 *    ↔ `admin/.../WaterMarkForm`（后台表单的 `min`/`max`/`placeholder` 就是给用户看的取值范围，
 *    与服务端的夹取不一致 = 界面上说能填、服务端悄悄改掉）
 *
 * ⚠️ 有意**不**对账的一对：长边的 `min`。后台是 `min={0}`（0 = 不缩放，是合法输入），
 * 服务端是 `MIN_IMAGE_EDGE = 320`（**夹取下限**：填 1–319 会被抬到 320）。
 * 两者语义不同、值本来就该不同 —— 见下面那条"别把语义不同的东西对账"的用例。
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (...parts: string[]) =>
  stripCommentsForAnchor(fs.readFileSync(path.join(ROOT, ...parts), 'utf-8'));

const SERVER_EXCERPT = read('packages/server/src/utils/articleExcerpt.ts');
const WEBSITE_EXCERPT = read('packages/website/utils/articleExcerpt.ts');
const SERVER_DTO = read('packages/server/src/types/setting.dto.ts');
const SERVER_IMAGE_OPTIONS = read('packages/server/src/utils/imageOptions.ts');
const ADMIN_WATERMARK_FORM = read('packages/admin/src/components/WaterMarkForm/index.tsx');

/** 取第一个捕获组里的整数；取不到就抛，避免"undefined === undefined"这种假绿。 */
function num(src: string, re: RegExp, what: string): number {
  const m = src.match(re);
  if (!m) throw new Error(`没找到 ${what}（正则 ${re} 失配 —— 是代码改了形状还是文件挪了？）`);
  const n = Number(m[1]);
  if (!Number.isFinite(n)) throw new Error(`${what} 解析出来不是数字：${m[1]}`);
  return n;
}

/**
 * 从后台表单里切出某个字段的那一段（避免把两个字段的 `min`/`max`/`placeholder` 混起来）。
 * ⚠️ 只适合取**字段控件自身**的属性：`name="thumbWidth"` 在文件后半段（:183），
 * 而默认值/回落值写在文件顶部的 initialValues + transform 块里（:22-34），
 * 向前切片取不到它们 —— 那些要用 `adminDefault()` 从整份文件取。
 */
function adminFieldSlice(fieldName: string): string {
  const at = ADMIN_WATERMARK_FORM.indexOf(`name="${fieldName}"`);
  if (at < 0) throw new Error(`后台表单里找不到 name="${fieldName}" 这个字段`);
  return ADMIN_WATERMARK_FORM.slice(at, at + 900);
}

/** 后台表单里的默认值 / 回落值（写在文件顶部的 initialValues 与 transform 块，不在字段段里）。 */
function adminDefault(re: RegExp, what: string): number {
  return num(ADMIN_WATERMARK_FORM, re, what);
}

describe('摘要长度（server ↔ website）', () => {
  const re = /export const DEFAULT_OVERVIEW_CHARS\s*=\s*(\d+)/;
  const server = num(SERVER_EXCERPT, re, 'server DEFAULT_OVERVIEW_CHARS');
  const website = num(WEBSITE_EXCERPT, re, 'website DEFAULT_OVERVIEW_CHARS');

  it('两个包的 DEFAULT_OVERVIEW_CHARS 相等', () => {
    expect({ server, website }).toEqual({ server: website, website });
  });

  it('并且就是文档里写的那个 200', () => {
    expect(server).toBe(200);
  });

  // 🔴 R4-11：标记分支的硬上限也必须两边同值。它是常量而不是环境变量，
  //    因为前台那份实现跑在浏览器里（PostCard 用 useMemo/useState），读不到 process.env.VANBLOG_*；
  //    一侧可配一侧不可配会让两边在生产环境算出不同摘要。
  describe('标记摘要上限 MARKER_EXCERPT_MAX_CHARS', () => {
    const capRe = /export const MARKER_EXCERPT_MAX_CHARS\s*=\s*(\d+)/;
    const serverCap = num(SERVER_EXCERPT, capRe, 'server MARKER_EXCERPT_MAX_CHARS');
    const websiteCap = num(WEBSITE_EXCERPT, capRe, 'website MARKER_EXCERPT_MAX_CHARS');

    it('两个包相等', () => {
      expect({ serverCap, websiteCap }).toEqual({ serverCap: websiteCap, websiteCap });
    });

    it('并且就是文档里写的那个 400（且大于自动回退预算 200）', () => {
      expect(serverCap).toBe(400);
      expect(serverCap).toBeGreaterThan(server);
    });
  });
});

describe('缩略图默认宽（server ↔ admin）', () => {
  it('服务端默认值与后台表单的默认值/回落值一致', () => {
    const server = num(SERVER_DTO, /export const DEFAULT_THUMB_WIDTH\s*=\s*(\d+)/, 'server DEFAULT_THUMB_WIDTH');
    const formDefault = adminDefault(/thumbWidth:\s*(\d+)/, 'admin thumbWidth 默认值');
    const formFallback = adminDefault(/thumbWidth\s*\|\|\s*(\d+)/, 'admin thumbWidth 回落值');
    expect({ server, formDefault, formFallback }).toEqual({ server: server, formDefault: server, formFallback: server });
    expect(server).toBe(300);
  });

  it('后台表单的取值范围与服务端的夹取上下限一致', () => {
    const min = num(SERVER_IMAGE_OPTIONS, /export const MIN_THUMB_WIDTH\s*=\s*(\d+)/, 'server MIN_THUMB_WIDTH');
    const max = num(SERVER_IMAGE_OPTIONS, /export const MAX_THUMB_WIDTH\s*=\s*(\d+)/, 'server MAX_THUMB_WIDTH');
    const slice = adminFieldSlice('thumbWidth');
    expect(num(slice, /min=\{(\d+)\}/, 'admin thumbWidth min')).toBe(min);
    expect(num(slice, /max=\{(\d+)\}/, 'admin thumbWidth max')).toBe(max);
  });
});

describe('大图长边（server ↔ admin）', () => {
  it('默认值一致：服务端常量 = 表单默认 = 表单回落 = placeholder', () => {
    const server = num(SERVER_DTO, /export const DEFAULT_MAX_IMAGE_EDGE\s*=\s*(\d+)/, 'server DEFAULT_MAX_IMAGE_EDGE');
    // 默认值与回落值写在文件顶部的 initialValues / transform 块，不在字段段里
    expect(adminDefault(/maxImageEdge:\s*(\d+)/, 'admin maxImageEdge 默认值')).toBe(server);
    expect(adminDefault(/maxImageEdge\s*\?\?\s*(\d+)/, 'admin maxImageEdge 回落值')).toBe(server);
    // placeholder 属于字段控件本身，按字段切片取
    expect(num(adminFieldSlice('maxImageEdge'), /placeholder="(\d+)"/, 'admin maxImageEdge placeholder')).toBe(server);
    expect(server).toBe(1920);
  });

  it('上限一致：服务端 MAX_IMAGE_EDGE = 表单 max', () => {
    const server = num(SERVER_IMAGE_OPTIONS, /export const MAX_IMAGE_EDGE\s*=\s*(\d+)/, 'server MAX_IMAGE_EDGE');
    expect(num(adminFieldSlice('maxImageEdge'), /max=\{(\d+)\}/, 'admin maxImageEdge max')).toBe(server);
    expect(server).toBe(8192);
  });

  it('⚠️ 长边的 min **故意不对账**：后台 0 是"不缩放"这个合法输入，服务端 320 是夹取下限', () => {
    const adminMin = num(adminFieldSlice('maxImageEdge'), /min=\{(\d+)\}/, 'admin maxImageEdge min');
    const serverFloor = num(SERVER_IMAGE_OPTIONS, /export const MIN_IMAGE_EDGE\s*=\s*(\d+)/, 'server MIN_IMAGE_EDGE');
    expect(adminMin).toBe(0);
    expect(serverFloor).toBe(320);
    expect(adminMin).not.toBe(serverFloor);
    // 后台的 tooltip 必须把这个"填了会被抬上去"的行为说出来，否则用户以为 0 与 100 效果一样
    expect(adminFieldSlice('maxImageEdge')).toMatch(/小于\s*320|抬到\s*320|320/);
  });
});

describe('对账机制本身不是空的', () => {
  it('num() 在形状变了的时候会抛，而不是返回 undefined 让断言假绿', () => {
    expect(() => num('export const DEFAULT_THUMB_WIDTH = 300;', /export const NOT_THERE\s*=\s*(\d+)/, 'x')).toThrow(
      /没找到 x/,
    );
  });

  it('字段切片真的取到了对应字段（不会把另一个字段的 min/max 当成它的）', () => {
    // thumbWidth 段里有 64/1024，maxImageEdge 段里有 0/8192；两段不能混
    expect(adminFieldSlice('thumbWidth')).toMatch(/min=\{64\}/);
    expect(adminFieldSlice('maxImageEdge')).toMatch(/max=\{8192\}/);
    expect(adminFieldSlice('thumbWidth')).not.toMatch(/max=\{8192\}/);
  });

  it('三个包的源文件都真的读到了（防止路径挪了以后整个 spec 空转）', () => {
    for (const [name, src] of [
      ['server articleExcerpt', SERVER_EXCERPT],
      ['website articleExcerpt', WEBSITE_EXCERPT],
      ['server setting.dto', SERVER_DTO],
      ['server imageOptions', SERVER_IMAGE_OPTIONS],
      ['admin WaterMarkForm', ADMIN_WATERMARK_FORM],
    ] as [string, string][]) {
      expect({ name, len: src.length }).toEqual({ name, len: expect.any(Number) as unknown as number });
      expect(src.length).toBeGreaterThan(200);
    }
  });
});
