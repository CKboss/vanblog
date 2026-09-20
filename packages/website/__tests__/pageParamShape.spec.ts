import { readFileSync } from "fs";
import { resolve } from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { isSafeArticleParam } from "../api/getArticles";
import {
  MAX_ROUTE_PARAM_LENGTH,
  inspectRouteParamShape,
  parsePageNumberParam,
} from "../utils/pageParamShape";

/**
 * `fallback: "blocking"` 的入参形状校验。
 *
 * 这个 spec 分三层，缺一不可：
 *  1. **纯函数层**：合法/非法形状的完整枚举（含"绝不能误杀"的真实数据形状）；
 *  2. **页面层**：非法形状必须走 `notFound` 且**一次取数都不发生**（用计数假函数证明），
 *     合法形状必须照常取数并返回 props —— 这一层是"护栏没有把功能修坏"的唯一硬证据；
 *  3. **源码层**：校验必须发生在取数**之前**（调用顺序），且页面里不许再留一份
 *     自己手写的 `/^\d+$/`（两份判定必然漂移）。
 *
 * ⚠️ 第 3 层的"某文本不存在"断言必须先剥注释：本仓库已经踩过 8 次
 * "断言匹配到自己的解释性注释"（[p].tsx 的新注释里就写着 `/page/abc` 这些字面形状）。
 * website 侧的 vitest **解析不到** server 那个 `src/test-utils/anchorCode.ts` 的 TS 别名路径
 * （跨包 + 路径别名），所以这里自己过滤整行注释；只过滤整行是因为我们要防的就是
 * "注释里出现了被禁的字面量"，而跨行块注释在本文件与被测文件里都不承载代码。
 */
const stripWholeLineComments = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

describe("分页入参 parsePageNumberParam：合法形状必须照常通过", () => {
  it("普通页码", () => {
    expect(parsePageNumberParam("1")).toBe(1);
    expect(parsePageNumberParam("2")).toBe(2);
    expect(parsePageNumberParam("23")).toBe(23);
    expect(parsePageNumberParam("999")).toBe(999);
  });

  it("大页码（仍在安全整数内）不被误杀", () => {
    expect(parsePageNumberParam("9007199254740991")).toBe(9007199254740991);
  });
});

describe("分页入参 parsePageNumberParam：非法形状必须拒绝", () => {
  it("曾经渲染成第 1 页并返回 200 的三种历史形状", () => {
    // 这三个是真实修过的 bug：/page/abc、/page/0、/page/-3 都会渲染成第 1 页，
    // 而 current 是 NaN ⇒ 分页高亮丢失、"下一页"链接变成 /page/NaN。
    expect(parsePageNumberParam("abc")).toBeNull();
    expect(parsePageNumberParam("0")).toBeNull();
    expect(parsePageNumberParam("-3")).toBeNull();
  });

  it("其它非数字与半数字形状", () => {
    const bad = ["", " ", "1.5", "1e3", "0x10", " 1", "1 ", "+1", "１", "NaN", "null", "1,2"];
    // 数组对数组：失败时 diff 直接指出是第几个向量出的问题
    expect(bad.map((b) => parsePageNumberParam(b))).toEqual(bad.map(() => null));
  });

  it("非字符串入参（catch-all 路由的数组形状、undefined、对象）", () => {
    const bad: unknown[] = [undefined, null, 1, ["1"], {}, true];
    expect(bad.map((b) => parsePageNumberParam(b))).toEqual(bad.map(() => null));
  });

  it("超过 Number.MAX_SAFE_INTEGER 的页码：算术不可靠，可能把 Infinity 传给 Mongo 的 skip", () => {
    expect(parsePageNumberParam("99999999999999999999")).toBeNull();
    expect(parsePageNumberParam("1" + "0".repeat(400))).toBeNull();
  });

  it("超长入参与危险字符（这两类是 blocking fallback 的滥用面）", () => {
    expect(parsePageNumberParam("1".repeat(MAX_ROUTE_PARAM_LENGTH + 1))).toBeNull();
    expect(parsePageNumberParam("1\n2")).toBeNull();
    expect(parsePageNumberParam("1/2")).toBeNull();
    expect(parsePageNumberParam("1..2")).toBeNull();
  });
});

