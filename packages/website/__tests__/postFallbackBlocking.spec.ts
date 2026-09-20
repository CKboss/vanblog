import { readFileSync } from "fs";
import { resolve } from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/post/[id]` 的 `fallback: "blocking"` 必须留着，以及它周边的几条不变量。
 *
 * ## 为什么值得一个 spec
 *
 * "随机不存在的 slug 会触发按需 SSR，是最便宜的放大攻击 ⇒ 改成 `fallback: false`"
 * 是一个**看起来很有道理、实际会造成可用性回归**的改动，而且它会被当成性能优化提出来，
 * 审查的人很难当场反驳。所以把反驳的证据钉在这里：
 *
 * 1. `getStaticPaths` 只列**规范地址**（有别名用别名、否则用数字 id），而 server 侧
 *    `utils/articlePublicPaths.ts` 把 `/post/<数字id>` 与 `/post/<别名>` **两条**都当公开地址
 *    去 revalidate。⇒ 有别名的文章，它的数字 id 地址不在构建清单里，只有 blocking 能按需生成
 *    那条 301。改成 false，老链接 / 收藏夹 / 搜索引擎收录的数字 id 地址全变硬 404。
 * 2. blocking 是**自愈**路径：容器重建后 ISR 缓存是冷的、或某次 revalidate 触发丢了，
 *    访客的一次请求就能把页面重新生成出来。
 * 3. 而假 slug 的真实成本远小于直觉：`getPublicMeta()` 有 5 秒进程内缓存 + 并发合并；
 *    文章查询是 `article.pathname` 上的**索引精确匹配**，非数字 id 被 `tryParseNumericId`
 *    提前短路；server 查不到时**立刻抛 404**，相关文章 / 前后篇 / 加密分类名单都不跑。
 *
 * 真正该拦这个放大的是边缘层（caddy 对未命中的 `/post/*` 做短 TTL 负缓存或限流），
 * 不是拿真实文章的可达性去换。
 *
 * ## ⚠️ 关于 mock 的写法（本仓库踩过的坑，别再踩）
 *
 * vitest 是 **0.29**（没有 `vi.hoisted()`），而**静态的 `vi.mock("../相对路径", …)` 对源模块
 * 不生效** —— 实测：mock 之后 import 到的仍是真函数。本 spec 的第一版就是这么写的，
 * 结果页面直接去打了本机在跑的 server、拿回 53 篇真文章，四条断言全红
 * （**这次是红而不是假绿**，纯属运气：如果断言写的是 `not.toHaveBeenCalled()` 那一类，
 * mock 静默失效就会让它假绿）。
 * 可用写法是 `vi.doMock` + 动态 `import()`（`pageParamShape.spec.ts` 里有同一份说明），
 * 并且必须配一条**接线对照**证明 spy 就是页面在用的那个函数。
 */

const websiteRoot = resolve(__dirname, "..");
// ⚠️ __dirname 是 packages/website/__tests__ ⇒ 仓库根要往上**两**级（写一级会指到 packages/）
const repoRoot = resolve(websiteRoot, "..", "..");
const read = (p: string) => readFileSync(p, "utf8");

/**
 * 剥掉注释再做"不存在"类断言。
 *
 * ⚠️ 必须剥：本页 `fallback` 那段注释里就写着 `fallback: false` 这些字样，
 * 直接对原文断言 `not.toMatch` 会**永远红**；反过来为了变绿把断言写松，就又成了空断言。
 * 本仓库已经因为这个形状踩过 8 次。
 *
 * ⚠️ 不能复用 server 的 `stripCommentsForAnchor`（那是 TS 路径别名，website 的 vitest 解析不到），
 * 这里手工做：先去块注释，再逐行去掉整行注释。
 */
const noComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

