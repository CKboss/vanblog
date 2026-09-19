import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from 'src/config';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { RssProvider } from './rss.provider';

/**
 * RSS 三份产物的**写盘方式**。
 *
 * ## 为什么要有这个 spec
 *
 * `/rss/feed.xml`、`/rss/atom.xml`、`/rss/feed.json` 是**匿名可直接下载**的静态文件
 * （caddy 直发，不经 Node）。以前是 `fs.promises.writeFile` 原地覆盖 —— 而 writeFile 是
 * "先截断再写"，所以正在拉取的订阅器有概率读到**半截 XML/JSON**。对阅读器来说解析失败
 * 比读到旧内容糟得多：多数阅读器会把源标成错误并退避重试，站长看到的是"订阅源坏了"，
 * 而日志里一切正常。
 *
 * 修法是 `sitemap.provider.ts` 早就在用的那套：**pid 后缀的临时文件 + 同目录 rename**
 * （同一文件系统内 rename 是原子的）。tmp 名带 pid 是因为 cluster 下两个 worker 可能
 * 同时生成（主实例的整点 cron + 某个 worker 处理了文章保存），共用一个 tmp 名会互相截断。
 *
 * ## 这个 spec 还钉住一个**决定**：不给 RSS 加主实例守卫
 *
 * 审查建议过"加 `isPrimaryInstance` 守卫，免得 N 个 worker 重复生成"。查完调用链后
 * **故意没加**，理由必须是可验证的事实而不是记忆：
 *  - RSS/sitemap 只由 ISR storm 触发（`provider/isr/isr.provider.ts` 调 generateRssFeed）；
 *  - 会"乘以核数"的两个**批量**触发点已经在上游被主实例守卫挡住了：启动首轮全量渲染在
 *    `main.ts` 的 `if (primary)` 里，整点 cron 在 `schedule/isr.task.ts` 的
 *    `isPrimaryInstance(cluster)` 里；
 *  - 剩下的触发是**事件驱动**的：哪个 worker 处理了文章保存，就由那个 worker 生成一次。
 *    在生成函数里再加一道主实例守卫 ⇒ 非主实例 worker 上的保存**不会**刷新 RSS，
 *    订阅源要等主实例下一个整点（最长 1 小时）—— 用"省一次重复写"换"订阅源变陈旧"，
 *    方向是错的。并发写的正确性由原子 rename 负责。
 * 下面最后两条断言把这个决定钉住：如果哪天有人在 rss.provider 里加了主实例守卫，
 * 或者把上游那两道守卫拆了，测试会红并逼他重新想一遍这个取舍。
 */

const fakeArticle = {
  id: 7,
  title: '测试文章',
  pathname: 'ce-shi-wen-zhang',
  content: '# 标题\n\n正文内容',
  category: '技术',
  tags: ['a', 'b'],
  private: false,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
};

function buildProvider() {
  const articleProvider = { getAll: jest.fn(async () => [fakeArticle]) };
  const metaProvider = {
    getAll: jest.fn(async () => ({
      siteInfo: {
        author: 'tester',
        baseUrl: 'https://blog.example.com/',
        siteName: '测试站',
        siteDesc: '描述',
        favicon: '',
        siteLogo: '',
        authorLogo: '',
      },
    })),
  };
  const settingProvider = { getWalineSetting: jest.fn(async () => ({})) };
  const markdownProvider = {
    renderMarkdown: (s: string) => `<p>${s}</p>`,
    getDescription: (s: string) => String(s).slice(0, 200),
  };
  const categoryProvider = { getAllCategories: jest.fn(async () => []) };
  return new RssProvider(
    articleProvider as any,
    metaProvider as any,
    settingProvider as any,
    markdownProvider as any,
    categoryProvider as any,
  );
}

const readSource = () =>
  stripCommentsForAnchor(fs.readFileSync(path.join(__dirname, 'rss.provider.ts'), 'utf-8'));

