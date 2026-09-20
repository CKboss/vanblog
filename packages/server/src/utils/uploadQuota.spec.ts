import { BadRequestException, HttpException } from '@nestjs/common';

jest.mock('image-size', () => ({
  imageSize: jest.fn(),
}));

import { imageSize } from 'image-size';
import { ImgController } from 'src/controller/admin/img/img.controller';
import { __resetAttemptLimitForTest } from 'src/utils/attemptLimit';
import {
  DEFAULT_UPLOAD_MIN_FREE_BYTES,
  MAX_STEGO_DETECT_PIXELS,
  assertUploadedImage,
  resolveUploadMinFreeBytes,
  uploadSpaceShortfallMessage,
} from './uploadLimits';

/**
 * 两条"零权限就能打"的资源面：
 *
 * **A. `POST /api/admin/img/stego/detect`** —— 它在 publicRoutes 里（`types/access/access.ts`，
 * 注释明写"协作者也能用来验图"，admin 侧调用点是 `pages/Static/img/index.tsx` 的
 * `detectStegoByFile` / `detectStegoBySign`，即图片管理页 ⇒ **不能移出 publicRoutes**，
 * 否则零权限协作者的图片管理页会坏）。以前它只过 `IMAGE_UPLOAD_OPTIONS`（50MB + 后缀过滤），
 * 既没有内容校验也没有专用限流：检测要把整图解码成 raw RGBA 再逐像素比对，实测
 * 1MP → 23 ms，**36MP → 401 ms、heap 49MB、RSS 477MB** ⇒ 3 个并发约 1.4GB RSS，
 * 常见 1–2GB 容器直接 OOMKilled；而全局桶 600/分钟/IP 等于每分钟 240 秒 CPU。
 *
 * **B. 上传没有任何总量配额** —— 以前只有"单文件 ≤ 50MB/200MB"，没有"磁盘还剩多少"的概念
 * （`quota|totalBytes|diskUsage|statfs` 在 static/uploadLimits 里零命中），而
 * `post-/api/admin/img/upload`(50MB) 与 `post-/api/admin/file/upload`(200MB) 都在 publicRoutes
 * ⇒ 零权限协作者可以无限次上传，一台 20GB 盘的小机器几分钟写满。磁盘满的连锁反应比
 * "上传失败"严重得多：mongo 的 WiredTiger 写失败、备份写流 ENOSPC、日志写不进 ⇒
 * 站点进入"容器 Up 但什么都写不了"的半死状态，而 restart 策略不会介入。
 *
 * ⚠️ 断言全部是**行为级**的：真的连打 11 次看第 11 次是不是 429、真的看 provider 有没有被调用、
 * 真的用假的剩余空间数值走判定。只 grep 源码里有没有 429 分支是**空断言** ——
 * 把判定写成 `if (false && …)` 子串仍然匹配，本轮已经有两条守卫因此空转。
 */

const mockedImageSize = imageSize as unknown as jest.Mock;

function buildController() {
  const calls: Array<{ sign?: string; buffer?: Buffer }> = [];
  const c: any = Object.create(ImgController.prototype);
  c.staticProvider = {
    detectStegoWatermark: jest.fn(async (input: any) => {
      calls.push(input);
      return { found: false };
    }),
  };
  return { c, calls };
}

function buildRequest(ip = '203.0.113.7') {
  const headers: Record<string, string> = {};
  // ⚠️ 用**非回环**地址：防爆破类计数走套接字口径（`bruteForceClientIp`），
  //    回环地址在既有口径下可能被特殊处理，那会让限流断言变成空转。
  const request: any = {
    socket: { remoteAddress: ip },
    ip,
    headers,
    res: { setHeader: (k: string, v: string) => (headers[k] = v) },
  };
  return { request, headers };
}

