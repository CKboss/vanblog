import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { DEFAULT_SERVER_URL, resolveServerUrl } from "../utils/loadConfig";

const repoRoot = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

describe("server 地址环境变量（构建期为空也不能炸）", () => {
  it("空串 / 纯空白 / undefined / null 都回退默认值", () => {
    // 这就是 Docker 里的真实情况：ARG 没传 → ENV VAN_BLOG_SERVER_URL='' →
    // 老代码 `?? "http://localhost:3000"` 拦不住空串 → new URL('') 抛 ERR_INVALID_URL，
    // 而且是在模块顶层，报错发生在 next build 的 Collecting page data 阶段
    for (const raw of ["", "   ", "\n", undefined, null]) {
      expect(resolveServerUrl(raw as any)).toBe(DEFAULT_SERVER_URL);
    }
  });

  it("非法 URL 也回退，而不是把异常抛到构建期", () => {
    // localhost:3000 会被 new URL 当成「协议 localhost」而不抛错，所以协议校验是必须的
    for (const raw of ["not a url", "http://", "://x", "localhost:3000", "ftp://x/y", "file:///etc/passwd"]) {
      expect(resolveServerUrl(raw)).toBe(DEFAULT_SERVER_URL);
    }
  });

  it("合法地址原样规范化（尾斜杠会被 URL 标准化补上）", () => {
    expect(resolveServerUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
    expect(resolveServerUrl("https://blog.example.com/")).toBe("https://blog.example.com/");
    expect(resolveServerUrl("  https://blog.example.com  ")).toBe("https://blog.example.com/");
    // 带路径前缀的也要补尾斜杠，否则会拼成 …/apiapi/public/meta
    expect(resolveServerUrl("https://blog.example.com/api")).toBe("https://blog.example.com/api/");
  });

  it("任何输入下 baseUrl 都必须带尾斜杠（调用方拼的是 `${baseUrl}api/public/...`）", () => {
    // 这条是踩过坑的：兜底分支返回过 "http://localhost:3000"（无尾斜杠），
    // 拼出来是 http://localhost:3000api/public/meta → new URL 抛错 → 整站 500
    for (const raw of [
      "",
      "   ",
      undefined,
      null,
      "not a url",
      "localhost:3000",
      "ftp://x/y",
      "http://127.0.0.1:3000",
      "https://blog.example.com/api",
    ]) {
      const base = resolveServerUrl(raw as any);
      expect(base.endsWith("/"), `${String(raw)} -> ${base}`).toBe(true);
      // 直接验拼接结果本身是不是合法 URL（这才是调用方真正会做的事）
      expect(() => new URL(`${base}api/public/meta`)).not.toThrow();
      // 只有「根路径」型的 base 才能断言具体 pathname；
      // 带前缀的（https://host/api/）拼出来自然是 /api/api/public/meta，那是配置本身的语义
      if (new URL(base).pathname === "/") {
        expect(new URL(`${base}api/public/meta`).pathname).toBe("/api/public/meta");
      }
    }
    expect(DEFAULT_SERVER_URL.endsWith("/")).toBe(true);
  });

  it("config.baseUrl 走的是这个函数，模块顶层不再有裸 new URL", () => {
    // 断言前剥掉注释：文件里的说明正好引用了老写法 `new URL(process.env.…)`，不剥就自己匹配自己
    const src = read("packages/website/utils/loadConfig.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(src).toContain("baseUrl: resolveServerUrl(process.env.VAN_BLOG_SERVER_URL)");
    expect(src).not.toMatch(/new URL\(\s*process\.env/);
  });

  it("Dockerfile 的 build-arg 有默认值，一键脚本也总会传它", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("ARG VAN_BLOG_BUILD_SERVER=http://127.0.0.1:3000");
    expect(dockerfile).toContain("ENV VAN_BLOG_SERVER_URL=${VAN_BLOG_BUILD_SERVER}");

    for (const script of ["scripts/vanblog.sh", "docs/.vuepress/public/vanblog.sh"]) {
      const body = read(script);
      expect(body).toContain('local build_server="${VANBLOG_BUILD_SERVER:-http://127.0.0.1:3000}"');
      expect(body).toContain('--build-arg "VAN_BLOG_BUILD_SERVER=${build_server}"');
      // 不能再有「用户没设就不传」的分支
      expect(body).not.toContain('if [[ -n "${VANBLOG_BUILD_SERVER:-}" ]]; then');
    }
  });
});
