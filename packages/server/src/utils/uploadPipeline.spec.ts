import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  Controller,
  INestApplication,
  Module,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { diskStorage } from 'multer';
import request from 'supertest';
import { decodeUploadFileName, sanitizeAttachmentName } from './attachment';
import {
  assertUploadedImage,
  CUSTOM_PAGE_UPLOAD_OPTIONS,
  IMAGE_UPLOAD_OPTIONS,
} from './uploadLimits';

/**
 * 上传管线（FileInterceptor + multer）的**真跑**回归测试。
 *
 * 为什么要有这个文件：942 条既有测试里没有一条真的发过 multipart 请求 ——
 * 上传接口全在 AdminGuard 后面，而 Nest 的执行顺序是 **guard 在 interceptor 之前**，
 * 所以匿名请求连 multer 都碰不到（401 就返回了）。也就是说"图片/附件/主题/自定义页面/
 * 整站备份恢复"这五条上传路径在单测里是**完全无覆盖**的，framework 一升级
 * （Nest 9 → 10、multer 1.x → 2.x）就没人能发现它悄悄坏了。
 *
 * 这里用**仓库真实的 multer 配置对象**（`IMAGE_UPLOAD_OPTIONS` / `CUSTOM_PAGE_UPLOAD_OPTIONS`）
 * 起一个最小的 Nest 应用，用 supertest 发真的 multipart 请求，断言：
 *  1. 处理器拿到 `Express.Multer.File`（buffer/size/mimetype/fieldname 都在），
 *     并且 `assertUploadedImage()` 能从字节里认出 png；
 *  2. `fileFilter` 抛的 `BadRequestException` 仍然变成 **400**（`.html` 被拒）；
 *  3. `limits.fileSize` 触发 multer 的 `LIMIT_FILE_SIZE`，仍然被 platform-express 的
 *     `transformException` 映射成 **413**；
 *  4. 不限类型的通用上传（自定义页面 / JSON 导入那条路）照样放行 `.html`；
 *  5. `diskStorage`（整站备份恢复用的那种）照样把文件按回调生成的名字落到磁盘；
 *  6. **中文文件名**（浏览器按 UTF-8 字节发、busboy 默认按 latin1 交上来）经过
 *     `decodeUploadFileName()` 之后仍然是正确的名字 —— multer 2.4.0 实测仍不传
 *     `defParamCharset`（busboy 1.6 默认 nullDecoder = latin1），修复层还在我们这边；
 *  7. **multer 2.4.0 的新行为**：按 WHATWG HTML 规范把文件名里的 `%0A`/`%0D`/`%22`
 *     反转义回真字符（multer 1.x 原样保留）。`sanitizeAttachmentName()` 会把引号剥掉，
 *     落盘名不受影响 —— 这里钉住"反转义真的发生了 + 消毒层接得住"。
 *
 * ⚠️ 还有一条**版本钉子**（最后一个用例）：multer 1.x 已停更且带一串已知 CVE，
 * 2.0.2（platform-express 10.4.22 自己钉的版本）也有 2026 年披露的 8 个 CVE（全部在
 * 2.3.0 修复），所以根 override 把 `multer@2.0.2` 抬到 `^2.4.0`。这个用例断言
 * **树里只有一份 multer/express**（platform-express 解析到的与我们 require 到的是
 * 同一个 realpath），谁把 override 弄丢、让两份副本回来，这里会红。
 */

/** 1x1 的合法 PNG（imageSize 认得出来） */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const DISK_DIR = join(tmpdir(), `vanblog-upload-spec-${process.pid}`);

/**
 * 手工拼 multipart 正文：filename 以 **UTF-8 字节**写进头部，与真实浏览器发的一致。
 * （supertest 的 `.attach` 走 form-data 库，对非 ASCII 文件名的处理与浏览器不同，
 * 所以中文文件名这条必须手拼字节，量的才是生产上真实的 wire format。）
 */
function multipartBody(boundary: string, filenameHeader: string, content: Buffer): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filenameHeader}"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
    'utf8',
  );
  return Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
}

@Controller()
class UploadProbeController {
  @Post('probe/image')
  @UseInterceptors(FileInterceptor('file', IMAGE_UPLOAD_OPTIONS))
  image(@UploadedFile() file: Express.Multer.File) {
    // 处理器里再跑一次真实的内容校验：证明拿到的字节是完整的图片
    const verified = assertUploadedImage(file?.buffer, file?.originalname);
    return {
      fieldname: file?.fieldname,
      originalname: file?.originalname,
      mimetype: file?.mimetype,
      size: file?.size,
      isBuffer: Buffer.isBuffer(file?.buffer),
      bufferEqualsPng: Buffer.isBuffer(file?.buffer) && file.buffer.equals(PNG_1x1),
      verified,
    };
  }

