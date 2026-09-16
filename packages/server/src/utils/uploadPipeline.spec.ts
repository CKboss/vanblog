import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
 *  5. `diskStorage`（整站备份恢复用的那种）照样把文件按回调生成的名字落到磁盘。
 *
 * ⚠️ 还有一条**版本钉子**（最后一个用例）：`@nestjs/platform-express` 被**故意钉在 10.4.17**，
 * 因为 10.4.18+ 把依赖换成了 multer 2.x、10.4.22 还把 express 抬到 4.22.1（见 AGENTS 的
 * 依赖升级记录）。谁要往上抬 platform-express，这个用例会红，逼他把上面 5 条重跑一遍。
 */

/** 1x1 的合法 PNG（imageSize 认得出来） */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const DISK_DIR = join(tmpdir(), `vanblog-upload-spec-${process.pid}`);

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

  it('版本钉子：platform-express 10.x + express 4.x + multer 1.x（要抬版本就先把上面几条重跑一遍）', () => {
    // 读**已安装**的 package.json，不是声明的范围
    const platformExpress = require('@nestjs/platform-express/package.json');
    const express = require('express/package.json');
    const multer = require('multer/package.json');
    const common = require('@nestjs/common/package.json');
    expect(String(platformExpress.version)).toMatch(/^10\./);
    expect(String(common.version)).toMatch(/^10\./);
    // Express 5 会换 path-to-regexp v8，app.module.ts 里 4 处 `forRoutes({ path: '*' })` 会失配
    expect(String(express.version)).toMatch(/^4\./);
    // platform-express 10.4.18+ 依赖 multer 2.x；钉住 1 .x 就是钉住 10.4.17
    expect(String(multer.version)).toMatch(/^1\./);
    expect(String(platformExpress.dependencies.express)).toBe(express.version);
    expect(String(platformExpress.dependencies.multer)).toBe(multer.version);
  });
});
