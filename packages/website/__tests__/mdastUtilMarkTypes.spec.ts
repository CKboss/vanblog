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
 * `index.js` 时会先命中它，把一份对着已装依赖根本编译不过的源码拉进类型检查
 * （skipLibCheck 不管 .ts）。website 用 `components/Markdown/mdastUtilMark.ts`
 * 中转：类型对照包内官方 `index.d.ts`，运行时用 `require("mdast-util-mark/index.js")`
 * —— 与 main 指向的是同一个文件，运行时零变化（==高亮== 的端到端渲染由
 * extraSyntax.spec.ts 钉住）。
 *
 * 这个 spec 防止"中转"变成"漂移"：
 * 1. 中转模块与原始包运行时的导出**同源同值**；
 * 2. 导出形状 —— extraSyntax.ts 的 remarkMark 消费的正是这几个字段；
 * 3. 版本还是 1.0.0 —— 升级这个包时必须重新核对官方 index.d.ts 与中转文件；
 * 4. 中转文件的值导出面与官方 index.d.ts 完全一致（不多不少；官方 d.ts 里的
 *    `Mark` 是纯类型接口，没有运行时实体，中转文件有意不带，见其顶部说明）。
 */

const websiteRoot = path.join(__dirname, "..");
const pkgDir = path.join(websiteRoot, "node_modules", "mdast-util-mark");
const shimSrc = path.join(
  websiteRoot,
  "components",
  "Markdown",
  "mdastUtilMark.ts"
);

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

describe("mdastUtilMark.ts 与官方 index.d.ts 不漂移", () => {
  it("安装的版本仍是 1.0.0（升级包时必须同步核对中转文件）", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(pkgDir, "package.json"), "utf8")
    );
    expect(pkg.version).toBe("1.0.0");
  });

  it("中转文件的值导出面与官方 index.d.ts 完全一致", () => {
    const official = valueExportNames(
      stripComments(readFileSync(path.join(pkgDir, "index.d.ts"), "utf8"))
    );
    const relay = valueExportNames(
      stripComments(readFileSync(shimSrc, "utf8"))
    );
    expect(official).toEqual([
      "pandocMarkFromMarkdown",
      "pandocMarkToMarkdown",
    ]);
    expect(relay).toEqual(official);
  });
});
