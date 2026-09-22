import { BadRequestException } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import {
  assertSingleFileName,
  describeUnsafeNameForLog,
  resolveStoredFileAbs,
  resolveWithinStorageAbs,
  sanitizeStoredImageName,
} from './storedFileName';

/**
 * 图片落盘名的净化与容器化校验。
 *
 * 背景（纵深防御）：附件那条路一直是 `<md5>.<sanitizeAttachmentName(原名)>`，
 * 而图片那条路以前是裸的 `<md5>.<原名>`，`decodeUploadFileName()` 只修 latin1→utf8 乱码、
 * **不剥分隔符**，落盘处也只是 `path.join()` + `writeFileSync`。今天不可利用的唯一原因是
 * busboy 默认对 multipart 的 filename 做 `basename()`（`preservePath` 全仓库未设置）——
 * 也就是防线建在**依赖项的默认值**上。这里钉住我们自己的两层。
 */

/**
 * 敌意文件名，分两组 —— 因为**它们在这一层的正确结局不一样**，混在一起就会写出
 * 一条错的断言（第一版就是这么红的：把百分号编码的形状也当成"必须抛"）。
 *
 * - TRAVERSAL：含真实分隔符 / `..` 段 / 绝对路径 / NUL / 控制字符 ⇒ **必须被拒**。
 * - INERT_SINGLE_SEGMENT：字面上就是单段怪名字（`%2e%2e%2f` 在这一层**不会被解码**，
 *   它就是文件名的一部分）⇒ 不该抛，而该**证明它解析出来仍在目录内**。
 *   解码 URL 是服务层的事（express static + `utils/staticGuard`），它们各有容器化校验。
 */
const TRAVERSAL = [
  '../../evil.js',
  '..\\..\\evil.js',
  '../../../etc/passwd',
  '/etc/passwd',
  'a/b.png',
  'a\\b.png',
  '....//....//evil.png',
  'foo\u0000.png',
  'evil\nX-Injected: 1.png',
  '..' + path.sep + '..',
];

const INERT_SINGLE_SEGMENT = [
  '..%2f..%2fevil.png',
  '%2e%2e%2fevil.png',
  '-rf',
  '--upload-pack=evil',
  '"quoted".png',
  "o'reilly.png",
];

const HOSTILE = [...TRAVERSAL, ...INERT_SINGLE_SEGMENT];

