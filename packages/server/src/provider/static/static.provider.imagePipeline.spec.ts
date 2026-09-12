import { BadRequestException } from '@nestjs/common';
import { StaticProvider } from './static.provider';
import { extractStegoWatermark } from 'src/utils/stegoWatermark';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');

// 真实图片 + sharp 转码，别被默认 5s 卡住
jest.setTimeout(90000);

const STEGO_KEY = 'spec-stego-key';

function chainable(items: any[]) {
  const query: any = {
    sort: () => query,
    limit: () => query,
    skip: () => query,
    exec: async () => items,
    then: (resolve: any, reject: any) => Promise.resolve(items).then(resolve, reject),
  };
  return query;
}

function createModelStub(initial: any[] = []) {
  const docs = initial.map((item) => ({ ...item }));
  const matches = (doc: any, query: any) => {
    if (!query) {
      return true;
    }
    return Object.keys(query).every((key) => doc[key] === query[key]);
  };
  const model: any = function StaticModel(dto: any) {
    Object.assign(this, dto);
    this.save = async () => {
      docs.push(this);
      return this;
    };
  };
  model.findOne = jest.fn((query: any) => ({
    exec: async () => docs.find((doc) => matches(doc, query)) || null,
  }));
  model.find = jest.fn((query: any) => chainable(docs.filter((doc) => matches(doc, query))));
  model.create = jest.fn(async (dto: any) => {
    docs.push(dto);
    return dto;
  });
  model.updateOne = jest.fn((query: any, update: any) => ({
    exec: async () => {
      const doc = docs.find((item) => matches(item, query));
      if (doc && update?.$set) {
        doc.meta = { ...(doc.meta || {}), ...flattenSet(update.$set) };
      }
      return { modifiedCount: doc ? 1 : 0 };
    },
  }));
  model.deleteOne = jest.fn((query: any) => ({
    exec: async () => {
      const idx = docs.findIndex((doc) => matches(doc, query));
      if (idx >= 0) {
        docs.splice(idx, 1);
      }
      return { deletedCount: idx >= 0 ? 1 : 0 };
    },
  }));
  return { model, docs };
}

/** {'meta.thumb': x} -> {thumb: x}，只够测试用 */
function flattenSet(set: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(set)) {
    out[key.includes('.') ? key.split('.').pop() : key] = value;
  }
  return out;
}

interface StubOptions {
  settings?: Record<string, any>;
  docs?: any[];
  files?: Record<string, Buffer>;
}

