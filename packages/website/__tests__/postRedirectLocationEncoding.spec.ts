import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// 源码级守卫：/post/[id] 的 308 重定向必须过 encodeLocationPath。
// 真实事故（本地镜像 + 生产数据跑出来的）：文章自定义别名是中文时，
// Location 头里出现非 Latin-1 字符 → Node setHeader 抛
// "Cannot convert argument to a ByteString" → 那篇文章 500，日志里刷 16 次。
const strip = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

describe("post 页面的 308 重定向", () => {
  const source = strip(
    readFileSync(join(__dirname, "../pages/post/[id].tsx"), "utf8")
  );

  it("destination 用 encodeLocationPath 包过", () => {
    expect(source).toMatch(/destination:\s*`\/post\/\$\{encodeLocationPath\(/);
  });

  it("没有把原始 pathname 直接拼进 Location", () => {
    expect(source).not.toMatch(/destination:\s*`\/post\/\$\{canonical\}`/);
  });

  it("从 utils/encodeLocationPath 引入（不是从 seo 里顺手拿的）", () => {
    expect(source).toMatch(
      /import\s*\{\s*encodeLocationPath\s*\}\s*from\s*"\.\.\/\.\.\/utils\/encodeLocationPath"/
    );
  });
});
