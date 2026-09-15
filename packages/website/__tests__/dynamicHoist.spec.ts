import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * `next/dynamic` 必须在**模块作用域**调用。
 *
 * 写在渲染体里时，每次父组件重渲染都会得到一个全新的组件类型，React 靠"类型是否相同"
 * 决定复用还是重建子树 —— 类型变了就**卸载旧的、挂载新的**。实测踩到的两处：
 *
 * - `components/WaLine/index.tsx`：`const Core = dynamic(() => import("./core"))`
 *   原来写在 `else` 分支里，父组件（pages/index.tsx 等，`useCommentProvider()`
 *   的异步 setState 至少会触发一次重渲染）每渲染一次，waline 的 `init()` /
 *   `commentCount()` 就重新跑一遍。
 * - 这个坑对任何 `dynamic()` 都成立，所以这里做成"全仓库扫一遍"的断言。
 */
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

/** 找出所有 `dynamic(` 出现的位置，判断它在不在函数体里（缩进 >= 2 且前面有函数声明） */
function dynamicCallSites(src: string) {
  const out: Array<{ line: number; text: string; indent: number }> = [];
  src.split("\n").forEach((text, i) => {
    if (!/\bdynamic\s*\(/.test(text)) return;
    if (/^\s*import\b/.test(text)) return; // import dynamic from "next/dynamic"
    out.push({ line: i + 1, text, indent: text.length - text.trimStart().length });
  });
  return out;
}

describe("WaLine 的 dynamic() 提到了模块作用域", () => {
  it("组件里不再每次渲染都新建一个 Loadable 组件", () => {
    const src = strip(read("components/WaLine/index.tsx"));
    const sites = dynamicCallSites(src);
    expect(sites).toHaveLength(1);
    // 模块作用域 = 顶格（缩进 0）
    expect(sites[0].indent).toBe(0);
    expect(src).toMatch(/^const Core = dynamic\(\(\) => import\("\.\/core"\)\);/m);
    // 渲染体里只剩使用，不再有 dynamic()
    const body = src.slice(src.indexOf("export default function"));
    expect(body).not.toContain("dynamic(");
    expect(body).toContain("<Core enable={props.enable} visible={props.visible} />");
  });

  it("评论关掉时仍然一个字节都不下载（早退分支保留）", () => {
    const src = strip(read("components/WaLine/index.tsx"));
    expect(src).toContain('if (!props.enable || props.enable == "false")');
    expect(src).toContain("return null;");
  });
});

describe("全仓库：dynamic() 不允许写在函数体里", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".next", "__tests__"].includes(entry.name)) continue;
        walk(full, out);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  };

  it("每个 dynamic() 调用点都在顶格（模块作用域）", () => {
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const src = strip(readFileSync(file, "utf8"));
      for (const site of dynamicCallSites(src)) {
        // 允许的例外：把 dynamic(...) 的结果直接当 JSX 用（`{dynamic(...)}`）在仓库里不存在；
        // 一律要求顶格声明，读到缩进的 dynamic() 就报出来
        if (site.indent !== 0) {
          offenders.push(`${file.replace(root + "/", "")}:${site.line}: ${site.text.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
