import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * `wordTotal` 必须**永远**是数字。
 *
 * 为什么值得一条守卫：Next 的 `getStaticProps` 返回值要能被序列化，`undefined` 会让
 * **生产构建**直接失败（`Error serializing .wordTotal … undefined cannot be serialized`），
 * 而触发条件很现实 —— 构建前台时 server 不可达（先构建后起服务、CI、或 Docker 里
 * `VAN_BLOG_SERVER_URL` 指不到活的服务）。这个 bug 真实发生过：`getPageProps.ts` 里有四处
 * 派生 `wordTotal`，只有一处写了 `|| 0`，另外两处裸取、第四处写的是 `as number`
 * （对编译器撒谎，运行时照样是 undefined）。
 *
 * ⚠️ 判据是"每一处派生都带兜底"，不是钉死某一行的写法 —— 否则新增一处派生就会漏网。
 */
const SRC = readFileSync(resolve(__dirname, "../utils/getPageProps.ts"), "utf-8");

/** 去掉整行注释，避免"解释为什么必须兜底"的注释本身被算成一处派生。 */
const code = SRC.split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n");

describe("wordTotal 的派生必须对 undefined 安全", () => {
  // ⚠️ 不用 `code.matchAll(...)` 展开：本包 tsconfig 的 target 低于 es2015，
  //    迭代会报 TS2802（要 downlevelIteration）。用 exec 循环，语义相同。
  const derivations: string[] = [];
  const re = /const\s+wordTotal\s*=\s*([^;\n]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) derivations.push(m[1].trim());

  it("扫描本身没空转（真的扫到了多处派生）", () => {
    // ⚠️ 空转的守卫比没有守卫更糟：本仓库有过 heredoc 参数写错位置导致检查从未执行的先例。
    expect(derivations.length).toBeGreaterThanOrEqual(4);
  });

  it("每一处都带 ?? 0 / || 0 兜底", () => {
    const unguarded = derivations.filter((expr) => !/(\?\?|\|\|)\s*0$/.test(expr));
    expect({ unguarded }).toEqual({ unguarded: [] });
  });

  it("不许再用 `as number` 冒充兜底（那是编译期断言，运行时仍是 undefined）", () => {
    expect(derivations.some((expr) => /\bas\s+number\b/.test(expr))).toBe(false);
  });

  it("负向对照：把兜底去掉时上面的断言必须能抓到", () => {
    const probe = (expr: string) => /(\?\?|\|\|)\s*0$/.test(expr);
    expect(probe("data.totalWordCount ?? 0")).toBe(true);
    expect(probe("totalWordCount || 0")).toBe(true);
    expect(probe("data.totalWordCount")).toBe(false); // ← 旧形状，必须判为"没兜底"
    expect(probe("totalWordCount as number")).toBe(false); // ← 旧形状，同样必须判为"没兜底"
  });
});
