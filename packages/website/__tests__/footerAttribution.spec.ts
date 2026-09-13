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
    expect(footer).toContain("README.md#本分支新增内容");
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