  @Post('probe/generic')
  @UseInterceptors(FileInterceptor('file', CUSTOM_PAGE_UPLOAD_OPTIONS))
  generic(@UploadedFile() file: Express.Multer.File) {
    return { originalname: file?.originalname, size: file?.size };
  }

  @Post('probe/tiny')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 1024 } }))
  tiny(@UploadedFile() file: Express.Multer.File) {
    return { size: file?.size };
  }

  @Post('probe/name')
  @UseInterceptors(FileInterceptor('file', IMAGE_UPLOAD_OPTIONS))
  name(@UploadedFile() file: Express.Multer.File) {
    const raw = String(file?.originalname ?? '');
    return {
      raw,
      decoded: decodeUploadFileName(raw),
      sanitized: sanitizeAttachmentName(raw),
      size: file?.size,
    };
  }

  @Post('probe/disk')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req: any, _file: any, cb: (e: Error | null, dir?: string) => void) => {
          try {
            mkdirSync(DISK_DIR, { recursive: true });
            cb(null, DISK_DIR);
          } catch (err) {
            cb(err as Error);
          }
        },
        filename: (_req: any, file: any, cb: (e: Error | null, name?: string) => void) => {
          const matched = String(file?.originalname || '').match(/\.(tar\.(zst|xz|gz)|tgz)$/i);
          cb(null, `restore-upload-spec${matched ? matched[0] : '.bin'}`);
        },
      }),
    }),
  )
  disk(@UploadedFile() file: any) {
    return {
      originalname: file?.originalname,
      filename: file?.filename,
      path: file?.path,
      size: file?.size,
    };
  }
}

@Module({ controllers: [UploadProbeController] })
class UploadProbeModule {}

