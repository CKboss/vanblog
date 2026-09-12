import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import compressing from 'compressing';
import { MarkdownExportProvider } from './markdownExport.provider';

jest.setTimeout(120000);

// axios 只在抓外链图片时用到，这里全部 mock，测试不依赖网络
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
// SSRF 检查会做真实 DNS 解析；离线环境里测试用的假域名解析不了，
// 所以把 dns.lookup 固定成一个公网地址（字面量内网地址仍会被前面的检查挡住）。
jest.mock('dns', () => ({
  lookup: (_host: string, _opts: any, cb: any) =>
    typeof _opts === 'function'
      ? _opts(null, [{ address: '93.184.216.34', family: 4 }])
      : cb(null, [{ address: '93.184.216.34', family: 4 }]),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios').default;

function makeProvider(opts: {
  staticRoot: string;
  article?: any;
  draft?: any;
  baseUrl?: string;
}) {
  const articleProvider: any = {
    getById: jest.fn(async () => opts.article),
  };
  const draftProvider: any = {
    getById: jest.fn(async () => opts.draft),
  };
  const localProvider: any = {
    resolveStaticAbs: (realPath: string) => {
      const rel = realPath.slice('/static/'.length);
      return path.join(opts.staticRoot, rel);
    },
  };
  const metaProvider: any = {
    getSiteInfo: async () => ({ baseUrl: opts.baseUrl ?? 'https://blog.example.com/' }),
  };
  return new MarkdownExportProvider(
    articleProvider,
    draftProvider,
    localProvider,
    metaProvider,
  );
}

async function readZip(zipPath: string): Promise<{ names: string[]; read: (n: string) => string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdz-read-'));
  await compressing.zip.uncompress(zipPath, dir);
  const names: string[] = [];
  const walk = (current: string, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), rel);
      } else {
        names.push(rel);
      }
    }
  };
  walk(dir);
  return {
    names,
    read: (n: string) => fs.readFileSync(path.join(dir, n), 'utf8'),
  };
}