describe('RSS 订阅源写盘：原子 rename，读者永远看不到半截文件', () => {
  let tmp: string;
  let prevStatic: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-rss-'));
    prevStatic = config.staticPath;
    config.staticPath = tmp;
  });
  afterEach(() => {
    config.staticPath = prevStatic;
    fs.rmSync(tmp, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const rssDir = () => path.join(tmp, 'rss');

  it('生成后三份产物都存在、内容完整可解析', async () => {
    await buildProvider().generateRssFeedFn('测试');
    const json = fs.readFileSync(path.join(rssDir(), 'feed.json'), 'utf-8');
    const xml = fs.readFileSync(path.join(rssDir(), 'feed.xml'), 'utf-8');
    const atom = fs.readFileSync(path.join(rssDir(), 'atom.xml'), 'utf-8');
    expect(() => JSON.parse(json)).not.toThrow(); // 半截 JSON 会在这里炸
    expect(JSON.parse(json).items).toHaveLength(1);
    expect(xml).toContain('<rss');
    expect(xml).toContain('</rss>'); // 闭合标签在 ⇒ 没被截断
    expect(atom).toContain('<feed');
    expect(atom).toContain('</feed>');
  });

  it('生成完不留任何 .tmp-<pid> 残留文件（静态目录是匿名可读的）', async () => {
    await buildProvider().generateRssFeedFn('测试');
    const leftovers = fs.readdirSync(rssDir()).filter((n) => n.includes('.tmp-'));
    expect(leftovers).toEqual([]);
    expect(fs.readdirSync(rssDir()).sort()).toEqual(['atom.xml', 'feed.json', 'feed.xml']);
  });

  it('rename 失败时删掉半成品 tmp，且不留下最终文件（不能让读者拿到半截产物）', async () => {
    const rename = jest.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('EXDEV'));
    // 失败必须被 provider 自己兜住（它是从 setTimeout 里"发出去就不管"地调的）
    await expect(buildProvider().generateRssFeedFn('测试')).resolves.toBeUndefined();
    expect(rename).toHaveBeenCalled();
    const names = fs.existsSync(rssDir()) ? fs.readdirSync(rssDir()) : [];
    expect(names.filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(names).not.toContain('feed.xml');
    expect(names).not.toContain('feed.json');
    expect(names).not.toContain('atom.xml');
  });

  it('源码级：写的是 pid 后缀 tmp，再 rename 到最终名（不是"出现了 rename 这个符号"）', () => {
    const src = readSource();
    // ⚠️ 断言**调用形状**而不是符号存在：只写 `expect(src).toContain('rename')` 的话，
    //    一条 import 或一句注释就能让它通过 —— 本仓库已经吃过这个亏。
    expect(src).toMatch(/const tmpPath = path\.join\(rssPath, `\$\{name\}\.tmp-\$\{process\.pid\}`\)/);
    expect(src).toMatch(/await fs\.promises\.writeFile\(tmpPath, body\)/);
    expect(src).toMatch(/await fs\.promises\.rename\(tmpPath, path\.join\(rssPath, name\)\)/);
    expect(src).toMatch(/await fs\.promises\.rm\(tmpPath, \{ force: true \}\)/);
  });

  it('反证：不许再有"直接写最终路径"的旧形状', () => {
    const src = readSource();
    // 旧代码是 fs.promises.writeFile(path.join(rssPath, 'feed.json'), feed.json1()) 这三行
    expect(src).not.toMatch(/writeFile\(\s*path\.join\(rssPath,\s*'/);
    expect(src).not.toMatch(/writeFile\(\s*path\.join\(rssPath,\s*name/);
    // 三份产物都必须经过同一条 tmp+rename 路径（用表驱动，而不是三条并列的 writeFile）
    expect(src).toMatch(/'feed\.json', feed\.json1\(\)/);
    expect(src).toMatch(/'feed\.xml', feed\.rss2\(\)/);
    expect(src).toMatch(/'atom\.xml', feed\.atom1\(\)/);
  });

  it('空转反证：上面两条"不存在"的正则确实能命中旧写法', () => {
    const oldShape = `
      await Promise.all([
        fs.promises.writeFile(path.join(rssPath, 'feed.json'), feed.json1()),
        fs.promises.writeFile(path.join(rssPath, 'feed.xml'), feed.rss2()),
      ]);`;
    expect(oldShape).toMatch(/writeFile\(\s*path\.join\(rssPath,\s*'/);
    const oldSingle = `await fs.promises.writeFile(path.join(rssPath, name), body);`;
    expect(oldSingle).toMatch(/writeFile\(\s*path\.join\(rssPath,\s*name/);
  });

  it('决定钉子：rss.provider 里没有主实例守卫（加了就会让订阅源最长陈旧 1 小时）', () => {
    const src = readSource();
    expect(src).not.toMatch(/isPrimaryInstance\s*\(/);
    expect(src).not.toMatch(/from 'src\/utils\/clusterRole'/);
  });

  it('决定钉子的前提仍然成立：两个批量触发点确实在上游被主实例守卫挡着', () => {
    // 如果这两道守卫哪天被拆了，"不加守卫"的理由就不成立了 —— 那时应该重新评估，
    // 而不是让 RSS 在每个 worker 上重复生成整批 350KB 文件。
    const main = stripCommentsForAnchor(
      fs.readFileSync(path.join(__dirname, '../../main.ts'), 'utf-8'),
    );
    const isrTask = stripCommentsForAnchor(
      fs.readFileSync(path.join(__dirname, '../../schedule/isr.task.ts'), 'utf-8'),
    );
    expect(main).toMatch(/if \(primary\) \{[\s\S]{0,200}activeAll\(/);
    expect(isrTask).toMatch(/if \(!isPrimaryInstance\(cluster\)\) \{[\s\S]{0,40}return;/);
  });

  it('决定钉子的空转反证：上面两条正则换个形状就不会命中', () => {
    expect('const x = 1;').not.toMatch(/if \(primary\) \{[\s\S]{0,200}activeAll\(/);
    expect('isPrimaryInstance(cluster)').not.toMatch(
      /if \(!isPrimaryInstance\(cluster\)\) \{[\s\S]{0,40}return;/,
    );
  });
});