/** 一个最小合法 PNG（1×1），用来走"正常上传"的正例。 */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('stego/detect：专用限流（10 次/分钟/IP）', () => {
  beforeEach(() => {
    __resetAttemptLimitForTest();
    mockedImageSize.mockReset();
    mockedImageSize.mockReturnValue({ type: 'png', width: 100, height: 100 });
  });

  it('前 10 次照常放行，第 11 次 429 + Retry-After，且 provider 没被调用', async () => {
    const { c, calls } = buildController();
    const { request, headers } = buildRequest();
    for (let i = 0; i < 10; i += 1) {
      await c.detectStego(undefined, { sign: 'abc' }, request);
    }
    expect(calls).toHaveLength(10);

    let thrown: any = null;
    try {
      await c.detectStego(undefined, { sign: 'abc' }, request);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown.getStatus()).toBe(429);
    expect(thrown.getResponse()).toEqual({ statusCode: 429, message: '图片检测过于频繁，请稍后再试' });
    expect(Number(headers['Retry-After'] || 0)).toBeGreaterThanOrEqual(1);
    // ⚠️ 被挡住的那次**不能**已经把图解码了（那正是我们要省的成本）
    expect(calls).toHaveLength(10);
  });

  it('换一个 IP 就是另一个桶（说明计数确实按 IP 分）', async () => {
    const { c } = buildController();
    const a = buildRequest('203.0.113.7');
    const b = buildRequest('203.0.113.8');
    for (let i = 0; i < 10; i += 1) {
      await c.detectStego(undefined, { sign: 's' }, a.request);
    }
    await expect(c.detectStego(undefined, { sign: 's' }, a.request)).rejects.toThrow(HttpException);
    // 另一个 IP 仍然可以（这不是"放行攻击"，只是证明桶的 key 真的是 IP）
    await expect(c.detectStego(undefined, { sign: 's' }, b.request)).resolves.toBeDefined();
  });
});

