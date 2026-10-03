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
    // 🔴 期 12 第二批：这里原来钉的是**逐字源码** `}, [valid, props.since]);`，
    //    把 i18n 的 `t` 加进依赖之后它就红了。这是「源码级钉子」的老毛病（本仓库已因此吃过多次）：
    //    它钉的是**写法**，不是**性质** ⇒ 任何等价改写都会假红，而真正的退步（删掉依赖数组）反而可能不红。
    //    改成断言性质：① 那个 effect **有**依赖数组（否则每秒重建定时器）；
    //    ② 数组里含 `props.since`（建站时间变了要重算）；
    //    ③ 🔴 还必须含 `t` —— 否则**切换语种后这一行会一直停在旧语种**，直到下一次 tick 才悄悄跟上
    //    （属于「看起来接了 i18n、其实只在部分路径上生效」）。
    const depArray = rt.match(/\}, \[([^\]]*)\]\);/);
    expect(depArray, "RunningTime 的定时器 effect 必须有依赖数组（不许每秒重建定时器）").toBeTruthy();
    const deps = String(depArray?.[1] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    expect(deps).toContain("props.since");
    expect(deps).toContain("t");
    // 反证：这把尺子确实能抓到「没有依赖数组」那种退步（否则上面三条可能是空的绿）
    expect("}, [valid]);".match(/\}, \[([^\]]*)\]\);/)?.[1]).toBe("valid");
    expect(rt).not.toContain("setInterval(tick, 1000);\n  });");
    // 首帧就有值（tick() 立即跑一次），不再空等第一个 1s
    expect(rt).toMatch(/tick\(\);/);
  });
});
