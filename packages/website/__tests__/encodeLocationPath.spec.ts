import { describe, expect, it } from "vitest";
import { encodeLocationPath } from "../utils/encodeLocationPath";

// 这个工具存在的理由：HTTP 头的值只能是 Latin-1（ByteString）。
// 文章自定义别名是中文时，把它直接塞进 308 重定向的 Location 头，Node 会抛
// `TypeError: Cannot convert argument to a ByteString ...`，Next 的 redirect 整个失败
// —— 表现是**那篇文章直接 500**。只有真实数据里有中文别名才会踩到，假数据测不出来。
describe("encodeLocationPath", () => {
  it("纯 ASCII 原样返回（不能把已编码的 %xx 再编成 %25xx）", () => {
    expect(encodeLocationPath("hello-world")).toBe("hello-world");
    expect(encodeLocationPath("post/123")).toBe("post/123");
    expect(encodeLocationPath("%E4%B8%AD%E6%96%87")).toBe("%E4%B8%AD%E6%96%87");
    expect(encodeLocationPath("a-b_c.d~e")).toBe("a-b_c.d~e");
  });

  it("中文按段编码，且保留路径分隔符", () => {
    expect(encodeLocationPath("中文别名")).toBe(
      "%E4%B8%AD%E6%96%87%E5%88%AB%E5%90%8D"
    );
    expect(encodeLocationPath("post/中文")).toBe("post/%E4%B8%AD%E6%96%87");
    expect(encodeLocationPath("a/中文/b")).toBe("a/%E4%B8%AD%E6%96%87/b");
  });

  it("编码结果只含 ASCII，可以安全放进 Location 头", () => {
    const encoded = encodeLocationPath("标签/中文 emoji 🎉");
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7f]/.test(encoded)).toBe(false);
    expect(encoded).toContain("%F0%9F%8E%89");
  });

  it("空值与空段不会被弄坏", () => {
    expect(encodeLocationPath("")).toBe("");
    expect(encodeLocationPath("/中文/")).toBe("/%E4%B8%AD%E6%96%87/");
  });
});
