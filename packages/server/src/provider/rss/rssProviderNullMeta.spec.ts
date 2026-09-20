/**
 * `metas` 集合为空时，RSS 生成必须**大声失败并且一个字节都不写**。
 *
 * 🔴 为什么这条要紧：`/rss/*` 与 `/sitemap.xml` 现在**在降级驻留期由 caddy 直发磁盘产物**，
 * 也就是说 feed 是站点被打瘫时少数还能对外发布的通道之一。如果 meta 为空时这里
 * 生成并写出一份**空 feed**，就会把磁盘上**上一份好的** feed 覆盖掉 ⇒ 降级期读者拿到空订阅源，
 * 而且要等数据库恢复后的下一次 ISR 风暴才会重新生成。保留旧文件的代价只是"内容陈旧"。
 *
 * ⚠️ **既有替身有盲区，所以这个 spec 走端到端**：`rss.provider.spec.ts` 的
 * `metaProvider.getAll` 是 `jest.fn(async () => ({ siteInfo: {...} }))`，**恒返回对象、永远不可能是 null**
 * ⇒ "meta 为空"这条路径在既有测试里**完全不可见**（与 Mongoose `{}` 替身、`fakeReq` 恒带
 * `socket.remoteAddress`、`public.controller.spec` 把 `getTotalWords` 打桩成 100 同族 —— 本仓库第五次）。
 * 所以这里除了造"真的返回 null"的替身，还配了一条**替身自检**证明它真的返回了 null。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RssProvider } from './rss.provider';
import { config } from 'src/config';

const SITE_INFO = {
  author: 'tester',
  baseUrl: 'https://blog.example.com/',
  siteName: '测试站',
  siteDesc: '描述',
  favicon: '',
  siteLogo: '',
  authorLogo: '',
};

const fakeArticle = {
  id: 7,
  title: '测试文章',
  pathname: 'ce-shi-wen-zhang',
  content: '# 标题\n\n正文',
  category: '技术',
  tags: ['a'],
  private: false,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
};

/** 造一个 provider；`metaValue` 就是 `getAll()` 的返回值（可以是 null）。 */
function build(metaValue: unknown, overrides: Record<string, unknown> = {}) {
  const errors: string[] = [];
  const getAll = jest.fn(async () => metaValue);
  const provider = new RssProvider(
    { getAll: jest.fn(async () => [fakeArticle]) } as any,
    { getAll } as any,
    { getWalineSetting: jest.fn(async () => ({})) } as any,
    {
      renderMarkdown: (s: string) => `<p>${s}</p>`,
      getDescription: (s: string) => String(s).slice(0, 200),
      ...(overrides as object),
    } as any,
    { getAllCategories: jest.fn(async () => []) } as any,
  );
  // Logger 是类属性，new 出来就有；这里换成收集器以便断言文案
  (provider as any).logger = {
    log: () => undefined,
    warn: () => undefined,
    error: (m: unknown) => errors.push(typeof m === 'string' ? m : JSON.stringify(m)),
  };
  return { provider, errors, getAll };
}

/** 列出目录下所有文件（递归），用来断言"一个字节都没写"。 */
function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

describe('RSS：meta/siteInfo 缺失时大声失败且不覆盖磁盘上的旧 feed', () => {
  let tmp: string;
  let prevStatic: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-rss-null-'));
    prevStatic = config.staticPath;
    (config as any).staticPath = tmp;
  });
  afterEach(() => {
    (config as any).staticPath = prevStatic;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('⚠️ 替身自检：getAll 真的 resolve 成 null（否则下面所有断言都是空转）', async () => {
    const { getAll } = build(null);
    await expect(getAll()).resolves.toBeNull();
  });

  it('meta 为 null ⇒ 不抛到外面、**不写任何文件**、并打出可照做的 ERROR', async () => {
    // 先放一份"上一份好的 feed"在磁盘上，用来证明它没有被覆盖
    const rssDir = path.join(tmp, 'rss');
    fs.mkdirSync(rssDir, { recursive: true });
    const before = '<rss>上一份好的 feed</rss>';
    fs.writeFileSync(path.join(rssDir, 'feed.xml'), before, 'utf-8');

    const { provider, errors } = build(null);
    await (provider as any).generateRssFeedFn('测试');

    // 🔴 本体断言：磁盘上仍然只有那一份旧文件，内容逐字节未变
    const files = listFiles(tmp);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(rssDir, 'feed.xml'), 'utf-8')).toBe(before);

    // 大声失败：文案要点名原因、说明"没写文件"、给出下一步
    const joined = errors.join('\n');
    expect(joined).toContain('meta/siteInfo 文档不存在');
    expect(joined).toContain('没有写任何 feed 文件');
    expect(joined).toContain('doctor');
    expect(joined).toContain('restore --offline-full');
  });

  it('meta 存在但 siteInfo 缺失 ⇒ 同样不写文件（不能只判 meta 一层）', async () => {
    const { provider, errors } = build({ siteInfo: undefined });
    await (provider as any).generateRssFeedFn('测试');
    expect(listFiles(tmp)).toHaveLength(0);
    expect(errors.join('\n')).toContain('meta/siteInfo 文档不存在');
  });

  it('🔴 正对照（尺子有效性）：meta 正常时**确实会写出三份 feed** ⇒ 上面的"0 个文件"不是恒真', async () => {
    const { provider } = build({ siteInfo: SITE_INFO });
    await (provider as any).generateRssFeedFn('测试');
    const files = listFiles(tmp).map((f) => path.basename(f));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const name of ['feed.xml', 'atom.xml', 'feed.json']) {
      expect(files).toContain(name);
    }
  });

  it('catch 不再把 Error 序列化成 {}：真实错误信息必须进日志', async () => {
    // 这条钉的是同一个函数里的另一处缺陷：以前 catch 用 JSON.stringify(err)，
    // 而 Error 的 message/stack 不可枚举 ⇒ 日志里只剩 "生成订阅源失败！" + "{}"，
    // meta 为空导致的 TypeError 就是这样变成哑谜的。
    const marker = 'MARKER-渲染炸了-9527';
    const { provider, errors } = build({ siteInfo: SITE_INFO }, {
      renderMarkdown: () => {
        throw new Error(marker);
      },
    });
    await (provider as any).generateRssFeedFn('测试');
    const joined = errors.join('\n');
    expect(joined).toContain(marker);
    expect(joined).not.toContain('{}');
  });

  it('源码级：catch 里不再出现 JSON.stringify(err)（剥注释后判定）', () => {
    // ⚠️ 必须剥注释：本文件与 rss.provider.ts 的注释里都提到了 JSON.stringify，
    //    不剥就会假红/假绿（本仓库已踩 10 次"断言匹配到解释性注释"）。
    const src = fs.readFileSync(path.join(__dirname, 'rss.provider.ts'), 'utf-8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/JSON\.stringify\(err/);
    // 反证：原文（未剥注释）里确实出现过这个词组，证明剥注释这一步不是空操作
    expect(src).toMatch(/JSON\.stringify\(err/);
  });
});