function createProvider(options: StubOptions = {}) {
  const { model, docs } = createModelStub(options.docs || []);
  const settings = {
    storageType: 'local',
    enableWebp: true,
    compressFormat: 'webp',
    enableWaterMark: false,
    enableResize: true,
    maxImageEdge: 1920,
    enableThumb: true,
    thumbWidth: 300,
    enableStegoWaterMark: true,
    stegoWaterMarkText: null,
    ...(options.settings || {}),
  };
  const settingProvider = {
    getStaticSetting: jest.fn(async () => settings),
    getStegoKey: jest.fn(async () => STEGO_KEY),
  };
  const files = { ...(options.files || {}) };
  const saved: any[] = [];
  const thumbs: any[] = [];
  const deleted: string[] = [];
  const localProvider = {
    saveFile: jest.fn(
      async (fileName: string, buffer: Buffer, type: string, toRoot?: boolean, extra?: any) => {
        saved.push({ fileName, buffer, type, extra });
        files[`/static/${type}/${fileName}`] = buffer;
        return {
          realPath: `/static/${type}/${fileName}`,
          meta: { type: 'webp', width: 100, height: 100, size: '1 KB', ...(extra || {}) },
        };
      },
    ),
    saveThumb: jest.fn(async (baseName: string, buffer: Buffer, ext: string) => {
      const path = `/static/img/thumb/${baseName.replace(/\.[^.]+$/, '')}${ext}`;
      thumbs.push({ baseName, buffer, ext, path });
      files[path] = buffer;
      return path;
    }),
    readStaticFile: jest.fn(async (realPath: string) => {
      if (!files[realPath]) {
        throw new Error(`no such file: ${realPath}`);
      }
      return files[realPath];
    }),
    staticFileExists: jest.fn(async (realPath: string) => Boolean(files[realPath])),
    deleteFile: jest.fn(async (fileName: string) => {
      deleted.push(`/static/img/${fileName}`);
    }),
    deleteStaticFile: jest.fn(async (realPath: string) => {
      deleted.push(realPath);
      delete files[realPath];
    }),
  };
  const picgoProvider = { saveFile: jest.fn() };
  const articleProvider = { getAll: jest.fn(async () => []) };
  const provider = new StaticProvider(
    model,
    settingProvider as any,
    localProvider as any,
    picgoProvider as any,
    articleProvider as any,
  );
  return { provider, model, docs, settingProvider, localProvider, saved, thumbs, deleted, files };
}

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  let seed = 555;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < width * height; i += 1) {
    const base = 70 + Math.floor(rnd() * 110);
    data[i * 3] = base;
    data[i * 3 + 1] = Math.min(255, base + Math.floor(rnd() * 25));
    data[i * 3 + 2] = Math.max(0, base - Math.floor(rnd() * 25));
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

describe('upload image pipeline', () => {
  let photo: Buffer;

  beforeAll(async () => {
    photo = await makeJpeg(900, 700);
  });

  it('resizes, watermarks, compresses and thumbnails in the right order', async () => {
    const ctx = createProvider({
      settings: { maxImageEdge: 500, thumbWidth: 200 },
    });

    const res: any = await ctx.provider.upload(
      { originalname: 'photo.jpg', buffer: photo },
      'img',
      false,
      undefined,
      { withWaterMark: false, waterMarkText: null },
      { uploader: 'tester', baseUrl: 'https://blog.example.com/', author: 'Author' },
    );

    expect(res.isNew).toBe(true);
    expect(res.stego).toBe(true);
    expect(res.src.endsWith('.webp')).toBe(true);

    // 落盘的是压过的 webp，长边被压到 500
    expect(ctx.saved).toHaveLength(1);
    const stored = ctx.saved[0].buffer as Buffer;
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(500);
    expect(meta.height).toBe(389);
    expect(stored.length).toBeLessThan(photo.length);

    // 缩略图按设置生成，并写进 meta
    expect(ctx.localProvider.saveThumb).toHaveBeenCalledTimes(1);
    expect(ctx.thumbs[0].ext).toBe('.webp');
    const thumbMeta = await sharp(ctx.thumbs[0].buffer).metadata();
    expect(thumbMeta.width).toBe(200);
    expect(ctx.saved[0].extra.thumb).toBe(ctx.thumbs[0].path);

    // 隐写水印在压缩之后仍然读得出来，内容是「域名|上传者|时间」
    const detected = await extractStegoWatermark(stored, STEGO_KEY);
    expect(detected.found).toBe(true);
    expect(detected.payload.startsWith('blog.example.com|tester|')).toBe(true);
    expect(detected.payload).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('honours a custom stego payload', async () => {
    const ctx = createProvider({
      settings: { stegoWaterMarkText: '自定义隐写内容', enableResize: false },
    });

    await ctx.provider.upload({ originalname: 'photo.jpg', buffer: photo }, 'img');

    const detected = await extractStegoWatermark(ctx.saved[0].buffer, STEGO_KEY);
    expect(detected.payload).toBe('自定义隐写内容');
  });

  it('keeps the original size when resizing is off', async () => {
    const ctx = createProvider({ settings: { enableResize: false } });

    await ctx.provider.upload({ originalname: 'photo.jpg', buffer: photo }, 'img');

    const meta = await sharp(ctx.saved[0].buffer).metadata();
    expect(meta.width).toBe(900);
    expect(meta.height).toBe(700);
  });

  it('skips the stego watermark when it is disabled', async () => {
    const ctx = createProvider({ settings: { enableStegoWaterMark: false } });

    const res: any = await ctx.provider.upload({ originalname: 'photo.jpg', buffer: photo }, 'img');

    expect(res.stego).toBe(false);
    expect(ctx.settingProvider.getStegoKey).not.toHaveBeenCalled();
    const detected = await extractStegoWatermark(ctx.saved[0].buffer, STEGO_KEY);
    expect(detected.found).toBe(false);
  });

  it('skips the thumbnail when it is disabled', async () => {
    const ctx = createProvider({ settings: { enableThumb: false } });

    await ctx.provider.upload({ originalname: 'photo.jpg', buffer: photo }, 'img');

    expect(ctx.localProvider.saveThumb).not.toHaveBeenCalled();
    expect(ctx.saved[0].extra).toBeUndefined();
  });

  it('does not watermark or thumbnail a favicon', async () => {
    const ctx = createProvider({});

    await ctx.provider.upload({ originalname: 'icon.png', buffer: photo }, 'img', true);

    expect(ctx.localProvider.saveThumb).not.toHaveBeenCalled();
    expect(ctx.saved[0].fileName).toBe('favicon.webp');
  });
});

describe('backfillThumbnails', () => {
  let photo: Buffer;

  beforeAll(async () => {
    photo = await makeJpeg(600, 400);
  });

  it('fills in missing thumbnails only, and skips remote storage', async () => {
    const ctx = createProvider({
      docs: [
        {
          sign: 'a',
          name: 'a.png',
          realPath: '/static/img/a.png',
          staticType: 'img',
          fileType: 'png',
          storageType: 'local',
          meta: {},
        },
        {
          sign: 'b',
          name: 'b.webp',
          realPath: '/static/img/b.webp',
          staticType: 'img',
          fileType: 'webp',
          storageType: 'local',
          meta: { thumb: '/static/img/thumb/b.webp' },
        },
        {
          sign: 'c',
          name: 'c.png',
          realPath: 'https://cdn.example.com/c.png',
          staticType: 'img',
          fileType: 'png',
          storageType: 'picgo',
          meta: {},
        },
      ],
      files: { '/static/img/a.png': photo, '/static/img/thumb/b.webp': photo },
    });

    const res: any = await ctx.provider.backfillThumbnails({});

    expect(res).toMatchObject({ total: 3, generated: 1, existed: 1, skipped: 1, failed: 0 });
    expect(ctx.localProvider.saveThumb).toHaveBeenCalledTimes(1);
    expect(ctx.thumbs[0].baseName).toBe('a.png');
    expect(ctx.docs[0].meta.thumb).toBe('/static/img/thumb/a.webp');
  });

  it('counts unreadable files as failures instead of throwing', async () => {
    const ctx = createProvider({
      docs: [
        {
          sign: 'missing',
          name: 'missing.png',
          realPath: '/static/img/missing.png',
          staticType: 'img',
          fileType: 'png',
          storageType: 'local',
          meta: {},
        },
      ],
      files: {},
    });

    const res: any = await ctx.provider.backfillThumbnails({});

    expect(res).toMatchObject({ total: 1, generated: 0, failed: 1 });
  });
});

describe('detectStegoWatermark', () => {
  it('reads back the mark of a stored image', async () => {
    const ctx = createProvider({ settings: { enableResize: false } });
    const photo = await makeJpeg(800, 600);
    await ctx.provider.upload(
      { originalname: 'photo.jpg', buffer: photo },
      'img',
      false,
      undefined,
      undefined,
      { uploader: 'someone', baseUrl: 'https://x.example.com' },
    );
    const sign = ctx.docs[0].sign;

    const res: any = await ctx.provider.detectStegoWatermark({ sign });

    expect(res.found).toBe(true);
    expect(res.payload.startsWith('x.example.com|someone|')).toBe(true);
    expect(res.realPath).toBe(ctx.docs[0].realPath);
  });

  it('accepts a raw buffer so the admin can check an uploaded file', async () => {
    const ctx = createProvider({});
    const photo = await makeJpeg(700, 500);
    const embedded = await ctx.provider.upload({ originalname: 'p.jpg', buffer: photo }, 'img');

    const res: any = await ctx.provider.detectStegoWatermark({ buffer: ctx.saved[0].buffer });

    expect(res.found).toBe(true);
    expect(embedded.src).toBeTruthy();
  });

  it('reports remote images instead of failing, and 400s on unknown signs', async () => {
    const ctx = createProvider({
      docs: [
        {
          sign: 'remote',
          name: 'r.png',
          realPath: 'https://cdn.example.com/r.png',
          staticType: 'img',
          storageType: 'picgo',
          meta: {},
        },
      ],
    });

    const remote: any = await ctx.provider.detectStegoWatermark({ sign: 'remote' });
    expect(remote).toMatchObject({ found: false, reason: 'not-local' });

    await expect(ctx.provider.detectStegoWatermark({ sign: 'nope' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(ctx.provider.detectStegoWatermark({})).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('deleteOneBySign', () => {
  it('deletes the thumbnail along with the image', async () => {
    const ctx = createProvider({
      docs: [
        {
          sign: 'del',
          name: 'del.webp',
          realPath: '/static/img/del.webp',
          staticType: 'img',
          storageType: 'local',
          meta: { thumb: '/static/img/thumb/del.webp' },
        },
      ],
    });

    await ctx.provider.deleteOneBySign('del');

    expect(ctx.deleted).toEqual(['/static/img/del.webp', '/static/img/thumb/del.webp']);
    expect(ctx.docs).toHaveLength(0);
  });
});
