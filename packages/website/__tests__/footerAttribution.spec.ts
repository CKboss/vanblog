import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// __tests__ → website → packages → 仓库根（三层，别少数一层）
const repoRoot = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
/** 断言前剥掉注释：新注释里常常引用「以前指向哪里」 */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

/**
 * GitHub 为一个 markdown 标题生成的锚点 slug。
 * 🔴 这个实现不是照着文档猜的：拿本仓库 README 与 GitHub 真实渲染出的 HTML 对过账 ——
 *    `id="user-content-…"` 共 19 个，本函数算出的集合与之**逐个相同、不多不少**。
 * ⚠️ 两个容易漏的点（都实测过）：
 *    ① GitHub 也给 **HTML 块级标题**（README 顶部的 `<h1 align="center">VanBlog</h1>`）生成锚点，
 *       只解析 markdown 的 `#` 标题会漏掉它 ⇒ 漏算对本守卫是**危险方向**（合法锚点会假红）；
 *    ② 中文字符原样保留（`## 出处与许可` → `#出处与许可`），不做百分号编码。
 */
const headingSlug = (text: string): string =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接 → 只留文字
    .replace(/`([^`]*)`/g, "$1") // 行内代码
    .replace(/<[^>]+>/g, "") // HTML 标签
    .replace(/[*_~]/g, "") // 强调 / 删除线标记
    .toLowerCase()
    // ⚠️ 这里刻意**不用** `/[^\p{L}\p{N}…]/u`：website 的 tsconfig target 低于 es6，
    //    `u` 标志会报 TS1501（vitest 用 esbuild 只剥类型、不检查 ⇒ 只有 tsc 抓得到，而那正是 CI 会红的地方）。
    //    改用"只保留 ASCII 词字符 + 连字符 + 空格 + CJK 统一表意文字（含扩展 A）"，
    //    中文标点（（）、：「」—— 等）自然被去掉，与 GitHub 的行为一致。
    .replace(/[^\w\- \u4e00-\u9fff\u3400-\u4dbf]/g, "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/ /g, "-");

/**
 * 逐个执行全局正则（代替 `String.prototype.matchAll` 的迭代）。
 * ⚠️ 同样是 target 限制：`for (const m of str.matchAll(re))` 会报 TS2802（需要 downlevelIteration 或更高 target）。
 */
const eachMatch = (re: RegExp, src: string, fn: (m: RegExpExecArray) => void): void => {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    fn(m);
    if (m[0] === "") re.lastIndex += 1; // 零宽匹配防死循环
  }
};

/** README 里所有可跳转的锚点：markdown 标题 + HTML 块级标题 + 显式 `<a id>` */
const readmeAnchors = (): Set<string> => {
  const out = new Set<string>();
  let inFence = false;
  for (const line of read("README.md").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue; // 代码块里的 # 不是标题
    const md = line.match(/^(#{1,6})\s+(.*)$/);
    if (md) {
      const s = headingSlug(md[2].replace(/^\s+|\s+$/g, ""));
      if (s) out.add(s);
    }
    eachMatch(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, line, (m) => {
      const s = headingSlug(m[2].replace(/^\s+|\s+$/g, ""));
      if (s) out.add(s);
    });
    eachMatch(/<a\s+[^>]*\bid="([^"]+)"/g, line, (m) => out.add(m[1]));
  }
  return out;
};

/** 从一段产品代码里取出所有指向 `README.md#<锚点>` 的链接 */
const readmeAnchorLinks = (src: string): string[] => {
  const out: string[] = [];
  eachMatch(/README\.md#([^\s"'`)\\]+)/g, src, (m) => out.push(decodeURIComponent(m[1])));
  return out;
};

describe("页脚的 Powered By 指向本分支", () => {
  const footer = codeOnly(read("packages/website/components/Footer/index.tsx"));

  it("链接是本 fork 的仓库，不再是上游文档站", () => {
    expect(footer).toContain('href="https://github.com/CKboss/vanblog"');
    expect(footer).not.toContain("vanblog.mereith.com");
    // 项目名照旧叫 VanBlog：它确实是 VanBlog，本分支遵循上游 GPL v3
    expect(footer).toContain("VanBlog <span>{version}</span>");
  });

  it("标明这是增强修改版，并给出「改了什么」的入口", () => {
    expect(footer).toContain("增强修改版");
    // 🔴 钉的是**当前真实存在的锚点**，不是"某个字面量还在"。本节曾因 README 改名而变成死锚点：
    //    链接文本被守卫钉着，却没人钉"链接的目标存在" ⇒ 改名时什么都没红，而访客点进去停在仓库顶部。
    expect(footer).toContain("README.md#出处与许可");
    expect(footer).not.toContain("README.md#与上游的关系");
  });

  it("外链带 noreferrer + 新窗口，且保留 ua 类（性能不变式：.ua 不许有 hover:scale）", () => {
    const links = footer.match(/<a[\s\S]*?>/g) || [];
    const poweredBy = links.filter((tag) => tag.includes("CKboss/vanblog"));
    expect(poweredBy.length).toBe(2);
    for (const tag of poweredBy) {
      expect(tag).toContain('rel="noreferrer"');
      expect(tag).toContain('target={"_blank"}');
      expect(tag).toContain("ua ua-link");
      expect(tag).not.toMatch(/hover:scale-/);
    }
  });
});

describe("版本号从哪来（页脚与后台「关于」显示的那个）", () => {
  it("server 读 VAN_BLOG_VERSION，没设就退回 dev", () => {
    expect(read("packages/server/src/utils/loadConfig.ts")).toContain(
      "export const version = process.env['VAN_BLOG_VERSION'] || 'dev'",
    );
  });

  it("镜像构建：build-arg 是复数 VAN_BLOG_VERSIONS，注入的环境变量是单数 VAN_BLOG_VERSION", () => {
    // 这两个名字不一样是上游就有的设定，改一边就会让版本号显示成 dev
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("ARG VAN_BLOG_VERSIONS");
    // ENV 现在统一用 key=value 形式（buildkit 会对 `ENV key value` 报 LegacyKeyValueFormat 警告）
    expect(dockerfile).toContain("ENV VAN_BLOG_VERSION=${VAN_BLOG_VERSIONS}");
    expect(dockerfile).not.toContain("ENV VAN_BLOG_VERSION ${VAN_BLOG_VERSIONS}");
  });

  it("前台从接口取版本号，取不到也退回 dev（不会渲染成 undefined）", () => {
    expect(read("packages/website/utils/getLayoutProps.ts")).toContain(
      'version: data?.version || "dev"',
    );
  });

  it("本地开发脚本会注入一个能对上代码的版本标签（分支 + 短 sha）", () => {
    const script = read("dev-env.sh");
    expect(script).toContain('VERSION_LABEL="dev/dsh${_git_sha:+@$_git_sha}"');
    expect(script).toContain("git -C \"$ROOT\" rev-parse --short HEAD");
    expect(script).toContain("VAN_BLOG_VERSION='$VERSION_LABEL'");
    // git 不可用时要能退回纯分支名，不能变成 "dev/dsh@" 这种半截字符串
    expect(script).toContain('_git_sha=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)');
  });
});

/**
 * 🔴 死锚点守卫：产品代码里每一个指向 `README.md#<锚点>` 的链接，其目标必须在 README 里真实存在。
 *
 * 为什么需要它：README 的「与上游的关系」一节被改名为「出处与许可」时，前台页脚与后台「关于」页
 * 的链接都变成了死锚点 —— 而**没有任何测试变红**，因为既有守卫钉的是"链接文本里含有那个字面量"，
 * 钉住了引用方、却没钉住被引用方的存在。👉 规矩：**守卫钉住了引用方的文本，不等于钉住了被引用方存在**；
 * 改名或移动一个被别处链接的锚点/路径/标识符时，必须反向搜一遍"谁指向它"。
 */
describe("README 锚点必须真实存在（防死锚点）", () => {
  const anchors = readmeAnchors();
  const footer = codeOnly(read("packages/website/components/Footer/index.tsx"));
  const links = readmeAnchorLinks(footer);

  it("slug 算法本身是对的（尺子有效性：算法错了下面几条都会变成假的绿）", () => {
    // 中文标题原样保留、不编码
    expect(headingSlug("出处与许可")).toBe("出处与许可");
    // 英文：小写 + 空格转连字符 + 去标点
    expect(headingSlug("Known Limitations (2026)")).toBe("known-limitations-2026");
    // markdown 行内格式要先剥掉
    expect(headingSlug("**粗体** 与 `代码`")).toBe("粗体-与-代码");
    expect(headingSlug("[链接文字](https://example.com)")).toBe("链接文字");
  });

  it("锚点集合非平凡，且同时覆盖 markdown 标题与显式 <a id>", () => {
    // 反空转：集合若为空，"所有链接都能解析"就恒真
    expect(anchors.size).toBeGreaterThan(15);
    expect(anchors.has("出处与许可")).toBe(true); // 来自 markdown 标题
    expect(anchors.has("vanblog")).toBe(true); // 来自 HTML 块级标题 <h1 align="center">VanBlog</h1>
    // 显式 <a id> 兼容锚点也要算进来（否则旧书签的锚点会被误判为不存在）
    const explicit: string[] = [];
    eachMatch(/<a\s+[^>]*\bid="([^"]+)"/g, read("README.md"), (m) => explicit.push(m[1]));
    expect(explicit.length).toBeGreaterThan(0);
    for (const id of explicit) expect(anchors.has(id)).toBe(true);
  });

  it("🔴 页脚里每个 README 链接的锚点都真实存在", () => {
    expect(links.length).toBeGreaterThan(0); // 反空转：没有链接时这条不许假装通过
    for (const anchor of links) {
      expect(
        anchors.has(anchor),
        `页脚指向 README.md#${anchor}，但 README 里没有这个锚点（标题改名了？请同步改链接）`,
      ).toBe(true);
    }
  });

  it("页脚指向的是当前真实的节名，不是已改名的旧锚点", () => {
    // 这条与上一条互补：上一条证明"目标存在"，这条证明"用的是新名字"
    expect(links).toContain("出处与许可");
  });
});