describe('stego/detect：上传的字节要过内容校验，且用更小的 8MP 上限', () => {
  beforeEach(() => {
    __resetAttemptLimitForTest();
    mockedImageSize.mockReset();
  });

  it('超过检测上限（8MP）→ 400，消息告诉用户改走"先上传再按 sign 验"', async () => {
    mockedImageSize.mockReturnValue({ type: 'png', width: 9000, height: 1000 }); // 9MP > 8MP
    const { c, calls } = buildController();
    const { request } = buildRequest();
    let thrown: any = null;
    try {
      await c.detectStego({ buffer: PNG_1x1, originalname: 'big.png' }, {}, request);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(String(thrown.message)).toContain('8MP');
    expect(String(thrown.message)).toContain('上传到图床');
    expect(calls).toHaveLength(0); // 没有解码，成本被挡在门外
  });

  it('⚠️ 上限常量确实是 8MP，且明显小于全站的 40MP（不是把两个值写成一样）', () => {
    expect(MAX_STEGO_DETECT_PIXELS).toBe(8_000_000);
    expect(MAX_STEGO_DETECT_PIXELS).toBeLessThan(40_000_000);
  });

  it('SVG 仍然被拒（与其它上传口一致）', async () => {
    const { c } = buildController();
    const { request } = buildRequest();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await expect(c.detectStego({ buffer: svg, originalname: 'x.png' }, {}, request)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('正例：合法的 1×1 PNG 照常检测（别把功能弄坏）', async () => {
    mockedImageSize.mockReturnValue({ type: 'png', width: 1, height: 1 });
    const { c, calls } = buildController();
    const { request } = buildRequest();
    await c.detectStego({ buffer: PNG_1x1, originalname: 'ok.png' }, {}, request);
    expect(calls).toHaveLength(1);
    expect(calls[0].buffer).toBe(PNG_1x1);
  });

  it('正例：按 sign 检测（没有上传字节）**不套 8MP 上限**，否则验不了自己库里的大图', async () => {
    // imageSize 不会被调用（没有 buffer），所以这里故意不 mock 返回值：
    // 如果实现错误地对 sign 路径也做了像素校验，这条会因为 imageSize 返回 undefined 而炸。
    const { c, calls } = buildController();
    const { request } = buildRequest();
    await c.detectStego(undefined, { sign: 'existing-sign' }, request);
    expect(calls).toEqual([{ sign: 'existing-sign', buffer: undefined }]);
    expect(mockedImageSize).not.toHaveBeenCalled();
  });
});

describe('assertUploadedImage：可选的 maxPixels 不改变既有默认', () => {
  beforeEach(() => mockedImageSize.mockReset());

  it('不传 opts 时仍用全站上限（40MP），36MP 的图能通过', () => {
    mockedImageSize.mockReturnValue({ type: 'png', width: 6000, height: 6000 }); // 36MP
    expect(() => assertUploadedImage(PNG_1x1, 'a.png')).not.toThrow();
  });

  it('传了更小的 maxPixels 就按它判，并给出调用方自己的文案', () => {
    mockedImageSize.mockReturnValue({ type: 'png', width: 6000, height: 6000 });
    let msg = '';
    try {
      assertUploadedImage(PNG_1x1, 'a.png', { maxPixels: MAX_STEGO_DETECT_PIXELS, tooLargeHint: '自定义文案' });
    } catch (err: any) {
      msg = String(err.message);
    }
    expect(msg).toBe('自定义文案');
  });
});

describe('上传剩余空间闸门：环境变量解析', () => {
  const OLD = process.env.VANBLOG_UPLOAD_MIN_FREE_BYTES;
  afterEach(() => {
    if (OLD === undefined) delete process.env.VANBLOG_UPLOAD_MIN_FREE_BYTES;
    else process.env.VANBLOG_UPLOAD_MIN_FREE_BYTES = OLD;
  });

  it('默认 500MB；缺失与垃圾值都回落默认', () => {
    expect(DEFAULT_UPLOAD_MIN_FREE_BYTES).toBe(500 * 1024 * 1024);
    expect(resolveUploadMinFreeBytes(undefined)).toBe(DEFAULT_UPLOAD_MIN_FREE_BYTES);
    expect(resolveUploadMinFreeBytes('')).toBe(DEFAULT_UPLOAD_MIN_FREE_BYTES);
    expect(resolveUploadMinFreeBytes('abc')).toBe(DEFAULT_UPLOAD_MIN_FREE_BYTES);
    expect(resolveUploadMinFreeBytes('-1')).toBe(DEFAULT_UPLOAD_MIN_FREE_BYTES);
  });

  it('认得 `500mb` / `2gb` / 纯字节数三种写法', () => {
    expect(resolveUploadMinFreeBytes('500mb')).toBe(500 * 1024 * 1024);
    expect(resolveUploadMinFreeBytes('2GB')).toBe(2 * 1024 * 1024 * 1024);
    expect(resolveUploadMinFreeBytes('1048576')).toBe(1048576);
    expect(resolveUploadMinFreeBytes('1.5gb')).toBe(Math.round(1.5 * 1024 * 1024 * 1024));
  });

  it('⚠️ `0` 是唯一的关闭方式（显式写 0），不是"回落默认"', () => {
    expect(resolveUploadMinFreeBytes('0')).toBe(0);
  });

  it('超大值夹到 1TB（再大就等于禁止上传，那是用错旋钮）', () => {
    expect(resolveUploadMinFreeBytes('99tb')).toBe(1024 * 1024 * 1024 * 1024);
  });
});

describe('上传剩余空间闸门：判定是纯函数（statfsSync 在 jest 里不可重定义）', () => {
  const MB = 1024 * 1024;

  it('余量充足 → 放行（null）', () => {
    expect(uploadSpaceShortfallMessage(10 * 1024 * MB, 50 * MB, 500 * MB)).toBeNull();
  });

  it('写入后会低于下限 → 拒绝，消息含实际数字与可照做的出路', () => {
    const msg = uploadSpaceShortfallMessage(600 * MB, 200 * MB, 500 * MB);
    expect(typeof msg).toBe('string');
    // 600MB 剩余 − 200MB 写入 = 400MB，低于 500MB 下限 ⇒ 拒绝；消息要把这三个数都说清
    expect(msg).toContain('400 MB');
    expect(msg).toContain('200 MB');
    expect(msg).toContain('500 MB');
    expect(msg).toContain('VANBLOG_UPLOAD_MIN_FREE_BYTES');
    expect(msg).toContain('清理');
  });

  it('边界：刚好等于下限 → 放行；差一个字节 → 拒绝', () => {
    const minFree = 500 * MB;
    expect(uploadSpaceShortfallMessage(minFree, 0, minFree)).toBeNull();
    expect(uploadSpaceShortfallMessage(minFree - 1, 0, minFree)).not.toBeNull();
  });

  it('⚠️ 读不到剩余空间（null）→ **跳过闸门而不是拒绝**', () => {
    // 与 utils/fullBackup.ts 的恢复闸门同口径：null 与 0 必须分开，
    // 否则一个读不到 statfs 的部署会让所有上传都失败 —— 那是把可用性换成一个并不存在的保证。
    expect(uploadSpaceShortfallMessage(null, 200 * MB, 500 * MB)).toBeNull();
    // 而真的剩 0 字节时必须拒绝
    expect(uploadSpaceShortfallMessage(0, 1, 500 * MB)).not.toBeNull();
  });

  it('minFree = 0 表示显式关闭：即使剩 0 字节也放行', () => {
    expect(uploadSpaceShortfallMessage(0, 200 * MB, 0)).toBeNull();
  });

  it('incomingBytes 未知（0/负数/NaN）时只按"余量够不够下限"判', () => {
    expect(uploadSpaceShortfallMessage(600 * MB, 0, 500 * MB)).toBeNull();
    expect(uploadSpaceShortfallMessage(400 * MB, Number.NaN, 500 * MB)).not.toBeNull();
    expect(uploadSpaceShortfallMessage(600 * MB, -5, 500 * MB)).toBeNull();
  });
});

describe('接线证明：saveFile 真的会在落盘前查剩余空间（不是只导出了一个没人调的纯函数）', () => {
  // ⚠️ 这条是整个第 4 项里最容易空转的地方：纯函数测得再全，也不能证明 `static.provider.ts`
  //    的 saveFile 真的调用了它。所以这里 spy 掉 freeSpaceBytes（用 spyOn 而不是 jest.mock，
  //    避免把整个 fullBackup 模块换掉影响别的 importer），然后看两件事：
  //    ①余量不足时抛 400 且 **localProvider.saveFile 没被调用**（成本与磁盘都没动）；
  //    ②余量充足时照常落盘。
  const fullBackup = require('src/utils/fullBackup');
  const { StaticProvider } = require('src/provider/static/static.provider');
  const MB = 1024 * 1024;
  let spy: jest.SpyInstance;

  function buildProvider() {
    const p: any = Object.create(StaticProvider.prototype);
    const localCalls: any[] = [];
    p.settingProvider = { getStaticSetting: async () => ({ storageType: 'local' }) };
    p.localProvider = {
      saveFile: async (fileName: string, buffer: Buffer) => {
        localCalls.push({ fileName, bytes: buffer?.length });
        return { realPath: `/static/img/${fileName}`, meta: { type: 'png' } };
      },
    };
    p.createInDB = async () => undefined;
    return { p, localCalls };
  }

  beforeEach(() => {
    spy = jest.spyOn(fullBackup, 'freeSpaceBytes');
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it('余量不足 → 400，且 localProvider.saveFile 一次都没被调用', async () => {
    spy.mockReturnValue(100 * MB); // 低于默认的 500MB 下限
    const { p, localCalls } = buildProvider();
    await expect(
      p.saveFile('png', 'x.png', Buffer.alloc(1024, 1), 'img' as any, 'sign-1'),
    ).rejects.toThrow(/存储空间不足/);
    expect(localCalls).toEqual([]);
  });

  it('余量充足 → 照常落盘（正例，别把上传功能弄坏）', async () => {
    spy.mockReturnValue(10 * 1024 * MB);
    const { p, localCalls } = buildProvider();
    const out = await p.saveFile('png', 'x.png', Buffer.alloc(1024, 1), 'img' as any, 'sign-2');
    expect(String(out)).toContain('x.png');
    expect(localCalls).toHaveLength(1);
  });

  it('⚠️ 读不到剩余空间（null）→ 跳过闸门而不是拒绝（与恢复闸门同口径）', async () => {
    spy.mockReturnValue(null);
    const { p, localCalls } = buildProvider();
    await p.saveFile('png', 'x.png', Buffer.alloc(1024, 1), 'img' as any, 'sign-3');
    expect(localCalls).toHaveLength(1);
  });

  it('⚠️ 反证：真的查了磁盘（spy 被调用过），不是碰巧放行', async () => {
    spy.mockReturnValue(10 * 1024 * MB);
    const { p } = buildProvider();
    await p.saveFile('png', 'x.png', Buffer.alloc(1024, 1), 'img' as any, 'sign-4');
    expect(spy).toHaveBeenCalled();
  });
});
