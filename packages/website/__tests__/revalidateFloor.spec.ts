import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVALIDATE_SECONDS,
  MIN_REVALIDATE_SECONDS,
  ON_DEMAND_REVALIDATE_SECONDS,
  resolveRevalidateSeconds,
} from "../utils/loadConfig";

/**
 * `revalidate` 以前是 `parseInt(process.env.VAN_BLOG_REVALIDATE_TIME || "10")`：
 * 没有 NaN 守卫、没有下限，而按需模式返回 `{}`（= `revalidate: false`），
 * 配合 `fallback: "blocking"` 意味着**按需生成的页面永远不会因为时间而过期** ——
 * 丢一次 server 的 ISR 触发，那一页就一直停在旧内容上，只能去后台手点"手动触发"。
 *
 * 这个环境变量是 server 直接从后台设置里读出来塞进子进程环境的
 * （`packages/server/src/provider/website/website.provider.ts`：
 * 延时模式 → `VAN_BLOG_REVALIDATE=true` + `VAN_BLOG_REVALIDATE_TIME=isrConfig.delay`；
 * 按需模式 → 只有 `VAN_BLOG_REVALIDATE=false`），而后台那个输入框是自由填写的
 * `ProFormDigit`，所以前台必须自己兜住非法值。
 */
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

describe("resolveRevalidateSeconds", () => {
  it("合法值原样用（整数秒）", () => {
    expect(resolveRevalidateSeconds("60")).toBe(60);
    expect(resolveRevalidateSeconds("120")).toBe(120);
    expect(resolveRevalidateSeconds("3600")).toBe(3600);
    expect(resolveRevalidateSeconds(" 90 ")).toBe(90);
  });

  it("低于下限一律抬到下限（10 秒的 ISR 会把前台和 server 一起拖死）", () => {
    expect(MIN_REVALIDATE_SECONDS).toBe(60);
    expect(resolveRevalidateSeconds("10")).toBe(MIN_REVALIDATE_SECONDS);
    expect(resolveRevalidateSeconds("1")).toBe(MIN_REVALIDATE_SECONDS);
    expect(resolveRevalidateSeconds("0")).toBe(MIN_REVALIDATE_SECONDS);
    expect(resolveRevalidateSeconds("-5")).toBe(MIN_REVALIDATE_SECONDS);
  });

  it("NaN / 空 / 非数字一律回退默认值，绝不产出 NaN", () => {
    expect(DEFAULT_REVALIDATE_SECONDS).toBe(60);
    for (const bad of [undefined, null, "", "   ", "abc", "10s", "NaN", "{}", "null"]) {
      const got = resolveRevalidateSeconds(bad as any);
      expect(Number.isFinite(got)).toBe(true);
      expect(got).toBeGreaterThanOrEqual(MIN_REVALIDATE_SECONDS);
    }
    // 以前 parseInt("abc") 会得到 NaN，Next 把 { revalidate: NaN } 当成"没有 revalidate"
    expect(resolveRevalidateSeconds("abc")).not.toBeNaN();
  });

  it("小数向下取整（Next 只接受整数秒）", () => {
    expect(resolveRevalidateSeconds("90.7")).toBe(90);
    expect(resolveRevalidateSeconds("60.2")).toBe(60);
  });

  it("自定义 fallback 也受下限约束", () => {
    expect(resolveRevalidateSeconds("", 5)).toBe(MIN_REVALIDATE_SECONDS);
    expect(resolveRevalidateSeconds(undefined, 600)).toBe(600);
  });
});

describe("两种 ISR 模式都返回一个数字 revalidate", () => {
  it("按需模式带 24 小时长保险（不再是永不过期）", () => {
    expect(ON_DEMAND_REVALIDATE_SECONDS).toBe(24 * 60 * 60);
    const src = strip(read("utils/loadConfig.ts"));
    expect(src).toContain("{ revalidate: ON_DEMAND_REVALIDATE_SECONDS }");
    expect(src).toContain(
      "resolveRevalidateSeconds(process.env.VAN_BLOG_REVALIDATE_TIME)"
    );
    // 旧的裸 parseInt 写法不能回来
    expect(src).not.toContain('parseInt(process.env.VAN_BLOG_REVALIDATE_TIME || "10")');
    expect(src).not.toMatch(/:\s*\{\};/);
  });

  it("每个页面的 getStaticProps 都把它展开出去", () => {
    const pages = [
      "pages/index.tsx",
      "pages/about.tsx",
      "pages/link.tsx",
      "pages/tag.tsx",
      "pages/category.tsx",
      "pages/timeline.tsx",
      "pages/post/[id].tsx",
      "pages/page/[p].tsx",
      "pages/tag/[tag].tsx",
      "pages/category/[category].tsx",
    ];
    for (const p of pages) {
      expect(strip(read(p))).toContain("...revalidate");
    }
  });
});
