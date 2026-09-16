import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import * as shim from "../components/Markdown/mdastUtilMark";
import {
  pandocMarkFromMarkdown,
  pandocMarkToMarkdown,
} from "../components/Markdown/mdastUtilMark";

/**
 * `mdast-util-mark@1.0.0` 把源码 `index.ts` 一起发进了 npm 包，TS 5 解析 main 的
 * `index.js` 时会先命中它（`.js→.ts` 替代规则），把一份对着已装依赖根本编译不过
 * 的源码拉进类型检查（skipLibCheck 不管 .ts）。website 的修法：tsconfig `paths`
 * 把裸包名映射到包内**编译成品** `index.d.ts`（paths 查找先于 node_modules 解析），
 * 导入统一收拢在 `components/Markdown/mdastUtilMark.ts` 做 ESM 具名再导出 ——
 * 运行时仍是 main 指向的 index.js，零变化（==高亮== 的端到端渲染由
 * extraSyntax.spec.ts 钉住）。
 *
 * 这个 spec 防止"接管类型"变成"漂移"：
 * 1. 中转模块与原始包运行时的导出**同源同值**（引用相等）；
 * 2. 导出形状 —— extraSyntax.ts 的 remarkMark 消费的正是这几个字段；
 * 3. 版本还是 1.0.0 —— 升级这个包时必须重新核对官方 index.d.ts 与 paths 映射；
 * 4. tsconfig paths 映射还在（删掉它解析就会回落到误发布的 index.ts）；
 * 5. 中转模块运行时导出面与官方 index.d.ts 的值导出面一致（官方 d.ts 里的
 *    `Mark` 是纯类型接口，没有运行时实体，不参与比较）。
 */

const websiteRoot = path.join(__dirname, "..");
const pkgDir = path.join(websiteRoot, "node_modules", "mdast-util-mark");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rawPkg = require("mdast-util-mark/index.js") as Record<string, unknown>;

// 断言前先剥注释（仓库规矩：别让注释里的词满足/破坏断言）。
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** 只取「值导出」（const/let/var/function/class），接口/类型没有运行时实体。 */
const valueExportNames = (src: string): string[] => {
  const names: string[] = [];
  const re =
    /export\s+(?:declare\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    names.push(match[1]);
  }
  return names.sort();
};

describe("mdast-util-mark 中转模块与原始包同源", () => {
  it("中转导出的就是包 index.js 里的同一批对象（引用相等）", () => {
    expect(Object.keys(shim).sort()).toEqual([
      "pandocMarkFromMarkdown",
      "pandocMarkToMarkdown",
    ]);
    expect(shim.pandocMarkFromMarkdown).toBe(rawPkg.pandocMarkFromMarkdown);
    expect(shim.pandocMarkToMarkdown).toBe(rawPkg.pandocMarkToMarkdown);
  });

  it("pandocMarkFromMarkdown 带 mark 的 enter/exit 处理器与 EOL 声明", () => {
    const ext = pandocMarkFromMarkdown;
    expect(ext.canContainEols).toContain("mark");
    expect(typeof ext.enter?.mark).toBe("function");
    expect(typeof ext.exit?.mark).toBe("function");
  });

  it("pandocMarkToMarkdown 带 mark 序列化器与 = 的转义规则", () => {
    const ext = pandocMarkToMarkdown;
    expect(typeof ext.handlers?.mark).toBe("function");
    expect(ext.unsafe).toEqual([{ character: "=", inConstruct: "phrasing" }]);
  });
});

describe("解析配置与官方 index.d.ts 不漂移", () => {
  it("安装的版本仍是 1.0.0（升级包时必须同步核对本 spec 与 tsconfig paths）", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(pkgDir, "package.json"), "utf8")
    );
    expect(pkg.version).toBe("1.0.0");
  });

  it("tsconfig paths 把裸包名映射到官方 index.d.ts（防止解析回落到误发布的 index.ts）", () => {
    const tsconfig = JSON.parse(
      readFileSync(path.join(websiteRoot, "tsconfig.json"), "utf8")
    );
    expect(tsconfig.compilerOptions.paths["mdast-util-mark"]).toEqual([
      "./node_modules/mdast-util-mark/index.d.ts",
    ]);
  });

  it("中转模块的运行时导出面与官方 index.d.ts 的值导出面一致", () => {
    const official = valueExportNames(
      stripComments(readFileSync(path.join(pkgDir, "index.d.ts"), "utf8"))
    );
    expect(official).toEqual([
      "pandocMarkFromMarkdown",
      "pandocMarkToMarkdown",
    ]);
    expect(Object.keys(shim).sort()).toEqual(official);
  });
});