describe('MarkdownExportProvider', () => {
  let staticRoot: string;

  beforeEach(() => {
    staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-export-static-'));
    fs.mkdirSync(path.join(staticRoot, 'img'), { recursive: true });
    fs.writeFileSync(path.join(staticRoot, 'img', 'a.webp'), Buffer.from('image-a'));
    fs.writeFileSync(path.join(staticRoot, 'img', 'b.webp'), Buffer.from('image-b'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(staticRoot, { recursive: true, force: true });
  });

  it('有图片时同时给出 .md（原样）和 .mdz（带图）', async () => {
    const provider = makeProvider({
      staticRoot,
      article: {
        id: 7,
        title: '我的文章 (一)',
        pathname: 'my-post',
        category: '博客',
        tags: ['x'],
        content: '# 标题\n\n![图A](/static/img/a.webp)\n\n正文。\n',
      },
    });

    const built = await provider.build({ id: 7, type: 'article' });
    expect(fs.existsSync(built.zipPath)).toBe(true);
    expect(built.fileName).toBe('我的文章-一-markdown.zip');
    expect(built.report.packedImages).toBe(1);
    expect(built.report.hasMdz).toBe(true);

    const outer = await readZip(built.zipPath);
    expect(outer.names.sort()).toEqual(['我的文章-一.md', '我的文章-一.mdz']);
    // 原样 md：链接不动
    expect(outer.read('我的文章-一.md')).toContain('![图A](/static/img/a.webp)');
    // 标题带空格 -> YAML 里加引号（后台导入用的 front-matter 能正常解析）
    expect(outer.read('我的文章-一.md')).toContain("title: '我的文章 (一)'");
    expect(outer.read('我的文章-一.md')).toContain('pathname: my-post');

    // .mdz 本身是个 zip：里面是改写过的 md + <标题>.assets/
    const mdzPath = path.join(path.dirname(built.zipPath), 'inner.mdz');
    await extractEntry(built.zipPath, '我的文章-一.mdz', mdzPath);
    const inner = await readZip(mdzPath);
    expect(inner.names.sort()).toEqual(['我的文章-一.assets/a.webp', '我的文章-一.md']);
    expect(inner.read('我的文章-一.md')).toContain('![图A](我的文章-一.assets/a.webp)');
    expect(inner.read('我的文章-一.md')).not.toContain('/static/img/a.webp');

    fs.rmSync(path.dirname(built.zipPath), { recursive: true, force: true });
  });

  it('没有图片时只给 .md，不生成 .mdz', async () => {
    const provider = makeProvider({
      staticRoot,
      article: { id: 8, title: '纯文字', content: '# 标题\n\n没有图片。\n' },
    });
    const built = await provider.build({ id: 8 });
    const outer = await readZip(built.zipPath);
    expect(outer.names).toEqual(['纯文字.md']);
    expect(built.report.hasMdz).toBe(false);
    expect(built.report.imageRefs).toBe(0);
    fs.rmSync(path.dirname(built.zipPath), { recursive: true, force: true });
  });

  it('外链图片抓得到就打包，抓不到就保留原链接并写进导出说明', async () => {
    axios.get
      .mockResolvedValueOnce({ data: Buffer.from('remote-bytes') })
      .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));

    const provider = makeProvider({
      staticRoot,
      article: {
        id: 9,
        title: '外链测试',
        content:
          '![好外链](https://cdn.other.com/pic/ok.png)\n\n![坏外链](https://broken.invalid/x.png)\n',
      },
    });
    const built = await provider.build({ id: 9 });
    expect(built.report.remoteImages).toBe(1);
    expect(built.report.failed).toHaveLength(1);
    expect(built.report.failed[0].url).toBe('https://broken.invalid/x.png');

    const outer = await readZip(built.zipPath);
    expect(outer.names).toContain('导出说明.md');
    const note = outer.read('导出说明.md');
    expect(note).toContain('broken.invalid');
    expect(note).toContain('.mdz');

    const mdzPath = path.join(path.dirname(built.zipPath), 'inner.mdz');
    await extractEntry(built.zipPath, '外链测试.mdz', mdzPath);
    const inner = await readZip(mdzPath);
    expect(inner.names.some((n) => n.endsWith('.assets/ok.png'))).toBe(true);
    // 失败的那张保留原链接
    expect(inner.read('外链测试.md')).toContain('![坏外链](https://broken.invalid/x.png)');
    expect(inner.read('外链测试.md')).toContain('![好外链](外链测试.assets/ok.png)');
    fs.rmSync(path.dirname(built.zipPath), { recursive: true, force: true });
  });

  it('raw 模式：不查库，直接用给的 title/content（编辑器未保存内容 / 关于页）', async () => {
    const provider = makeProvider({ staticRoot });
    const built = await provider.build({
      type: 'raw',
      title: '关于我',
      content: '![图](/static/img/b.webp)\n',
    });
    expect(provider['articleProvider'].getById).not.toHaveBeenCalled();
    const outer = await readZip(built.zipPath);
    expect(outer.names).toContain('关于我.md');
    expect(outer.names).toContain('关于我.mdz');
    expect(built.report.type).toBe('raw');
    fs.rmSync(path.dirname(built.zipPath), { recursive: true, force: true });
  });

  it('编辑器带未保存内容时，导出的是给过来的内容', async () => {
    const provider = makeProvider({
      staticRoot,
      article: { id: 10, title: '旧标题', content: '![旧](/static/img/a.webp)' },
    });
    const built = await provider.build({
      id: 10,
      type: 'article',
      title: '新标题',
      content: '![新](/static/img/b.webp)',
    });
    const outer = await readZip(built.zipPath);
    expect(outer.names).toContain('新标题.md');
    expect(outer.read('新标题.md')).toContain('![新](/static/img/b.webp)');
    fs.rmSync(path.dirname(built.zipPath), { recursive: true, force: true });
  });

  it('草稿走 draftProvider', async () => {
    const provider = makeProvider({
      staticRoot,
      draft: { id: 3, title: '草稿一篇', content: '![图](/static/img/a.webp)' },
    });
    const built = await provider.build({ id: 3, type: 'draft' });
    expect(provider['draftProvider'].getById).toHaveBeenCalledWith(3);
    expect(built.report.type).toBe('draft');
    fs.rmSync(path.dirname(built.zipPath), { recursive: true, force: true });
  });

  it('磁盘上不存在的图片记为失败，不会让整个导出崩掉', async () => {
    const provider = makeProvider({
      staticRoot,
      article: {
        id: 11,
        title: '丢图',
        content: '![在](/static/img/a.webp)\n\n![不在](/static/img/gone.webp)\n',
      },
    });
    const built = await provider.build({ id: 11 });
    expect(built.report.packedImages).toBe(1);
    expect(built.report.failed).toHaveLength(1);
    expect(built.report.failed[0].reason).toContain('不在磁盘上');
    const outer = await readZip(built.zipPath);
    expect(outer.read('导出说明.md')).toContain('gone.webp');
    fs.rmSync(path.dirname(built.zipPath), { recursive: true, force: true });
  });

  it('内网地址不会被抓取（SSRF 防护）', async () => {
    const provider = makeProvider({
      staticRoot,
      article: { id: 12, title: 'SSRF', content: '![内网](http://127.0.0.1:3000/meta)\n' },
    });
    const built = await provider.build({ id: 12 });
    expect(axios.get).not.toHaveBeenCalled();
    expect(built.report.failed[0].reason).toContain('内网');
    fs.rmSync(path.dirname(built.zipPath), { recursive: true, force: true });
  });

  it('文章不存在时给出可读错误', async () => {
    const provider = makeProvider({ staticRoot, article: undefined });
    await expect(provider.build({ id: 999 })).rejects.toThrow('文章不存在');
  });
});

async function extractEntry(zipPath: string, entry: string, dest: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdz-entry-'));
  await compressing.zip.uncompress(zipPath, dir);
  fs.copyFileSync(path.join(dir, entry), dest);
  fs.rmSync(dir, { recursive: true, force: true });
}
