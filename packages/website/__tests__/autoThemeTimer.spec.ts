import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { AUTO_THEME_POLL_MS, isAutoResolvedTheme } from "../utils/theme";

/**
 * 「自动模式每 10s 重新评估主题」以前是一个**死功能**：
 * 管理定时器的 effect 依赖里有 setTheme/props 这些每次渲染都新建的引用，
 * 于是每次重渲染 cleanup 都把 interval 清掉，而 body 被 hasInit 门闩挡住不重建 ——
 * 定时器从来活不过下一次渲染，且没有任何报错（前台与后台是同一个模式，两边都修了）。
 */
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const readRepo = (p: string) =>
  readFileSync(join(__dirname, "..", "..", "..", p), "utf8");
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join("\n");

describe("isAutoResolvedTheme / AUTO_THEME_POLL_MS", () => {
  it("auto 家族（auto / auto-light / auto-dark）都算自动模式", () => {
    expect(isAutoResolvedTheme("auto")).toBe(true);
    expect(isAutoResolvedTheme("auto-light")).toBe(true);
    expect(isAutoResolvedTheme("auto-dark")).toBe(true);
    expect(isAutoResolvedTheme("light")).toBe(false);
    expect(isAutoResolvedTheme("dark")).toBe(false);
    expect(isAutoResolvedTheme(undefined)).toBe(false);
    expect(isAutoResolvedTheme(null)).toBe(false);
    expect(isAutoResolvedTheme(42)).toBe(false);
  });
  it("轮询间隔是 10s（与旧实现的字面量一致）", () => {
    expect(AUTO_THEME_POLL_MS).toBe(10000);
  });
});

describe("website ThemeButton：定时器由 [theme] 值驱动", () => {
  it("轮询 effect 只依赖 theme，不再挂在每次渲染都换引用的闭包上", () => {
    const src = strip(read("components/ThemeButton/core.tsx"));
    expect(src).toContain("isAutoResolvedTheme(theme)");
    expect(src).toContain("AUTO_THEME_POLL_MS");
    // 管理 interval 的 effect 依赖必须是 [theme]
    expect(src).toMatch(/return \(\) => \{\s*clearTimer\(\);\s*\};\s*\}, \[theme\]\);/);
    // 旧写法：依赖数组里混着 setTheme/props（每次渲染都触发 cleanup）
    expect(src).not.toContain("[current, setTheme, props, currentTimer, theme]");
  });
  it("初始化 effect 只跑一次（门闩保留，但不再兼职管定时器）", () => {
    const src = strip(read("components/ThemeButton/core.tsx"));
    // setTheme 里不再有 setTimer/clearTimer 调用（定时器只由 [theme] effect 管理）
    const setThemeFn = src.slice(src.indexOf("const setTheme ="), src.indexOf("const clearTimer"));
    expect(setThemeFn).not.toContain("setTimer");
    expect(setThemeFn).not.toContain("clearTimer");
    // localStorage 写入有 try/catch（隐私模式不能把点击搞崩）
    expect(setThemeFn).toContain("try {");
  });
});

describe("admin ThemeButton：同一个死功能的同款修复", () => {
  it("轮询 effect 只依赖 theme，setInitialState 用函数式更新", () => {
    const src = strip(readRepo("packages/admin/src/components/ThemeButton/index.tsx"));
    expect(src).toMatch(/\}, \[theme\]\);/);
    expect(src).toContain("setInitialState((prev: any) => ({");
    // 旧写法：hasInit 门闩 + 每次渲染新建的 setTimer/clearTimer 进依赖
    expect(src).not.toContain("[current, clearTimer, theme, setTimer]");
    expect(src).not.toContain("hasInit");
  });
});