describe('上传管线（FileInterceptor + multer，真发 multipart 请求）', () => {
  jest.setTimeout(60000);
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [UploadProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    rmSync(DISK_DIR, { recursive: true, force: true });
  });

  it('真的 PNG 走 IMAGE_UPLOAD_OPTIONS：处理器拿到完整字节，内容校验认出 png', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/image')
      .attach('file', PNG_1x1, { filename: 'pixel.png', contentType: 'image/png' })
      .expect(201);
    expect(res.body.fieldname).toBe('file');
    expect(res.body.originalname).toBe('pixel.png');
    expect(res.body.mimetype).toBe('image/png');
    expect(res.body.size).toBe(PNG_1x1.length);
    expect(res.body.isBuffer).toBe(true);
    expect(res.body.bufferEqualsPng).toBe(true);
    expect(res.body.verified).toEqual({ type: 'png', width: 1, height: 1 });
  });

  it('fileFilter 仍然拦下 .html（400 + 原文案），不会把可执行内容当图片存下来', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/image')
      .attach('file', Buffer.from('<script>alert(1)</script>'), {
        filename: 'evil.html',
        contentType: 'text/html',
      })
      .expect(400);
    expect(String(res.body.message)).toMatch(/图床只接受图片文件/);
  });

  it('limits.fileSize 仍然映射成 413（multer LIMIT_FILE_SIZE → PayloadTooLargeException）', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/tiny')
      .attach('file', Buffer.alloc(4096, 0x61), { filename: 'big.bin', contentType: 'application/octet-stream' })
      .expect(413);
    expect(res.body.statusCode).toBe(413);
    expect(String(res.body.message)).toMatch(/File too large|LIMIT_FILE_SIZE/i);
  });

  it('通用上传（自定义页面/JSON 导入那条路）不限类型：.html 照样放行', async () => {
    const html = Buffer.from('<html><body>hi</body></html>');
    const res = await request(app.getHttpServer())
      .post('/probe/generic')
      .attach('file', html, { filename: 'page.html', contentType: 'text/html' })
      .expect(201);
    expect(res.body.originalname).toBe('page.html');
    expect(res.body.size).toBe(html.length);
  });

  it('diskStorage 仍然按 filename 回调落盘（整站备份恢复用的那条路）', async () => {
    const payload = Buffer.from('fake-archive-bytes');
    const res = await request(app.getHttpServer())
      .post('/probe/disk')
      .attach('file', payload, { filename: 'backup.tar.zst', contentType: 'application/octet-stream' })
      .expect(201);
    expect(res.body.originalname).toBe('backup.tar.zst');
    expect(res.body.filename).toBe('restore-upload-spec.tar.zst');
    expect(res.body.size).toBe(payload.length);
    expect(existsSync(res.body.path)).toBe(true);
    expect(readFileSync(res.body.path).equals(payload)).toBe(true);
  });

  it('中文文件名：UTF-8 字节过 busboy/multer 2 之后仍被 decodeUploadFileName 修复', async () => {
    const boundary = '----specCJKBoundary';
    const res = await request(app.getHttpServer())
      .post('/probe/name')
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(multipartBody(boundary, '测试.png', PNG_1x1))
      .expect(201);
    // 契约是「解码后的名字正确」，不钉中间层：multer 2.4.0 实测仍不给 busboy 传
    // defParamCharset（默认 latin1 ⇒ raw 是 mojibake，由我们的修复函数还原）；
    // 就算未来 multer 改成 utf8 直解，这条仍然应该绿。
    expect(res.body.decoded).toBe('测试.png');
    expect(res.body.size).toBe(PNG_1x1.length);
  });

  it('multer 2.4.0 按 WHATWG 反转义文件名里的 %22：消毒层把引号剥掉', async () => {
    const boundary = '----specEscapeBoundary';
    const res = await request(app.getHttpServer())
      .post('/probe/name')
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(multipartBody(boundary, 'evil%22.png', PNG_1x1))
      .expect(201);
    // multer 1.x 会原样保留 `evil%22.png`；2.4.0 的 decodeFormDataName 把
    // %0A/%0D/%22 反转义成真字符 ⇒ raw 里出现引号。这是 multer 2 的**真实行为变化**，
    // 钉住它 + 钉住 sanitizeAttachmentName 接得住（图片落盘名是 md5+白名单后缀，本来就不受影响）。
    expect(res.body.raw).toBe('evil".png');
    expect(res.body.sanitized).toBe('evil.png');
  });

  it('版本钉子：platform-express 10.x + express 4.x + multer 2.x，且树里只有一份 express/multer', () => {
    // 读**已安装**的 package.json，不是声明的范围
    const platformExpress = require('@nestjs/platform-express/package.json');
    const express = require('express/package.json');
    const multer = require('multer/package.json');
    const common = require('@nestjs/common/package.json');
    expect(String(platformExpress.version)).toMatch(/^10\./);
    expect(String(common.version)).toMatch(/^10\./);
    // Express 5 会换 path-to-regexp v8，app.module.ts 里 4 处 `forRoutes({ path: '*' })` 会失配
    expect(String(express.version)).toMatch(/^4\./);
    // multer 1.x 停更且带已知 CVE；platform-express 10.4.22 自己钉的 2.0.2 也有
    // 2026-03..09 披露的 8 个 CVE（全部在 2.3.0 修复），根 override `multer@2.0.2 → ^2.4.0`
    // 把 platform-express 与 server 两边收敛到同一份 2.4.0。退回 1.x 或 2.0.2 都要先重跑上面几条。
    expect(String(multer.version)).toMatch(/^2\./);
    // multer 2 自己不带类型（types/typings 为空，实测装上的 2.4.0），类型来自 @types/multer 2.x
    expect(multer.types ?? multer.typings).toBeUndefined();
    const typesMulter = require('@types/multer/package.json');
    expect(String(typesMulter.version)).toMatch(/^2\./);

    // **单副本断言**：platform-express 上下文解析到的 express/multer 必须与我们这里
    // require 到的是同一份（realpath 相同）。根 override（`express@4.22.1 → ^4.22.1`、
    // `multer@2.0.2 → ^2.4.0`）是唯一保证 —— override 一丢，platform-express 钉死的
    // 4.22.1/2.0.2 会和 server 的新解析分裂成两份副本，这条会立刻红。
    const platformDir = dirname(require.resolve('@nestjs/platform-express/package.json'));
    const fromPlatform = (mod: string) =>
      realpathSync(require.resolve(mod, { paths: [platformDir] }));
    expect(fromPlatform('express/package.json')).toBe(
      realpathSync(require.resolve('express/package.json')),
    );
    expect(fromPlatform('multer/package.json')).toBe(
      realpathSync(require.resolve('multer/package.json')),
    );
    // 声明版本仍是 Nest 发布时钉的那些（证明上面的单副本靠 override 收敛，而不是读错了包）
    expect(String(platformExpress.dependencies.express)).toMatch(/^4\./);
    expect(String(platformExpress.dependencies.multer)).toMatch(/^2\./);
  });
});