describe('图片落盘名：净化 + 容器化校验', () => {
  let root: string;
  /**
   * 🔴 `root` 的**私有**父目录，专门给下面那条"不会在 root 之外留下东西"的断言当观测面。
   *
   * 为什么不能直接用 `path.resolve(root, '..')`（= 系统 tmpdir）：那条断言要证明的是
   * **被测函数**没有在 `root` 之外写东西，而"root 的父目录"只是最近的可观测代理 ——
   * 它恰好是系统 `/tmp` 纯属偶然（`mkdtempSync(tmpdir(), …)`），**不是有意要检查整个 `/tmp`**。
   * 于是它实际断言的是"**整个 `/tmp` 在这条用例执行期间没有任何新条目出现**"，
   * 而 `/tmp` 是全机共享的：并发跑全量 jest 时，别的套件与变异驱动会不停在里面
   * `mkdtempSync`（`mdz-read-*`、`vanblog-md-export-*`、`vanblog-gate-*`、`vanblog-mutation.*`）
   * ⇒ **断言必然偶发红，而红的原因与被测代码毫无关系**。
   *
   * 🔴 这正是本仓库反复出现的一族："红自己消失"被误记成**负载敏感假红**，
   * 而真因是**测试装置写错**（同族：`rateLimit.spec.ts` 的 `uniqueIp()` 从 200 个地址里随机取
   * 导致两条用例撞进同一个限流桶；`loginThrottle` 用墙上时钟判断"有没有等待"）。
   * 三者的处置相反：负载假红要重试或降并发，而装置写错必须**修装置**。
   *
   * 修法是把观测面收成一个**本用例私有**的目录：`root` 建在 `outer` 里面，
   * 于是 `path.resolve(root, '..') === outer`，而 `outer` 只有本用例在动
   * ⇒ **断言语义一字未变**（仍然是"root 之外没有任何新条目"），但不再受别的进程干扰。
   */
  let outer: string;

  beforeEach(() => {
    outer = mkdtempSync(path.join(tmpdir(), 'vanblog-stored-name-outer-'));
    root = mkdtempSync(path.join(outer, 'root-'));
  });

  afterEach(() => {
    rmSync(outer, { recursive: true, force: true });
  });

  describe('sanitizeStoredImageName（生产者那层）', () => {
    it('正常名字原样保留（中文名、带点的名字、多段后缀）', () => {
      expect(sanitizeStoredImageName('photo.png')).toBe('photo.png');
      expect(sanitizeStoredImageName('我的图片.png')).toBe('我的图片.png');
      expect(sanitizeStoredImageName('a.b.c.jpeg')).toBe('a.b.c.jpeg');
      expect(sanitizeStoredImageName('  spaced name.webp  ')).toBe('spaced name.webp');
    });

    it.each(HOSTILE)('敌意名字 %j 净化后不含分隔符、不含 ..、不含控制字符与引号', (raw) => {
      const clean = sanitizeStoredImageName(raw);
      expect(clean).toBeTruthy();
      expect(/[\\/]/.test(clean)).toBe(false);
      expect(clean.split('.').includes('..')).toBe(false);
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001f\u007f]/.test(clean)).toBe(false);
      expect(/["']/.test(clean)).toBe(false);
      // ⚠️ 净化后仍然可能是"怪名字"，但它只能是**单段文件名**，写不出目录
      expect(path.basename(clean)).toBe(clean);
    });

    it('以点开头的名字被剥掉前导点（不会被当成隐藏文件/扩展名混淆）', () => {
      expect(sanitizeStoredImageName('.hidden.png')).toBe('hidden.png');
      expect(sanitizeStoredImageName('...png')).toBe('png');
    });

    it('净化后为空时回落到固定名字，绝不返回空串（空串会让 path.join 落到目录本身）', () => {
      expect(sanitizeStoredImageName('')).toBe('attachment');
      expect(sanitizeStoredImageName('///')).toBe('attachment');
      expect(sanitizeStoredImageName('\u0000\u0001')).toBe('attachment');
    });

    it('超长名字被截断但保留后缀（继承附件的 160 字符规则）', () => {
      const long = `${'x'.repeat(400)}.png`;
      const clean = sanitizeStoredImageName(long);
      expect(clean.length).toBeLessThanOrEqual(160);
      expect(clean.endsWith('.png')).toBe(true);
    });

    it('与附件用的是同一套规则（口径不会再各自漂移）', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sanitizeAttachmentName } = require('./attachment');
      for (const raw of ['photo.png', '../../evil.js', 'a/b.png', '中文名.jpeg', '']) {
        expect(sanitizeStoredImageName(raw)).toBe(sanitizeAttachmentName(raw));
      }
    });
  });

  describe('assertSingleFileName / resolveStoredFileAbs（消费者那层）', () => {
    it('合法单段名字通过，并解析到 <root>/<subDir> 里面', () => {
      const abs = resolveStoredFileAbs(root, 'img', 'abc123.photo.png');
      expect(abs).toBe(path.resolve(root, 'img', 'abc123.photo.png'));
      expect(abs.startsWith(path.resolve(root, 'img') + path.sep)).toBe(true);
    });

    it.each(TRAVERSAL)('穿越形状 %j 被明确拒绝（BadRequestException），不是"悄悄写到别处"', (raw) => {
      expect(() => resolveStoredFileAbs(root, 'img', raw)).toThrow(BadRequestException);
    });

    it.each(INERT_SINGLE_SEGMENT)(
      '字面单段怪名字 %j 不被拒，但解析结果证明它仍在 img 目录内',
      (raw) => {
        const abs = resolveStoredFileAbs(root, 'img', raw);
        const imgDir = path.resolve(root, 'img');
        expect(abs.startsWith(imgDir + path.sep)).toBe(true);
        expect(path.dirname(abs)).toBe(imgDir);
        // 而且它不会被这一层解码成别的东西
        expect(path.basename(abs)).toBe(raw);
      },
    );

    it('拒绝时不会创建任何文件，也不会在 root 之外留下东西', () => {
      // 🔴 `outside` 现在是 `beforeEach` 里那个**私有**父目录（见其注释），不再是系统 tmpdir。
      //    断言本身一字未改：仍然是"这段执行期间 root 之外没有新条目"。
      const outside = path.resolve(root, '..');
      // 反空转：观测面必须真的是那个私有目录，否则这条断言会退化成"扫了整个 /tmp"或"扫了 root 自己"
      expect(outside).toBe(outer);
      expect(outside).not.toBe(tmpdir());
      const before = readdirSync(outside).slice().sort();
      // 反空转：观测面必须非空（里面至少有 root 自己），否则"前后相等"可能只是两边都空
      expect(before).toContain(path.basename(root));
      for (const raw of TRAVERSAL) {
        expect(() => resolveStoredFileAbs(root, 'img', raw)).toThrow(BadRequestException);
      }
      // 字面单段名字这一层只做解析、不落盘，所以父目录内容同样不该变
      for (const raw of INERT_SINGLE_SEGMENT) {
        resolveStoredFileAbs(root, 'img', raw);
      }
      expect(readdirSync(outside).slice().sort()).toEqual(before);
    });

    it('NUL 字节被拒（截断攻击的经典形状）', () => {
      expect(() => resolveStoredFileAbs(root, 'img', 'ok.png\u0000.js')).toThrow(BadRequestException);
      expect(() => assertSingleFileName('ok.png\u0000.js')).toThrow(BadRequestException);
    });

    it('空名字被拒（否则 path.resolve 会返回目录本身，writeFileSync 会以 EISDIR 失败在后面）', () => {
      expect(() => resolveStoredFileAbs(root, 'img', '')).toThrow(BadRequestException);
      expect(() => resolveStoredFileAbs(root, 'img', undefined)).toThrow(BadRequestException);
    });

    it('兄弟目录前缀不会被误判成"在里面"（/img-evil 不以 /img 为前缀）', () => {
      // 只比字符串前缀的实现会放过这种形状；path.relative 判据不会
      const abs = path.resolve(root, 'img-evil', 'x.png');
      const rel = path.relative(path.resolve(root, 'img'), abs);
      expect(rel.startsWith('..')).toBe(true);
      expect(() => resolveStoredFileAbs(root, 'img', `../img-evil/x.png`)).toThrow(
        BadRequestException,
      );
    });

    it('真的落盘：用返回的绝对路径写文件，文件出现在 img 目录内，外面一个都没有', () => {
      const imgDir = path.resolve(root, 'img');
      mkdirSync(imgDir, { recursive: true });
      const abs = resolveStoredFileAbs(root, 'img', sanitizeStoredImageName('../../evil.js'));
      writeFileSync(abs, Buffer.from('x'));
      expect(existsSync(abs)).toBe(true);
      expect(abs.startsWith(imgDir + path.sep)).toBe(true);
      // 净化后的名字是单段的，所以 root 下只多了 img 这一个目录
      expect(readdirSync(root).sort()).toEqual(['img']);
      expect(readdirSync(imgDir)).toHaveLength(1);
    });

    it('报错文本不含换行与控制字符（日志注入），且会被截断', () => {
      const long = `../../${'A'.repeat(500)}\nX-Injected: 1.png`;
      let msg = '';
      try {
        resolveStoredFileAbs(root, 'img', long);
      } catch (err) {
        msg = String((err as Error).message || '');
      }
      expect(msg).toContain('非法的图片名');
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001f\u007f]/.test(msg)).toBe(false);
      expect(msg.length).toBeLessThan(200);
    });

    it('describeUnsafeNameForLog 只用于回显：空值也有可读输出', () => {
      expect(describeUnsafeNameForLog('')).toBe('(空)');
      expect(describeUnsafeNameForLog('a\nb')).toBe('a b');
    });
  });

  describe('resolveWithinStorageAbs（名字来自数据库的那种消费点，例如删除）', () => {
    it('允许合法的嵌套相对路径（自定义页面就是 sub/page.html 这种形状）', () => {
      const abs = resolveWithinStorageAbs(root, 'customPage', 'sub/page.html');
      expect(abs).toBe(path.resolve(root, 'customPage', 'sub', 'page.html'));
    });

    it.each([
      '../../evil',
      '../img/x.png',
      'sub/../../evil',
      '/etc/passwd',
      '..\\..\\evil',
      'ok\u0000.png',
      'evil\nname.png',
      '',
    ])('拒绝越界/非法形状 %j', (raw) => {
      expect(() => resolveWithinStorageAbs(root, 'customPage', raw)).toThrow(BadRequestException);
    });

    it('以两个点开头的合法单段名不被误拒（与 resolveStoredFileAbs 同一个坑）', () => {
      const abs = resolveWithinStorageAbs(root, 'img', '..weird-but-legal.png');
      expect(path.dirname(abs)).toBe(path.resolve(root, 'img'));
    });
  });

  describe('源码锚点：两层都真的接上了', () => {
    // ⚠️ 所有"某文本不存在"的断言都跑在 stripCommentsForAnchor 之后：
    //    这两个文件里都写着解释"为什么要有这道校验"的注释，而注释里必然出现旧形状的字符串。
    //    本仓库已经六次踩到"断言匹配到自己的解释性注释"。
    const localSrc = stripCommentsForAnchor(
      readFileSync(path.resolve(__dirname, '../provider/static/local.provider.ts'), 'utf-8'),
    );
    const staticSrc = stripCommentsForAnchor(
      readFileSync(path.resolve(__dirname, '../provider/static/static.provider.ts'), 'utf-8'),
    );

    it('saveImg 落盘前走 resolveStoredFileAbs（消费者那层，且顺序在写入之前）', () => {
      // ⚠️ 必须把范围**限定在 saveImg 函数体内**再比顺序：
      //    `fs.writeFileSync(srcPath, buffer)` 这个字符串在本文件里出现不止一次
      //    （自定义页面那条路也有），直接 indexOf 会取到别的方法里的那个，
      //    于是"先校验后写入"的顺序断言量的是两个不相干的位置（第一版就是这么红的）。
      const start = localSrc.indexOf('async saveImg(');
      expect(start).toBeGreaterThan(-1);
      const body = localSrc.slice(start, start + 1600);
      const atResolve = body.indexOf('resolveStoredFileAbs(config.staticPath, storagePath, fileName)');
      const atWrite = body.indexOf('fs.writeFileSync(srcPath, buffer)');
      expect(atResolve).toBeGreaterThan(-1);
      expect(atWrite).toBeGreaterThan(-1);
      expect(atWrite).toBeGreaterThan(atResolve);
    });

    it('saveImg 不再是裸的 path.join + writeFileSync（反证：旧形状必须消失）', () => {
      expect(localSrc).not.toContain('path.join(config.staticPath, storagePath, fileName)');
      // ⚠️ 这条断言必须能红：把上面那个字符串塞回去就会命中
      expect('const srcPath = path.join(config.staticPath, storagePath, fileName);').toContain(
        'path.join(config.staticPath, storagePath, fileName)',
      );
    });

    it('图片名在拼接前过了 sanitizeStoredImageName（生产者那层）', () => {
      expect(staticSrc).toContain('sanitizeStoredImageName(originalName)');
      expect(staticSrc).toContain("currentSign + '.' + safeImageName");
    });

    it('反证：图片名不再直接用未净化的 originalName 拼（旧形状必须消失）', () => {
      expect(staticSrc).not.toContain("currentSign + '.' + originalName");
      // 断言不是空转：旧形状字符串本身确实包含被禁的片段
      expect("let fileName = currentSign + '.' + originalName;").toContain(
        "currentSign + '.' + originalName",
      );
    });

    it('deleteFile 也接上了容器化校验（名字来自数据库/导入 JSON，删除不可逆）', () => {
      expect(localSrc).toContain('resolveWithinStorageAbs(config.staticPath, storagePath, fileName)');
      // 反证：删除路径不再是裸 join + rmSync
      expect(localSrc).not.toContain(
        'const srcPath = path.join(config.staticPath, storagePath, fileName);',
      );
      expect('const srcPath = path.join(config.staticPath, storagePath, fileName);').toContain(
        'path.join(config.staticPath, storagePath, fileName)',
      );
    });

    it('附件与缩略图既有的那道便宜检查没被顺手删掉', () => {
      expect(localSrc).toContain('非法的附件文件名');
      expect(localSrc).toContain('非法的缩略图文件名');
    });
  });
});
