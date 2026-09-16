import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STATIC_IMG_PREFIX,
  STATIC_THUMB_PREFIX,
  toThumbPath,
  withThumbnailImages,
} from "../utils/excerptThumbs";
import { fullSizeOfThumb } from "../components/Markdown/img";

// 这一组测试盯的是「首页到底下载了多少字节」。
// 实测过的问题：列表摘要里嵌的是**原图**（一张 3.5MB、一张 1.08MB），
// 而同一张图的 300px 缩略图只有 8KB / 14KB，还被卡片右侧的 ListThumb 另外请求了一次。
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

describe("toThumbPath", () => {
  it("图床根目录下的文件换成缩略图", () => {
    expect(toThumbPath("/static/img/abc.webp")).toBe("/static/img/thumb/abc.webp");
  });
  it("已经是缩略图的不重复加", () => {
    expect(toThumbPath("/static/img/thumb/abc.webp")).toBe("/static/img/thumb/abc.webp");
  });
  it("外链、别的目录、带查询串的都不动", () => {
    expect(toThumbPath("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(toThumbPath("/static/file/a.pdf")).toBe("/static/file/a.pdf");
    expect(toThumbPath("/static/img/sub/a.png")).toBe("/static/img/sub/a.png");
    expect(toThumbPath("/static/img/a.png?v=1")).toBe("/static/img/a.png?v=1");
    expect(toThumbPath("")).toBe("");
  });
});

describe("withThumbnailImages", () => {
  it("markdown 图片语法会被改写", () => {
    expect(withThumbnailImages("![a](/static/img/x.webp)")).toBe("![a](/static/img/thumb/x.webp)");
  });
  it("带 title 的 markdown 图片保留 title", () => {
    expect(withThumbnailImages('![a](/static/img/x.webp "标题")')).toBe(
      '![a](/static/img/thumb/x.webp "标题")'
    );
  });
  it("内联 HTML 的 <img src> 也会被改写", () => {
    expect(withThumbnailImages('<img src="/static/img/x.webp" alt="a">')).toBe(
      '<img src="/static/img/thumb/x.webp" alt="a">'
    );
  });
  it("外链图片与非图床路径不动", () => {
    const md = "![a](https://x.com/a.png) 再看 ![b](/static/file/c.png)";
    expect(withThumbnailImages(md)).toBe(md);
  });
  it("一段文字里多张图都会被改写，其余内容原样保留", () => {
    const md = "开头 ![](/static/img/a.webp) 中间 <img src='/static/img/b.webp'> 结尾";
    expect(withThumbnailImages(md)).toBe(
      "开头 ![](/static/img/thumb/a.webp) 中间 <img src='/static/img/thumb/b.webp'> 结尾"
    );
  });
  it("没有图床前缀时直接原样返回（不做任何正则工作）", () => {
    const md = "纯文字摘要，没有图片";
    expect(withThumbnailImages(md)).toBe(md);
  });
});

describe("fullSizeOfThumb（放大时要看原图）", () => {
  it("缩略图地址能还原成原图地址", () => {
    expect(fullSizeOfThumb("/static/img/thumb/x.webp")).toBe("/static/img/x.webp");
  });
  it("不是缩略图就返回 null", () => {
    expect(fullSizeOfThumb("/static/img/x.webp")).toBeNull();
    expect(fullSizeOfThumb("https://x.com/a.png")).toBeNull();
    expect(fullSizeOfThumb("/static/img/thumb/sub/x.webp")).toBeNull();
  });
});

describe("接线", () => {
  it("列表摘要走缩略图，文章页正文不走", () => {
    const card = strip(read("components/PostCard/index.tsx"));
    // 摘要优先用 server 下发的 excerpt（withExcerpt 的列表响应里没有 content，
    // 首页因此不再把 25KB 全文塞进 __NEXT_DATA__）；老缓存页回退本地计算
    expect(card).toContain(
      "withThumbnailImages(props.excerpt ?? articleOverviewMarkdown(content))"
    );
    // 文章页那条分支（type != overview）必须保持原样：读者点开文章就是要看大图
    expect(card).toContain('content.replace("<!-- more -->", "")');
  });

  it("markdown 图片插件给缩略图补 data-zoom-src，并在加载失败时回退原图", () => {
    const img = strip(read("components/Markdown/img.tsx"));
    expect(img).toContain("fullSizeOfThumb");
    expect(img).toContain("dataZoomSrc");
    // data-* 必须在 rehype 插件里加：sanitize 跑在插件之前，写在 markdown 里会被删掉
    expect(img).toContain('addEventListener(');
    expect(img).toMatch(/"error"/);
  });

  it("封面图有 aspect-ratio，不再是 LCP 元素上的布局位移", () => {
    const css = read("styles/globals.css");
    // 不带 /s（dotAll）标志：website 项目 target 是 es5，TS 5 对 /s 报 TS1501；
    // 而这条正则里根本没有裸 `.`（只有转义的 \. 和字符类 [^}]），/s 从来就是空操作，
    // 去掉后匹配行为逐字节不变。
    expect(css).toMatch(/\.article-cover img \{[^}]*aspect-ratio/);
    // 组件本身没有 width/height，所以必须靠 CSS 占位
    expect(read("components/ArticleCover/index.tsx")).toContain('className="block w-full max-h-80 object-cover"');
  });

  it("pageProps 的体积上限不再是 10MB（那会把唯一的告警机制关掉）", () => {
    const cfg = strip(read("next.config.js"));
    expect(cfg).toMatch(/largePageDataBytes:\s*256 \* 1024/);
    expect(cfg).not.toMatch(/largePageDataBytes:\s*1024 \* 1024 \* 10/);
  });

  it("认不出格式的 GA 测量 ID 不再注入（以前会为不存在的媒体资源下载 242KB）", async () => {
    const { shouldInjectGa, describeGaInjection } = await import(
      "../components/gaAnalysis/load"
    );
    expect(shouldInjectGa("G-ABC123")).toBe(true);
    expect(shouldInjectGa("UA-123456-1")).toBe(true);
    // 别家统计的 id 填进了 GA 字段：认不出来就什么都不注入
    expect(shouldInjectGa("KlnHeyZ1H6Lus393")).toBe(false);
    expect(shouldInjectGa("12345678")).toBe(false);
    expect(describeGaInjection("KlnHeyZ1H6Lus393")).toBeNull();
  });
});

describe("getPublicMeta 的进程内缓存", () => {
  // 一轮 ISR 全量重渲染要渲染 ~130 个页面，每个页面都调一次 getPublicMeta ——
  // 同一份 8KB 的 meta 被重复拉 130 次（~1MB），而且是串行的。
  const originalFetch = global.fetch;
  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it("TTL 内只打一次接口，过期后重新取", async () => {
    // ⚠️ 假定时器只在这个用例里开：下面"并发共享请求"那个用例的桩用了真实延迟，
    //    开了假定时器它的 setTimeout 永远不会触发（第一版就是这么超时的）。
    vi.useFakeTimers();
    const calls: string[] = [];
    global.fetch = (async (url: any) => {
      calls.push(String(url));
      return {
        json: async () => ({
          statusCode: 200,
          data: { version: "x", totalWordCount: 1, menus: [], tags: [], totalArticles: 1, meta: {} },
        }),
      } as any;
    }) as any;
    const mod = await import("../api/getAllData");
    mod.__resetPublicMetaCache();
    await mod.getPublicMeta();
    await mod.getPublicMeta();
    await mod.getPublicMeta();
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(6000);
    await mod.getPublicMeta();
    expect(calls).toHaveLength(2);
    mod.__resetPublicMetaCache();
  });

  it("并发调用共享同一个请求", async () => {
    let n = 0;
    global.fetch = (async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 5));
      return {
        json: async () => ({
          statusCode: 200,
          data: { version: "x", totalWordCount: 1, menus: [], tags: [], totalArticles: 1, meta: {} },
        }),
      } as any;
    }) as any;
    const mod = await import("../api/getAllData");
    mod.__resetPublicMetaCache();
    await Promise.all([mod.getPublicMeta(), mod.getPublicMeta(), mod.getPublicMeta()]);
    expect(n).toBe(1);
    mod.__resetPublicMetaCache();
  });

  it("接口挂掉时不缓存失败结果（构建期还要走默认值分支）", async () => {
    let n = 0;
    global.fetch = (async () => {
      n += 1;
      throw new Error("boom");
    }) as any;
    const mod = await import("../api/getAllData");
    mod.__resetPublicMetaCache();
    await expect(mod.getPublicMeta()).rejects.toBeTruthy();
    await expect(mod.getPublicMeta()).rejects.toBeTruthy();
    expect(n).toBe(2);
    mod.__resetPublicMetaCache();
  });

  it("statusCode 既不是 200 也不是 233（或 data 缺失）时抛错，不再返回 undefined", async () => {
    // 旧实现 `return data` 会把 undefined 当 PublicMetaProp 用：
    // 调用方在 `data.meta.siteInfo` 上炸出难归因的 TypeError，
    // 而且 undefined 还会被当成"成功结果"缓存 5 秒。
    global.fetch = (async () => ({
      json: async () => ({ statusCode: 500, data: undefined }),
    })) as any;
    const mod = await import("../api/getAllData");
    mod.__resetPublicMetaCache();
    await expect(mod.getPublicMeta()).rejects.toThrow(/异常/);
    mod.__resetPublicMetaCache();
  });

  it("构建期的默认值兜底**不入缓存**：server 恢复后立刻回到真数据", async () => {
    const prev = process.env.isBuild;
    process.env.isBuild = "t";
    let fail = true;
    let n = 0;
    global.fetch = (async () => {
      n += 1;
      if (fail) {
        throw new Error("server down");
      }
      return {
        json: async () => ({
          statusCode: 200,
          data: { version: "real", totalWordCount: 1, menus: [], tags: [], totalArticles: 1, meta: {} },
        }),
      } as any;
    }) as any;
    try {
      const mod = await import("../api/getAllData");
      mod.__resetPublicMetaCache();
      const fallback = await mod.getPublicMeta();
      expect(fallback.version).not.toBe("real"); // 默认值兜底
      expect(n).toBe(1);
      // 旧实现会把兜底值缓存 5 秒：接下来 5 秒内渲染的所有页面都是空站点
      fail = false;
      const real = await mod.getPublicMeta();
      expect(real.version).toBe("real");
      expect(n).toBe(2);
      mod.__resetPublicMetaCache();
    } finally {
      if (prev === undefined) {
        delete process.env.isBuild;
      } else {
        process.env.isBuild = prev;
      }
    }
  });
});

describe("图床前缀常量没有被写歪", () => {
  it("thumb 前缀是 img 前缀的子路径", () => {
    expect(STATIC_THUMB_PREFIX.startsWith(STATIC_IMG_PREFIX)).toBe(true);
    expect(STATIC_IMG_PREFIX).toBe("/static/img/");
  });
});
