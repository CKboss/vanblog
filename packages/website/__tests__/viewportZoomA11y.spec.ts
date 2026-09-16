import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * viewport 必须允许用户缩放（WCAG 1.4.4 Resize Text）。
 *
 * `user-scalable=no` / `maximum-scale=1` 以前写在 pages/_app.tsx 的 viewport meta 里，
 * 手机上低视力用户完全无法放大正文。现在只保留 `width=device-width, initial-scale=1`。
 * 代价：iOS Safari 聚焦 font-size < 16px 的输入框时会自动放大页面（可双指缩回），
 * 仓库里没有任何测试或注释依赖旧的"输入不触发缩放"行为。
 *
 * ⚠️ 负向断言前先剥注释：_app.tsx 里"不要把 user-scalable=no 加回来"的警告注释
 * 本身含有这两个字符串，不剥的话断言匹配到的就是注释自己（本仓库踩过 10+ 次这个坑）。
 */

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(full);
  }
  return out;
}

describe("viewport 允许用户缩放（WCAG 1.4.4）", () => {
  const code = stripComments(read("pages/_app.tsx"));

  it("_app.tsx 的 viewport 字符串被钉住：width=device-width, initial-scale=1", () => {
    expect(code).toContain('content="width=device-width, initial-scale=1"');
    // 仍然在 <Head> 里、仍然叫 viewport（其它部分原样保留）
    expect(read("pages/_app.tsx")).toContain('name="viewport"');
  });

  it("_app.tsx 的代码里没有任何缩放阻断（剥掉注释后查）", () => {
    expect(code).not.toContain("user-scalable");
    expect(code).not.toContain("maximum-scale");
  });

  it("pages/ 与 components/ 全树都不许出现阻断缩放的 viewport 写法", () => {
    const offenders: string[] = [];
    for (const dir of ["pages", "components"]) {
      for (const file of walk(join(ROOT, dir))) {
        const src = stripComments(readFileSync(file, "utf8"));
        if (
          /user-scalable\s*=\s*no/i.test(src) ||
          /maximum-scale\s*=\s*1(?![0-9.])/i.test(src)
        ) {
          offenders.push(file.slice(ROOT.length + 1));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("全仓库只有一处 viewport meta 声明（防止别处再补一份带缩放阻断的）", () => {
    let count = 0;
    for (const dir of ["pages", "components"]) {
      for (const file of walk(join(ROOT, dir))) {
        const src = stripComments(readFileSync(file, "utf8"));
        if (/name=["']viewport["']/.test(src)) count += 1;
      }
    }
    expect(count).toBe(1);
  });
});