describe("/post/[id] 的 ISR 契约（行为级，取数层被 mock）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getArticlesByOptionSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getPostPagesPropsSpy: any;
  let getStaticPaths: () => Promise<{ paths: { params: { id: string } }[]; fallback: string }>;
  let getStaticProps: (ctx: { params: { id?: unknown } }) => Promise<{
    props?: unknown;
    notFound?: boolean;
    redirect?: { destination: string; permanent: boolean };
    revalidate?: number;
  }>;

  beforeAll(async () => {
    getArticlesByOptionSpy = vi.fn();
    getPostPagesPropsSpy = vi.fn();

    // 组件与 next/head 都换成空壳：它们与本页的数据契约无关，
    // 真加载会把 KaTeX / bytemd / 主题全拖进来（慢且脆）。
    vi.doMock("../components/Layout", () => ({ default: () => null }));
    vi.doMock("../components/PostCard", () => ({ default: () => null }));
    vi.doMock("../components/Toc", () => ({ default: () => null }));
    vi.doMock("../pages/404", () => ({ default: () => null }));
    vi.doMock("next/head", () => ({
      default: ({ children }: { children?: unknown }) => children ?? null,
    }));
    // revalidate 是个数字（按需模式 24 小时 / 延时模式带下限）；这里只关心"它被带上了"
    vi.doMock("../utils/loadConfig", () => ({ revalidate: { revalidate: 60 } }));
    vi.doMock("../api/getArticles", () => ({
      getArticlesByOption: (...args: unknown[]) => getArticlesByOptionSpy(...args),
    }));
    vi.doMock("../utils/getPageProps", () => ({
      getPostPagesProps: (...args: unknown[]) => getPostPagesPropsSpy(...args),
    }));

    const page = await import("../pages/post/[id]");
    getStaticPaths = page.getStaticPaths as unknown as typeof getStaticPaths;
    getStaticProps = page.getStaticProps as unknown as typeof getStaticProps;
  });

  beforeEach(() => {
    getArticlesByOptionSpy.mockReset();
    getPostPagesPropsSpy.mockReset();
  });

  it("接线对照：这两个 spy 就是页面在用的那两个函数（否则下面全是假绿）", async () => {
    getArticlesByOptionSpy.mockResolvedValue({ articles: [{ id: 1, pathname: "a" }] });
    await getStaticPaths();
    expect(getArticlesByOptionSpy).toHaveBeenCalledTimes(1);

    getPostPagesPropsSpy.mockResolvedValue({ article: null });
    await getStaticProps({ params: { id: "a" } });
    expect(getPostPagesPropsSpy).toHaveBeenCalledTimes(1);
    expect(getPostPagesPropsSpy).toHaveBeenCalledWith("a");
  });

  it("getStaticPaths 列出**全部**文章的规范地址，并且 fallback 是 blocking", async () => {
    getArticlesByOptionSpy.mockResolvedValue({
      articles: [
        { id: 1, pathname: "hello-world" },
        { id: 2, pathname: "" }, // 没有别名 ⇒ 规范地址就是数字 id
        { id: 3, pathname: "Qt自定义控件与提升法(prompted)" }, // 真实数据里就有中文+括号的别名
      ],
    });

    const result = await getStaticPaths();

    expect(result.fallback).toBe("blocking");
    expect(result.paths.map((p) => p.params.id)).toEqual([
      "hello-world",
      "2",
      "Qt自定义控件与提升法(prompted)",
    ]);
    // 必须是"全部"，不能分页：漏掉的文章在冷缓存下就只能靠 blocking 现生成
    expect(getArticlesByOptionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: -1 }),
    );
  });

  it("⚠️ 有别名的文章，它的**数字 id 地址不在构建清单里** —— 这就是 false 会弄坏老链接的原因", async () => {
    getArticlesByOptionSpy.mockResolvedValue({ articles: [{ id: 7, pathname: "some-alias" }] });

    const ids = (await getStaticPaths()).paths.map((p) => p.params.id);

    expect(ids).toEqual(["some-alias"]);
    expect(ids).not.toContain("7");
    // 而 server 侧把两条都当公开地址（见下面那条跨包断言）⇒ 这个差集只能靠 blocking 覆盖
  });

  it("查不到文章时返回 notFound（真 404），并且**带上 revalidate** 以便走 ISR 负缓存", async () => {
    getPostPagesPropsSpy.mockResolvedValue({ article: null });

    const result = await getStaticProps({ params: { id: "random-bogus-slug" } });

    expect(result.notFound).toBe(true);
    // 不能返回 props：那会变成"渲染 404 页面但状态码 200"的软 404，既骗搜索引擎，
    // 也会在后端抖动时把 ISR 缓存里的好页面换成软 404
    expect(result.props).toBeUndefined();
    // ⚠️ 必须带 revalidate：同一个假 slug 被反复打时靠 ISR 负缓存兜住，
    //    否则每个请求都要重新走一遍 SSR
    expect(typeof result.revalidate).toBe("number");
    expect(result.revalidate).toBeGreaterThan(0);
  });

  it("数字 id 地址访问有别名的文章 ⇒ 永久重定向到规范地址（中文别名要过 encodeLocationPath）", async () => {
    getPostPagesPropsSpy.mockResolvedValue({
      article: { id: 7, pathname: "Qt自定义控件与提升法(prompted)", title: "t", content: "" },
    });

    const result = await getStaticProps({ params: { id: "7" } });

    expect(result.notFound).toBeUndefined();
    expect(result.redirect).toBeDefined();
    expect(result.redirect?.permanent).toBe(true);
    // 中文别名必须被编码：Location 头里出现非 Latin-1 字符会让 Node 的 setHeader 抛
    // "Cannot convert argument to a ByteString"，这篇文章直接 500
    expect(result.redirect?.destination).toBe(
      `/post/${encodeURIComponent("Qt自定义控件与提升法(prompted)")}`,
    );
    expect(typeof result.revalidate).toBe("number");
  });

  it("规范地址访问 ⇒ 正常返回 props，不重定向、不 notFound", async () => {
    const props = { article: { id: 7, pathname: "some-alias", title: "t", content: "" } };
    getPostPagesPropsSpy.mockResolvedValue(props);

    const result = await getStaticProps({ params: { id: "some-alias" } });

    expect(result.props).toBe(props);
    expect(result.redirect).toBeUndefined();
    expect(result.notFound).toBeUndefined();
  });
});