describe("通用形状判定 inspectRouteParamShape", () => {
  it("拒绝：空、超长、路径分隔符、.. 段、控制字符", () => {
    const bad = [
      "",
      "a".repeat(MAX_ROUTE_PARAM_LENGTH + 1),
      "a/b",
      "a\\b",
      "../etc/passwd",
      "a..b",
      "a\nb",
      "a\u0000b",
      "a\u007fb",
    ];
    expect(bad.map((b) => inspectRouteParamShape(b))).toEqual(bad.map(() => expect.any(String)));
    expect(bad.map((b) => inspectRouteParamShape(b) !== null)).toEqual(bad.map(() => true));
  });

  it("给出可用的拒绝原因（不是笼统的 false）", () => {
    expect(inspectRouteParamShape("")).toBe("empty");
    expect(inspectRouteParamShape("a".repeat(MAX_ROUTE_PARAM_LENGTH + 1))).toBe("too-long");
    expect(inspectRouteParamShape("a/b")).toBe("forbidden-char");
    expect(inspectRouteParamShape("a\nb")).toBe("forbidden-char");
    expect(inspectRouteParamShape("a..b")).toBe("dot-dot-segment");
    expect(inspectRouteParamShape(123)).toBe("not-a-string");
    expect(inspectRouteParamShape("正常别名")).toBeNull();
  });

  it("长度上限本身有意义，且刚好在上限内的不被误杀（差一错误是这类常量的经典坑）", () => {
    expect(MAX_ROUTE_PARAM_LENGTH).toBeGreaterThan(64);
    expect(MAX_ROUTE_PARAM_LENGTH).toBeLessThanOrEqual(4096);
    expect(inspectRouteParamShape("a".repeat(MAX_ROUTE_PARAM_LENGTH))).toBeNull();
  });
});

/* post 侧的权威实现是 api/getArticles.ts 的 isSafeArticleParam（已入库），
 * 本文件**不**再造第二个 post 校验函数。下面这些断言钉的是"那个函数不许被改成字符白名单"，
 * 因为白名单会把所有中文别名的文章变成 404 —— 那是真实数据里存在的形状。 */
describe("跨文件钉子：post 侧的 isSafeArticleParam 绝不能误杀合法别名", () => {
  it("🔴 中文别名必须通过（改成 ASCII 白名单就会红）", () => {
    // utils/encodeLocationPath.ts 存在的理由就是"自定义别名是中文时，Location 头会抛
    // Cannot convert argument to a ByteString" —— 那是真实数据里踩过的坑。
    expect(isSafeArticleParam("中文别名")).toBe(true);
    expect(isSafeArticleParam("Qt自定义控件与提升法(prompted)")).toBe(true); // 生产库里真实存在的一篇
    expect(isSafeArticleParam("C++ 学习笔记")).toBe(true);
    expect(isSafeArticleParam("100%可靠")).toBe(true);
  });

  it("数字 id 与拼音别名照常通过", () => {
    expect(isSafeArticleParam("123")).toBe(true);
    expect(isSafeArticleParam("qdii-ji-jin-xian-gou-yu-na-zhi-feng-wei-ji-jin-fen-xi")).toBe(true);
    expect(isSafeArticleParam("some_slug-2")).toBe(true);
  });

  it("该拒的仍然拒（这条是上面两条的对照：不许为了放行中文把护栏整个拆掉）", () => {
    const bad = ["", "a/b", "a\\b", "../etc/passwd", "a..b", "a#b", "a?b", "a".repeat(201)];
    expect(bad.map((b) => isSafeArticleParam(b))).toEqual(bad.map(() => false));
  });

  it("⚠️ 已知缺口（记录，不修别人的模块）：控制字符没有被拒", () => {
    /* `\n` / `\0` 是日志与响应头注入的原料，而 isSafeArticleParam 的黑名单里没有它们。
     * 这条断言把"现状"钉住：将来谁补上了，这条会红，那时就把它改成 toBe(false) ——
     * 红灯本身就是提醒，比留一条没人知道的缺口好。 */
    expect(isSafeArticleParam("a\nb")).toBe(true);
  });
});

