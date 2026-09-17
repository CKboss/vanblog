import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import compressing from 'compressing';
import { MarkdownExportProvider } from './markdownExport.provider';
import { ExportController } from '../../controller/admin/export/export.controller';

jest.setTimeout(120000);

// 与既有 markdownExport.provider.spec.ts 同样的隔离方式：不碰网络、不做真 DNS
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('dns', () => ({
  lookup: (_host: string, _opts: any, cb: any) =>
    typeof _opts === 'function'
      ? cb(null, [{ address: '93.184.216.34', family: 4 }])
      : cb(null, [{ address: '93.184.216.34', family: 4 }]),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios').default;

function makeProvider(opts: { staticRoot: string; article?: any; draft?: any; baseUrl?: string }) {
  const articleProvider: any = { getById: jest.fn(async () => opts.article) };
  const draftProvider: any = { getById: jest.fn(async () => opts.draft) };
  const localProvider: any = {
    resolveStaticAbs: (realPath: string) =>
      path.join(opts.staticRoot, realPath.slice('/static/'.length)),
  };
  const metaProvider: any = {
    getSiteInfo: async () => ({ baseUrl: opts.baseUrl ?? 'https://blog.example.com/' }),
  };
  return new MarkdownExportProvider(articleProvider, draftProvider, localProvider, metaProvider);
}

async function unzipNames(file: string): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-read-'));
  await compressing.zip.uncompress(file, dir);
  const names: string[] = [];
  const walk = (cur: string, prefix = '') => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(cur, e.name), rel);
      else names.push(rel);
    }
  };
  walk(dir);
  return names;
}

describe('导出格式（md / mdz / zip）', () => {
  let staticRoot: string;
  const withImage = {
    id: 7,
    title: '格式测试',
    content: '正文\n\n![图](/static/img/a.webp)\n\n![外链](https://cdn.example.com/x.png)\n',
    createdAt: new Date('2026-01-02T03:04:05Z'),
  };
  const noImage = { id: 8, title: '没有图', content: '纯文字，没有任何图片引用。\n', createdAt: new Date() };

  beforeEach(() => {
    staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-static-'));
    fs.mkdirSync(path.join(staticRoot, 'img'), { recursive: true });
    fs.writeFileSync(path.join(staticRoot, 'img', 'a.webp'), Buffer.from('image-a'));
    jest.clearAllMocks();
  });

  // 1x1 的真 PNG：fetchRemote 会校验"内容真的是图片"，随便一段字节会被判失败
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  afterEach(() => {
    fs.rmSync(staticRoot, { recursive: true, force: true });
  });

  it("format='md'：只产一份原样 md，图片链接仍指向站点，不打外层 zip", async () => {
    const p = makeProvider({ staticRoot, article: withImage });
    const built = await p.build({ id: 7, type: 'article', format: 'md' });
    expect(built.mdPath).toBeTruthy();
    expect(built.zipPath).toBeUndefined();
    expect(built.mdzPath).toBeUndefined();
    expect(built.fileName).toBe('格式测试.md');
    const md = fs.readFileSync(built.mdPath as string, 'utf8');
    expect(md).toContain('/static/img/a.webp'); // 链接没被改成相对路径
    expect(md).toContain('https://cdn.example.com/x.png');
    expect(built.report.assetsPacked).toBe(false);
    expect(built.report.packedImages).toBe(0);
    expect(built.report.imageRefs).toBe(2); // 仍然统计，好让前端解释"这个格式不含图片"
    fs.rmSync(built.tmpDir, { recursive: true, force: true });
  });

  it("format='md' 时**完全不抓外链图片**（少一次网络请求就少一分 SSRF 面）", async () => {
    // 反证很重要：如果哪天有人把 format==='md' 的跳过条件去掉，这条会红
    axios.get.mockResolvedValue({ data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), headers: { 'content-type': 'image/png' } });
    const p = makeProvider({ staticRoot, article: withImage });
    const built = await p.build({ id: 7, type: 'article', format: 'md' });
    expect(axios.get).not.toHaveBeenCalled();
    expect(built.report.remoteImages).toBe(0);
    expect(built.report.failed.length).toBe(0); // 没抓 ⇒ 也谈不上失败
    fs.rmSync(built.tmpDir, { recursive: true, force: true });
  });

  it("format='mdz'：产出 Typora 风格图片包（相对路径 md + .assets 目录）", async () => {
    axios.get.mockResolvedValue({ data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), headers: { 'content-type': 'image/png' } });
    const p = makeProvider({ staticRoot, article: withImage });
    const built = await p.build({ id: 7, type: 'article', format: 'mdz' });
    expect(built.mdzPath).toBeTruthy();
    expect(built.fileName).toBe('格式测试.mdz');
    expect(built.zipPath).toBeUndefined(); // 不该为用不到的外层 zip 付打包成本
    expect(built.report.assetsPacked).toBe(true);
    expect(built.report.packedImages).toBe(2); // 本地图 + 外链图
    const names = await unzipNames(built.mdzPath as string);
    expect(names).toContain('格式测试.md');
    expect(names.filter((n) => n.startsWith('格式测试.assets/')).length).toBe(2);
    fs.rmSync(built.tmpDir, { recursive: true, force: true });
  });

  it("format='mdz' 但正文没有图片：mdzPath 为空（由控制器回 400，不静默改发 md）", async () => {
    const p = makeProvider({ staticRoot, article: noImage });
    const built = await p.build({ id: 8, type: 'article', format: 'mdz' });
    expect(built.mdzPath).toBeUndefined();
    expect(built.report.hasMdz).toBe(false);
    fs.rmSync(built.tmpDir, { recursive: true, force: true });
  });

  it("不传 format（与 format='zip'）保持今天的行为：外层 zip 里同时有 md 与 mdz", async () => {
    axios.get.mockResolvedValue({ data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), headers: { 'content-type': 'image/png' } });
    const p = makeProvider({ staticRoot, article: withImage });
    const a = await p.build({ id: 7, type: 'article' });
    expect(a.fileName).toBe('格式测试-markdown.zip');
    expect(a.zipPath).toBeTruthy();
    const namesA = await unzipNames(a.zipPath as string);
    expect(namesA).toContain('格式测试.md');
    expect(namesA).toContain('格式测试.mdz');
    fs.rmSync(a.tmpDir, { recursive: true, force: true });

    const b = await p.build({ id: 7, type: 'article', format: 'zip' });
    expect((await unzipNames(b.zipPath as string)).sort()).toEqual(namesA.sort());
    fs.rmSync(b.tmpDir, { recursive: true, force: true });
  });
});