describe("源码钉子：fallback 不许被改成 false，且跨包的地址口径差集仍然存在", () => {
  const pageSrc = noComments(read(resolve(websiteRoot, "pages/post/[id].tsx")));

  it("剥掉注释后，`fallback: \"blocking\"` 还在，`fallback: false` 不在", () => {
    expect(pageSrc).toMatch(/fallback:\s*["']blocking["']/);
    expect(pageSrc).not.toMatch(/fallback:\s*false/);
    // ⚠️ 空转反证：尺子必须能量到旧形状，否则上面那条 not.toMatch 永远为真
    expect(noComments("return { paths, fallback: false };")).toMatch(/fallback:\s*false/);
    // 而"只在注释里提到 false"不该被算成代码（这正是必须先剥注释的原因）
    expect(noComments('// fallback: false\nreturn { paths, fallback: "blocking" };')).not.toMatch(
      /fallback:\s*false/,
    );
  });

  it("跨包不变量：server 把 id 与别名**两条**都当公开地址，而构建清单只有规范地址", () => {
    const serverPaths = noComments(
      read(resolve(repoRoot, "packages/server/src/utils/articlePublicPaths.ts")),
    );
    // server 侧：数字 id 那条永远在，别名那条在"有别名且不等于 id"时追加
    expect(serverPaths).toContain("const paths = [`/post/${article.id}`];");
    expect(serverPaths).toContain("paths.push(`/post/${pathname}`)");

    // website 侧：构建清单只映射 getArticlePath（规范地址）
    expect(pageSrc).toContain("getArticlePath(article)");

    // 而 getArticlePath 本身就是"有别名用别名、否则用 id"⇒ 差集 = 有别名文章的数字 id 地址
    const getArticlePathSrc = noComments(read(resolve(websiteRoot, "utils/getArticlePath.ts")));
    expect(getArticlePathSrc).toMatch(/pathname\s*\?\s*pathname\s*:\s*id/);

    // ⚠️ 这个差集正是 blocking 必须存在的理由之一。哪天有人把两条都加进 getStaticPaths，
    //    这条断言会红 —— 那时才可以重新评估 fallback（并且要连"自愈"那条理由一起评估）。
    expect(pageSrc).not.toContain("/post/${article.id}");
  });
});