/* ========================= 页面层：护栏不许把功能修坏 ========================= */

/* ========================= 页面层：护栏不许把功能修坏 =========================
 *
 * ⚠️ 这里的写法是被实测逼出来的，别"顺手改简洁"：
 * 本仓库的 vitest 是 **0.29**（没有 `vi.hoisted()`），而**静态的 `vi.mock("../utils/getPageProps", …)`
 * 对相对路径的源模块不生效** —— 实测：mock 之后 import 到的仍是真函数
 * （`typeof spy.mockReset === "undefined"`，调用它返回真结果），于是
 * `expect(spy).not.toHaveBeenCalled()` 会**假绿**（我们数的根本不是页面在用的那个函数）。
 * 仓库里既有的 `vi.mock` 先例只 mock 过 `next/link` 这种裸包名，所以这个坑没被踩过。
 *
 * 可用的写法有两条，都已实测：`vi.doMock` + 动态 `import()`（下面用的这条，
 * 好处是**页面模块也一定拿到被 mock 的依赖**），以及 `vi.spyOn(模块命名空间, "导出名")`。
 * 另外每条"没被调用"的断言都配了一条**空转对照**（证明接线是对的），
 * 因为 mock 静默失效时那一类断言全都是绿的。
 */
describe("page/[p].tsx 的 getStaticProps：非法形状不打 server、不查库", () => {
  let getStaticProps: (ctx: { params: { p?: unknown } }) => Promise<{
    notFound?: boolean;
    props?: unknown;
  }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeAll(async () => {
    fetchSpy = vi.fn();
    // ⚠️ 工厂闭包引用的是**已经赋值**的 fetchSpy（在 beforeAll 里、不是被提升的 vi.mock），
    //    所以不会踩 TDZ。
    vi.doMock("../utils/getPageProps", () => ({
      getPagePagesProps: (...args: unknown[]) => fetchSpy(...args),
    }));
    const page = await import("../pages/page/[p]");
    getStaticProps = page.getStaticProps as unknown as typeof getStaticProps;
  });

  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("接线正确：这个 spy 就是页面在用的那个取数函数（空转对照）", async () => {
    /* 没有这条，下面所有 not.toHaveBeenCalled() 都可能是假绿 ——
     * 上面那段注释里描述的静默失效正是这个形状。 */
    fetchSpy.mockResolvedValue({
      layoutProps: {},
      authorCardProps: {},
      currPage: 1,
      articles: [{ id: 1 }],
    });
    await getStaticProps({ params: { p: "1" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("1");
  });

  it("非法形状直接 notFound，取数函数**一次都没被调用**", async () => {
    for (const p of ["abc", "0", "-3", "", "1.5", "1/2", "1\n2", "a".repeat(300), "1e3"]) {
      const result = await getStaticProps({ params: { p } });
      expect({ p, notFound: result.notFound }).toEqual({ p, notFound: true });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("params 缺失或为 null 时 notFound 且不取数", async () => {
    expect((await getStaticProps({ params: {} })).notFound).toBe(true);
    expect((await getStaticProps({ params: { p: null } })).notFound).toBe(true);
    expect((await getStaticProps({} as { params: { p?: unknown } })).notFound).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("⚠️ 记录既有行为：页面用 String() 强转入参，所以数字/单元素数组会被当成合法页码", async () => {
    /* 这条**不是**护栏漏洞，而是把既有语义钉住，免得后人误判：
     * `String(params?.p ?? "")` 会把 7 变成 "7"、把 ["1"] 变成 "1"，两者都是纯数字串 ⇒ 合法。
     * Next 对非 catch-all 路由本来就只给字符串，所以这条路径在生产里到不了；
     * 重要的是 `String({})` → "[object Object]"、`String(Symbol)` 之类**不会**变成数字串，
     * 所以强转没有给校验开出后门。 */
    fetchSpy.mockResolvedValue({ layoutProps: {}, authorCardProps: {}, articles: [{ id: 1 }] });
    expect((await getStaticProps({ params: { p: 7 } })).notFound).toBeUndefined();
    expect((await getStaticProps({ params: { p: ["1"] } })).notFound).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // 对象与布尔不会被强转成数字串 ⇒ 仍然 notFound
    expect((await getStaticProps({ params: { p: {} } })).notFound).toBe(true);
    expect((await getStaticProps({ params: { p: true } })).notFound).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("合法页码照常取数并返回 props（护栏没有把功能修坏）", async () => {
    const props = {
      layoutProps: { siteName: "x" },
      authorCardProps: {},
      currPage: 2,
      articles: [{ id: 1 }],
    };
    fetchSpy.mockResolvedValue(props);
    const result = await getStaticProps({ params: { p: "2" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 传下去的是**原始字符串**（保持既有行为，别换成 parseInt 的结果：
    // 下游 getPagePagesProps 自己算 skip，换成数字会改变它的入参契约）
    expect(fetchSpy).toHaveBeenCalledWith("2");
    expect(result.props).toBe(props);
    expect(result.notFound).toBeUndefined();
  });

  it("合法页码但超出范围（没有文章）仍是真 404，不是 200 的软 404", async () => {
    fetchSpy.mockResolvedValue({ layoutProps: {}, authorCardProps: {}, articles: [] });
    const result = await getStaticProps({ params: { p: "9999" } });
    expect(result.notFound).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("结果里始终带 revalidate（ISR 语义没被护栏改坏）", async () => {
    fetchSpy.mockResolvedValue({ layoutProps: {}, authorCardProps: {}, articles: [{ id: 1 }] });
    const ok = await getStaticProps({ params: { p: "3" } });
    const bad = await getStaticProps({ params: { p: "zzz" } });
    // 两条路径都必须带 revalidate：少一条就会变成"永久缓存"，那比慢更糟
    expect(typeof (ok as { revalidate?: unknown }).revalidate).toBe("number");
    expect(typeof (bad as { revalidate?: unknown }).revalidate).toBe("number");
  });
});

/* ========================= 源码层：调用顺序与"不许两份判定" ========================= */

describe("page/[p].tsx 源码形状", () => {
  const source = readFileSync(resolve(__dirname, "../pages/page/[p].tsx"), "utf-8");
  const code = stripWholeLineComments(source);

  it("剥注释这个动作本身没空转（真的剥掉了东西，且没把代码剥掉）", () => {
    expect(code.length).toBeLessThan(source.length);
    expect(code).toContain("getPagePagesProps(raw)");
    // 被剥掉的确实只是注释：新注释里写着的字面形状在剥完之后必须消失
    expect(source).toContain("/page/abc");
    expect(code).not.toContain("/page/abc");
  });

  it("形状校验发生在取数之前（顺序才是安全性质，「符号出现」不是）", () => {
    const validateAt = code.indexOf("parsePageNumberParam(raw)");
    const fetchAt = code.indexOf("getPagePagesProps(raw)");
    expect(validateAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(fetchAt);
  });

  it("页面里不许再留一份自己手写的数字判定（两份必然漂移）", () => {
    expect(code).not.toMatch(/\/\^\\d\+\$\//);
    // 反向对照：尺子本身是有效的（这个正则在旧版本文件上必须命中）
    const oldShape = 'if (!/^\\d+$/.test(raw)) { return { notFound: true }; }';
    expect(oldShape).toMatch(/\/\^\\d\+\$\//);
  });

  it("校验来自共用工具，而不是页面里的本地实现", () => {
    expect(code).toContain('from "../../utils/pageParamShape"');
  });
});