describe('导出控制器的格式分支', () => {
  function fakeRes() {
    const res: any = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: undefined as any,
      downloaded: [] as { file: string; name: string }[],
      setHeader(k: string, v: string) {
        this.headers[k.toLowerCase()] = v;
      },
      status(n: number) {
        this.statusCode = n;
        return this;
      },
      json(payload: any) {
        this.body = payload;
        return this;
      },
      download(file: string, name: string, cb?: (err?: Error) => void) {
        this.downloaded.push({ file, name });
        if (cb) cb();
      },
    };
    return res;
  }
  function makeController(buildResult: any) {
    const provider: any = { build: jest.fn(async () => buildResult) };
    return { controller: new ExportController(provider), provider };
  }

  it('未知格式 → 400，并且不会去 build（静默回落到 zip 比报错难查得多）', async () => {
    const { controller, provider } = makeController({});
    const res = fakeRes();
    await controller.exportMarkdown({ id: 1, format: 'pdf' } as any, res);
    expect(res.statusCode).toBe(400);
    expect(String(res.body.message)).toContain('不支持的导出格式');
    expect(provider.build).not.toHaveBeenCalled();
  });

  it("format='md' → 用 text/markdown 发那份 md，发完删临时目录", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-ctl-'));
    const mdPath = path.join(tmpDir, 'x.md');
    fs.writeFileSync(mdPath, '# hi');
    const { controller } = makeController({
      mdPath,
      tmpDir,
      fileName: 'x.md',
      report: { title: 'x', type: 'article', imageRefs: 0, packedImages: 0, localImages: 0, remoteImages: 0, skipped: [], failed: [], hasMdz: false, assetsPacked: false, entries: ['x.md'] },
    });
    const res = fakeRes();
    await controller.exportMarkdown({ id: 1, format: 'md' } as any, res);
    expect(res.downloaded).toEqual([{ file: mdPath, name: 'x.md' }]);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['x-export-report']).toBeTruthy();
    expect(decodeURIComponent(res.headers['x-export-report'])).toContain('"assetsPacked":false');
    expect(fs.existsSync(tmpDir)).toBe(false); // 临时目录已删
  });

  it("format='mdz' 但没有图片 → 400 说清原因，并删掉临时目录", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-ctl2-'));
    const { controller } = makeController({
      mdzPath: undefined,
      tmpDir,
      fileName: 'x.mdz',
      report: { title: 'x', type: 'article', imageRefs: 0, packedImages: 0, localImages: 0, remoteImages: 0, skipped: [], failed: [], hasMdz: false, assetsPacked: true, entries: [] },
    });
    const res = fakeRes();
    await controller.exportMarkdown({ id: 1, format: 'mdz' } as any, res);
    expect(res.statusCode).toBe(400);
    expect(String(res.body.message)).toContain('没有可打包的图片');
    expect(res.downloaded.length).toBe(0); // 绝不静默改发别的文件
    expect(fs.existsSync(tmpDir)).toBe(false);
  });

  it("不传 format → 仍发外层 zip（向后兼容，老前端不受影响）", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-ctl3-'));
    const zipPath = path.join(tmpDir, 'x-markdown.zip');
    fs.writeFileSync(zipPath, 'zip-bytes');
    const { controller, provider } = makeController({
      zipPath,
      tmpDir,
      fileName: 'x-markdown.zip',
      report: { title: 'x', type: 'article', imageRefs: 0, packedImages: 0, localImages: 0, remoteImages: 0, skipped: [], failed: [], hasMdz: false, assetsPacked: true, entries: ['x.md'] },
    });
    const res = fakeRes();
    await controller.exportMarkdown({ id: 1 } as any, res);
    expect(res.downloaded).toEqual([{ file: zipPath, name: 'x-markdown.zip' }]);
    expect(provider.build).toHaveBeenCalledWith(expect.objectContaining({ format: 'zip' }));
    expect(fs.existsSync(tmpDir)).toBe(false);
  });
});
