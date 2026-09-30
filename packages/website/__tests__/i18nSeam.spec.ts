import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FRONT_LOCALE,
  FRONT_LOCALES,
  IDENTITY_T,
  __resetI18nForTests,
  getLocale,
  setDictionary,
  setLocale,
  subscribeI18n,
  t,
  translateServerMessage,
} from "../utils/i18n";

/**
 * 🔴 前台 i18n **接缝层**的行为断言（期 10 第一批）。
 *
 * 这里钉的是"接缝期"的三条性质：
 * ① **默认行为与今天逐字节相同**（没有词典 ⇒ 原样返回中文默认值，并做 `{name}` 插值）；
 * ② **接词典之后能真的换语言**（接缝不是摆设：`setDictionary` + `setLocale` 之后必须返回译文）；
 * ③ **服务端错误消息按 `code` 走前台词典，查不到就原样返回服务端那句中文**（绝不显示裸码/裸 key）。
 */
describe("前台 i18n 接缝层", () => {
  afterEach(() => {
    __resetI18nForTests();
  });

  it("① 没有词典时：原样返回中文默认值（含 {name} 插值），且语种是 zh-CN", () => {
    expect(getLocale()).toBe(DEFAULT_FRONT_LOCALE);
    expect(DEFAULT_FRONT_LOCALE).toBe("zh-CN");
    expect(FRONT_LOCALES).toEqual(["zh-CN", "zh-TW", "en-US"]);
    expect(t("search.submit", "搜索")).toBe("搜索");
    expect(t("reading.time", "约 {n} 分钟", { n: 12 })).toBe("约 12 分钟");
    // 🔴 缺失/undefined 的参数值插成空串，不许渲染出 "undefined"
    expect(t("x", "a{v}b", { v: undefined })).toBe("ab");
    // 🔴 恒等翻译器与主入口行为一致（注入给纯函数的那个默认值）
    expect(IDENTITY_T("any.key", "中文", { v: 1 })).toBe("中文");
    // 🔴 **不返回裸 key**：即使 id 看起来很像key，也只返回默认值
    expect(t("some.missing.key", "默认文案")).toBe("默认文案");
    expect(String(t("some.missing.key", "默认文案"))).not.toContain("some.missing.key");
  });

  it("② 接上词典之后真的能换语言（接缝不是摆设），并且切回 zh-CN 又回到中文", () => {
    setDictionary("en-US", { "search.submit": "Search", "reading.time": "About {n} min" });
    setLocale("en-US");
    expect(getLocale()).toBe("en-US");
    expect(t("search.submit", "搜索")).toBe("Search");
    expect(t("reading.time", "约 {n} 分钟", { n: 12 })).toBe("About 12 min");
    // 词典里没有的 key ⇒ 回落中文默认值（不是裸 key、不是 undefined）
    expect(t("not.in.dict", "回落文案")).toBe("回落文案");
    setLocale("zh-CN");
    expect(t("search.submit", "搜索")).toBe("搜索");
  });

  it("② 🔴 语种切换会通知订阅者（`useT()` 靠它触发重渲染）", () => {
    let hits = 0;
    const off = subscribeI18n(() => {
      hits += 1;
    });
    setLocale("zh-TW");
    expect(hits).toBe(1);
    // 设成同一个语种不该重复通知（否则会造成无意义的重渲染）
    setLocale("zh-TW");
    expect(hits).toBe(1);
    // 非法语种直接忽略（不许把状态搞坏）
    setLocale("fr" as never);
    expect(getLocale()).toBe("zh-TW");
    expect(hits).toBe(1);
    setDictionary("zh-TW", { "search.submit": "搜尋" });
    expect(hits).toBe(2);
    expect(t("search.submit", "搜索")).toBe("搜尋");
    off();
    setLocale("en-US");
    // ⚠️ vitest 的 `toBe()` **只接受一个参数**（jest 也不接受第二个"消息"参数；
    //    我按"断言消息"的直觉写了第二个参数 ⇒ `tsc` 报 TS2554: Expected 1 arguments, but got 2）。
    //    👉 🔴 想给断言加说明就写在**注释**里，或者用 `expect(x, msg)` 这种 vitest 支持的**第二个位置在 expect 上**的写法。
    expect(hits, "取消订阅之后不该再收到通知").toBe(2);
  });

  it("③ 服务端错误消息：有码且前台词典里有 ⇒ 用译文 + params 插值", () => {
    setDictionary("en-US", {
      "error.pathnameTooLong": "Path alias too long (at most {max} characters): {pathname}",
    });
    setLocale("en-US");
    const body = {
      statusCode: 400,
      message: "路径别名过长（最多 100 个字符）：aaaa",
      code: "pathnameTooLong",
      params: { max: 100, pathname: "aaaa" },
    };
    expect(translateServerMessage(body)).toBe("Path alias too long (at most 100 characters): aaaa");
    expect(String(translateServerMessage(body))).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
  });

  it("③ 🔴 前台词典里没有那个码 ⇒ **原样返回服务端那句中文**（与今天逐字相同，绝不显示裸码）", () => {
    setLocale("en-US"); // 语种是英文，但前台还没有词典
    const body = { statusCode: 400, message: "路径别名过长（最多 100 个字符）：aaaa", code: "pathnameTooLong" };
    expect(translateServerMessage(body)).toBe(body.message);
    const out = String(translateServerMessage(body));
    expect(out).not.toContain("pathnameTooLong");
    expect(out).not.toContain("error.");
  });

  it("③ 🔴 `errorCode` 优先、`code` 兜底（与后台同口径：业务协议值占了 `code`）", () => {
    setDictionary("en-US", { "error.exportNoImagesToPack": "EN: no images to pack" });
    setLocale("en-US");
    const body = {
      statusCode: 400,
      message: "这篇内容里没有可打包的图片，.mdz 与 .md 完全等价 —— 请改选 Markdown (.md)。",
      code: "NO_IMAGES_FOR_MDZ", // 后台在读的业务协议值
      errorCode: "exportNoImagesToPack", // i18n 码
    };
    expect(translateServerMessage(body)).toBe("EN: no images to pack");
    // 🔴 反向：只有业务协议值、没有 errorCode ⇒ 查不到译文 ⇒ 回落中文（不许拿协议值当错误码用出乱码）
    const legacy = { statusCode: 400, message: body.message, code: "NO_IMAGES_FOR_MDZ" };
    expect(translateServerMessage(legacy)).toBe(body.message);
  });

  it("③ 四种载体形状都认（响应体本身 / err.data / err.info / err.response.data）", () => {
    const payload = { statusCode: 429, message: "尝试次数过多，请 30 秒后再试", code: "articleUnlockThrottled" };
    expect(translateServerMessage(payload)).toBe(payload.message);
    expect(translateServerMessage({ data: payload })).toBe(payload.message);
    expect(translateServerMessage({ info: payload })).toBe(payload.message);
    expect(translateServerMessage({ response: { data: payload } })).toBe(payload.message);
    // 🔴 什么都取不到 ⇒ undefined（让调用方用自己的兜底文案，而不是显示 "undefined"）
    expect(translateServerMessage(null)).toBeUndefined();
    expect(translateServerMessage({})).toBeUndefined();
    expect(translateServerMessage("boom")).toBeUndefined();
  });
});
