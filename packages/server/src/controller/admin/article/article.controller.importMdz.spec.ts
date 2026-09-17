import compressing from 'compressing';
import { BadRequestException } from '@nestjs/common';
import { ArticleController } from './article.controller';

/** 1x1 真 PNG：StaticProvider.upload 的魔数校验只认真图片字节 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function buildZip(entries: Array<{ relativePath: string; source: Buffer }>): Promise<Buffer> {
  const stream = new compressing.zip.Stream();
  for (const entry of entries) {
    stream.addEntry(entry.source as any, { relativePath: entry.relativePath });
  }
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return Buffer.concat(chunks);
}

function createStack() {
  const uploads: any[] = [];
  const staticProvider: any = {
    upload: jest.fn(async (file: any, type: string, isFavicon: any, customPathname: any, updateConfig: any, context: any) => {
      uploads.push({ originalname: file?.originalname, type, updateConfig, context, bytes: file?.buffer?.length });
      return { src: `/static/img/served-${uploads.length}.webp`, isNew: uploads.length === 1 };
    }),
  };
  const metaProvider: any = {
    getSiteInfo: jest.fn(async () => ({ baseUrl: 'https://blog.example.com/', author: '作者' })),
  };
  const controller = new ArticleController(
    {} as any,
    { activeAll: jest.fn() } as any,
    { dispatchEvent: jest.fn() } as any,
    staticProvider,
    metaProvider,
  );
  return { controller, staticProvider, metaProvider, uploads };
}

const md = (body: string) =>
  Buffer.from(`---\ntitle: 导入我\ntags: [x, y]\ncategory: 技术\npassword: scrypt$aa$bb\nprivate: true\n---\n\n${body}\n`, 'utf8');

describe('POST /api/admin/article/import-mdz（ArticleController.importMdz）', () => {
  it('把 assets 交给 StaticProvider.upload（img 类型、默认不加可见水印、带隐写上下文），链接改写成服务 URL', async () => {
    const { controller, uploads } = createStack();
    const zip = await buildZip([
      { relativePath: '导入我.md', source: md('![a](导入我.assets/pic-1.png)') },
      { relativePath: '导入我.assets/pic-1.png', source: PNG },
    ]);
    const res = await controller.importMdz(
      { buffer: zip, originalname: '导入我.mdz' } as any,
      { user: { nickname: '管理员' } } as any,
    );
    expect(res.statusCode).toBe(200);
    expect(uploads.length).toBe(1);
    expect(uploads[0]).toMatchObject({
      originalname: 'pic-1.png', // 只传成员 basename，不带目录
      type: 'img',
      updateConfig: { withWaterMark: false },
    });
    expect(uploads[0].context).toEqual(
      expect.objectContaining({ uploader: '管理员', baseUrl: 'https://blog.example.com/', author: '作者' }),
    );
    const data = res.data;
    expect(data.title).toBe('导入我');
    expect(data.content).toContain('/static/img/served-1.webp');
    expect(data.content).not.toContain('导入我.assets');
    expect(data.frontMatter).toEqual(
      expect.objectContaining({ title: '导入我', tags: ['x', 'y'], category: '技术', private: true }),
    );
    expect(data.frontMatter.password).toBeUndefined();
    expect(data.passwordDropped).toBe(true);
    expect(data.importedImages).toBe(1);
    expect(data.dedupedImages).toBe(0);
    expect(JSON.stringify(res)).not.toContain('scrypt$aa$bb');
  });

  it('withWaterMark=true 文本字段透传给 upload（想补盖可见水印的调用方可以自己选）', async () => {
    const { controller, uploads } = createStack();
    const zip = await buildZip([
      { relativePath: 't.md', source: md('![a](t.assets/p.png)') },
      { relativePath: 't.assets/p.png', source: PNG },
    ]);
    await controller.importMdz({ buffer: zip } as any, { user: {} } as any, { withWaterMark: 'true' });
    expect(uploads[0].updateConfig).toEqual({ withWaterMark: true });
  });

  it('没有文件 / 空文件：400 且文案具体；upload 一次都不会被调用', async () => {
    const { controller, staticProvider } = createStack();
    await expect(controller.importMdz(undefined as any, {} as any)).rejects.toBeInstanceOf(BadRequestException);
    // 控制器在入口就把空 buffer 拦下（readMdzEntries 里还有一道同样的检查）
    await expect(
      controller.importMdz({ buffer: Buffer.alloc(0) } as any, {} as any),
    ).rejects.toThrow('没有收到文件');
    expect(staticProvider.upload).not.toHaveBeenCalled();
  });

  it('图床拒收（upload 抛 400）不会炸掉整个导入：进 skippedImages', async () => {
    const { controller } = createStack();
    (controller as any).staticProvider.upload = jest.fn(async () => {
      throw new BadRequestException('图床不接受 SVG（可内嵌脚本），请作为附件上传');
    });
    const zip = await buildZip([
      { relativePath: 't.md', source: md('![a](t.assets/x.svg)') },
      { relativePath: 't.assets/x.svg', source: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') },
    ]);
    const res = await controller.importMdz({ buffer: zip } as any, { user: {} } as any);
    expect(res.data.importedImages).toBe(0);
    expect(res.data.skippedImages[0].reason).toContain('SVG');
    expect(res.data.content).toContain('t.assets/x.svg'); // 链接原样保留
  });
});
