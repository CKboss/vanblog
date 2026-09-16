import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import dayjs from "dayjs";
import { toSafeIsoString } from "../utils/safeDate";
import { formatRunningTime, sinceYear } from "../components/RunningTime";

/**
 * Invalid Date 的静默流出（这轮修的三处）：
 * - 文章页 meta 的 `new Date(x).toISOString()` 对坏日期抛 RangeError → SSR 500；
 * - 页脚 `new Date(since).getFullYear()` → "© NaN - 2026"；
 * - RunningTime 的 dayjs diff → "本站居然运行了NaN天NaN小时NaN分NaN秒"（每秒刷新）。
 */
describe("toSafeIsoString", () => {
  it("合法日期与 Date 对象都能格式化", () => {
    expect(toSafeIsoString("2024-07-07T00:00:00.000Z")).toBe("2024-07-07T00:00:00.000Z");
    expect(toSafeIsoString(new Date("2024-07-07T00:00:00.000Z"))).toBe(
      "2024-07-07T00:00:00.000Z",
    );
    expect(toSafeIsoString(0)).toBe("1970-01-01T00:00:00.000Z");
  });
  it("坏值一律 null，绝不抛", () => {
    expect(toSafeIsoString("")).toBeNull();
    expect(toSafeIsoString(null)).toBeNull();
    expect(toSafeIsoString(undefined)).toBeNull();
    expect(toSafeIsoString("不是日期")).toBeNull();
    expect(toSafeIsoString(NaN)).toBeNull();
    expect(() => toSafeIsoString("不是日期")).not.toThrow();
  });
});

describe("formatRunningTime / sinceYear", () => {
  it("合法的 since 正常输出 N天N小时N分N秒", () => {
    const now = dayjs("2024-07-10T01:02:03Z");
    expect(formatRunningTime("2024-07-07T00:00:00Z", now)).toBe(
      `${now.diff(dayjs("2024-07-07T00:00:00Z"), "days")}天1小时2分3秒`,
    );
    expect(sinceYear("2024-07-07")).toBe(2024);
  });
  it("无效/空的 since 返回 null（组件整行不渲染，而不是 NaN）", () => {
    expect(formatRunningTime("")).toBeNull();
    expect(formatRunningTime("abc")).toBeNull();
    expect(sinceYear("")).toBeNull();
    expect(sinceYear("abc")).toBeNull();
  });
});

describe("接线：页脚不再把 Invalid Date 渲染出来", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  const strip = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
      .join("\n");

  it("Footer 的 © 行走 sinceYear 守卫", () => {
    const footer = strip(read("components/Footer/index.tsx"));
    expect(footer).toContain("sinceYear(since)");
    expect(footer).not.toContain("new Date(since).getFullYear()");
  });

  it("文章页 meta 走 toSafeIsoString，不再裸调 toISOString", () => {
    const post = strip(read("pages/post/[id].tsx"));
    expect(post).toContain("toSafeIsoString(props?.article?.createdAt)");
    expect(post).toContain("toSafeIsoString(props?.article?.updatedAt)");
    expect(post).not.toContain(".toISOString()");
  });

  it("RunningTime 无效日期整行不渲染，定时器依赖稳定", () => {
    const rt = strip(read("components/RunningTime/index.tsx"));
    expect(rt).toContain("if (!valid)");
    expect(rt).toContain("return null;");
    // 旧实现没有依赖数组：每秒 setT → 重渲染 → clearInterval+setInterval 重建一轮
    expect(rt).toContain("}, [valid, props.since]);");
    // 首帧就有值（tick() 立即跑一次），不再空等第一个 1s
    expect(rt).toMatch(/tick\(\);/);
  });
});
