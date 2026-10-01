import { readFileSync, readdirSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FRONT_LOCALE,
  __resetI18nForTests,
  setDictionary,
  setLocale,
  t,
} from "../utils/i18n";
import {
  LOCALE_COOKIE_MAX_AGE_SECONDS,
  LOCALE_COOKIE_NAME,
  normalizeLocale,
  readCookieValue,
  readSavedLocale,
  writeSavedLocale,
} from "../utils/localePreference";
import { applyFrontLocale, localeShortLabel, nextFrontLocale } from "../utils/applyFrontLocale";
import dictZhTW from "../locales/zh-TW";
import dictEnUS from "../locales/en-US";

const websiteRoot = path.join(__dirname, "..");

/**
 * 🔴 前台词典的**覆盖率对账** + 语种偏好的行为断言（期 10 第五批，2026-09-30）。
 *
 * ## 为什么需要这份判据（它防的是三种"静默坏"）
 * ① **词典缺 key**：代码里 `t("nav.actionSearch", "搜索")` 而词典里没有 `nav.actionSearch`
 *    ⇒ 界面**静默回落中文**（不报错、不红），只有切到英文去点那个按钮才看得见；
 * ② **孤儿 key**：词典里有、代码里没人用 ⇒ 说明代码那处的 id 写错了（例如打成 `nav.actionSeach`），
 *    于是 ①② **成对出现**：一边回落中文、一边躺着一个没人用的译文。
 *    🔴 所以两个方向都要查（只查①的话，"id 打错字"这种最常见的错误完全静默）；
 * ③ **两份词典不一致**：zh-TW 有而 en-US 没有（或反之）⇒ 一种语言正常、另一种回落中文。
 */

/** 从源码里把"代码用到的 id"全找出来（两种形状都要认，理由见 §7.206 A：判据不能只认一种形状）。 */
function collectUsedIds(): { ids: Set<string>; perFile: Map<string, string[]> } {
  const ids = new Set<string>();
  const perFile = new Map<string, string[]>();
  const exts = [".ts", ".tsx", ".js", ".jsx"];
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", ".next", "public", "dist", "__tests__", "locales"].includes(e.name)) continue;
        walk(abs);
      } else if (e.isFile() && exts.some((x) => e.name.endsWith(x)) && !/\.(test|spec)\./.test(e.name)) {
        files.push(abs);
      }
    }
  })(websiteRoot);

  // 先把所有"ID 常量 → 字符串"与"map 常量 → {key: 字符串}"收集起来（id 表可能是常量，也可能是 map）
  const idConst = new Map<string, string>();
  const idMaps = new Map<string, Record<string, string>>();
  const strConst = new Map<string, string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of Array.from(src.matchAll(/export const ([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]*)"/g))) {
      strConst.set(m[1], m[2]);
      if (/_ID$/.test(m[1])) idConst.set(m[1], m[2]);
    }
    // `export const X_IDS: Record<…> = { a: "b", … };`
    // 🔴 `[^{}]*` 而不是 `[\s\S]*?`：懒惰匹配会**跨过下一个 `export const`** 一路吃到再下一个 `};`
    //    （实测：`HEADER_ACTION_LABELS = {…} as const;` 后面紧跟 `HEADER_ACTION_LABEL_IDS = {…};`，
    //    懒惰版把两个 map 合成一个、名字记成了前者 ⇒ 后者查不到 ⇒ 5 个 nav.* 被误判成孤儿 key）。
    //    👉 🔴 写"抓一个对象字面量"的正则时，**必须禁止跨越花括号**，否则相邻声明会被吞掉。
    for (const m of Array.from(src.matchAll(/export const ([A-Z_][A-Z0-9_]*)(?::[^={]*)?=\s*\{([^{}]*)\};/g))) {
      const body = m[2];
      const entries: Record<string, string> = {};
      for (const e of Array.from(body.matchAll(/(\w+):\s*"([^"]*)"/g))) entries[e[1]] = e[2];
      if (Object.keys(entries).length) idMaps.set(m[1], entries);
    }
  }

  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const rel = path.relative(websiteRoot, f);
    const found: string[] = [];
    // 形状一：t("字面量 id", …)
    for (const m of Array.from(src.matchAll(/\bt\(\s*"([a-zA-Z][\w.]*)"\s*,/g))) found.push(m[1]);
    // 形状二：t(ID_CONST, <任意第二实参>) —— 第二实参可以是常量、字面量，
    // 🔴 也可以是**模板串**（`pageNav.jumpSentence` 那条是 `t(ID, `${A} {input} ${B}`, { input })`）。
    //    所以这里**不约束第二实参的形状**，只要求第一实参是已知的 ID 常量（这就够严了：
    //    ID 常量表本身是从 `_ID = "…"` 声明里收的，不是随便什么标识符）。
    for (const m of Array.from(src.matchAll(/\bt\(\s*([A-Z_][A-Z0-9_]*)\s*,/g))) {
      const v = idConst.get(m[1]);
      if (v) found.push(v);
    }
    // 形状三：t(ID_MAP[kind], DEFAULT_MAP[kind]) ⇒ 展开 map 的每一个 value
    for (const m of Array.from(src.matchAll(
      /\bt\(\s*([A-Z_][A-Z0-9_]*)\[[^\]]*\]\s*,\s*[A-Z_][A-Z0-9_]*\[[^\]]*\]\s*[,)]/g
    ))) {
      const map = idMaps.get(m[1]);
      if (map) for (const v of Object.values(map)) found.push(v);
    }
    if (found.length) {
      perFile.set(rel, found);
      for (const id of found) ids.add(id);
    }
  }
  return { ids, perFile };
}


/** 从源码里取 `export const NAME = "值"`（取不到就返回原样的 `${NAME}`，让占位符检查如实报错）。 */
function constOf(src: string, name: string): string {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : `\${${name}}`;
}
/** 从源码里取 `export const NAME_ID = "id"` 的 id 值。 */
function idConstOf(src: string, name: string): string | null {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

describe("🔴 前台词典覆盖率对账（缺 key / 孤儿 key / 两份词典不一致）", () => {
  const { ids, perFile } = collectUsedIds();

  it("反空转：真的扫到了代码里的 id（否则「覆盖率 100%」是空的绿）", () => {
    expect(ids.size).toBeGreaterThan(30);
    expect(perFile.size).toBeGreaterThan(5);
    expect(Object.keys(dictEnUS).length).toBeGreaterThan(30);
    expect(Object.keys(dictZhTW).length).toBeGreaterThan(30);
  });

  it("① 代码里用到的每一个 id，两份词典里都**必须有**（缺了就静默回落中文）", () => {
    const missingTw: string[] = [];
    const missingEn: string[] = [];
    ids.forEach((id) => {
      if (typeof dictZhTW[id] !== "string" || !dictZhTW[id]) missingTw.push(id);
      if (typeof dictEnUS[id] !== "string" || !dictEnUS[id]) missingEn.push(id);
    });
    expect(missingTw, "zh-TW 词典缺这些 key（界面会静默显示中文默认值）").toEqual([]);
    expect(missingEn, "en-US 词典缺这些 key（界面会静默显示中文默认值）").toEqual([]);
  });

  it("② 🔴 词典里不许有**孤儿 key**（有译文但没人用 ⇒ 通常是代码那处 id 打错了字）", () => {
    const orphanTw = Object.keys(dictZhTW).filter((k) => !ids.has(k));
    const orphanEn = Object.keys(dictEnUS).filter((k) => !ids.has(k));
    expect(orphanTw, "zh-TW 里这些 key 代码里没人用（检查 id 是否打错）").toEqual([]);
    expect(orphanEn, "en-US 里这些 key 代码里没人用（检查 id 是否打错）").toEqual([]);
  });

  it("③ 两份词典的 key 集合必须**完全一致**（否则一种语言正常、另一种回落中文）", () => {
    expect(Object.keys(dictZhTW).sort()).toEqual(Object.keys(dictEnUS).sort());
  });

  it("④ 🔴 占位符集合必须三份一致（中文默认值 / zh-TW / en-US）", () => {
    // 中文默认值从源码里取：`t("id", "默认值")` 或 `export const X = "默认值"` + `X_ID = "id"`
    const defaults = new Map<string, string>();
    perFile.forEach((_list, rel) => {
      const src = readFileSync(path.join(websiteRoot, rel), "utf8");
      for (const m of Array.from(src.matchAll(/\bt\(\s*"([a-zA-Z][\w.]*)"\s*,\s*"([^"]*)"/g))) defaults.set(m[1], m[2]);
      // 🔴 模板串形状：`t(X_ID, `${A} {input} ${B}`, { input })` ⇒
      //    默认值是**拼出来的**，要把 `${CONST}` 用常量表还原成字符串才能比占位符
      //    （`pageNav.jumpSentence` 就是这个形状；第一版没认它 ⇒ 报"没能取出中文默认值"）。
      for (const m of Array.from(src.matchAll(/\bt\(\s*([A-Z_][A-Z0-9_]*_ID)\s*,\s*`([^`]*)`/g))) {
        const id = idConstOf(src, m[1]);
        if (!id) continue;
        const zh = m[2].replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_all, name) => constOf(src, name));
        defaults.set(id, zh);
      }
      // 常量形状：`export const X_ID = "id"; export const X = "默认值";`
      const constIds = new Map<string, string>();
      for (const m of Array.from(src.matchAll(/export const ([A-Z_][A-Z0-9_]*)_ID\s*=\s*"([^"]*)"/g))) constIds.set(m[1], m[2]);
      constIds.forEach((id, name) => {
        const dm = src.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`));
        if (dm) defaults.set(id, dm[1]);
      });
      // map 形状：id 表与默认值表按 key 对应
      for (const m of Array.from(src.matchAll(/export const ([A-Z_][A-Z0-9_]*)_IDS[^=]*=\s*\{([\s\S]*?)\};/g))) {
        const name = m[1];
        // 🔴 不能写死 `${name}_LABELS`：`HEADER_ACTION_LABEL_IDS` 去掉 `_IDS` 是 `HEADER_ACTION_LABEL`，
        //    而默认值那张 map 叫 `HEADER_ACTION_LABELS`（只多一个 `S`）⇒ 用"以 name 开头"的宽松匹配。
        const dm = src.match(new RegExp(`export const ${name}\\w*\\s*=\\s*\\{([^{}]*)\\}`));
        if (!dm) continue;
        const idEntries = Array.from(m[2].matchAll(/(\w+):\s*"([^"]*)"/g));
        const dmEntries = Array.from(dm[1].matchAll(/(\w+):\s*"([^"]*)"/g));
        for (const d of dmEntries) {
          const hit = idEntries.find((x) => x[1] === d[1]);
          if (hit) defaults.set(hit[2], d[2]);
        }
      }
    });
    const ph = (x: string) =>
      Array.from(x.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g))
        .map((m) => m[1])
        .sort()
        .join(",");
    const bad: string[] = [];
    ids.forEach((id) => {
      const zh = defaults.get(id);
      if (typeof zh !== "string") {
        bad.push(`${id}: 没能从源码里取出中文默认值（判据要跟着形状更新，见 §7.206 A）`);
        return;
      }
      const a = ph(zh);
      if (ph(dictZhTW[id]) !== a) bad.push(`${id}: zh-TW 占位符 ${ph(dictZhTW[id])} ≠ 中文 ${a}`);
      if (ph(dictEnUS[id]) !== a) bad.push(`${id}: en-US 占位符 ${ph(dictEnUS[id])} ≠ 中文 ${a}`);
    });
    expect(bad).toEqual([]);
  });

  it("⑤ 🔴 真的切过去看看：装上词典、切到 en-US / zh-TW，取出来的必须是译文（不是中文默认值）", () => {
    setDictionary("zh-TW", dictZhTW);
    setDictionary("en-US", dictEnUS);

    setLocale("en-US");
    expect(t("nav.actionSearch", "搜索")).toBe("Search");
    expect(t("nav.actionMenu", "打开菜单")).toBe("Open menu");
    // 🔴 期 10 第十二批：这一行原来断言的是 `markdown.copyCode`，但**站长裁定 markdown 管线保持现状**
    //    ⇒ 那条接缝函数与词典条目都被删掉了（留着"没有消费方的接缝 + 词典条目"会让人以为已经支持多语言）。
    //    换成另一个确定在用的 key。👉 🔴 这类"点名某个 key"的断言在**裁定变化**时会红 ——
    //    红了不是坏事，它逼着来改断言的人**读到裁定**（比让断言自动适配更有价值）。
    expect(t("nav.actionAdmin", "管理后台")).toBe("Admin panel");
    expect(t("unlock.lockedPrompt", "文章已加密，请输入密码后查看：")).toMatch(/:$/);
    expect(t("relativeTime.hours", "{n}小时前", { n: 3 })).toBe("3 hours ago");
    expect(t("readingTime.minutes", "约 {n} 分钟", { n: 7 })).toBe("About 7 min");
    expect(t("timeline.monthLabel", "{m}月", { m: 9 })).toBe("Month 9");
    expect(t("pageNav.jumpSentence", "跳转 {input} 页", { input: "[INPUT]" })).toBe("Go to page [INPUT]");
    // 🔴 英文里不许有撇号（ICU 转义）
    Object.values(dictEnUS).forEach((v) => {
      expect(v).not.toMatch(/['’]/);
    });
    // 🔴 占位符要**成对**：中文默认值里有 `{x}` 的，英文里也必须有同名占位符；
    //    中文里**没有**的，英文里也不许凭空多出来（多出来就会在界面上显示成字面量 `{x}`）。
    //    ⚠️ 不能写成"英文里不许有任何占位符"——`locale.switcher` 的中文默认值本身就带
    //    `{current}` / `{next}`（第一版我就是这么写的，结果被自己这条断言误伤）。
    const withPh: Array<[string, string]> = [
      ["locale.switcher", "切换语言：当前 {current}，点击切换到 {next}"],
      ["readingTime.minutes", "约 {n} 分钟"],
      ["relativeTime.days", "{n}天前"],
      ["timeline.monthLabel", "{m}月"],
      ["pageNav.jumpSentence", "跳转 {input} 页"],
    ];
    withPh.forEach(([id, zh]) => {
      const names = Array.from(zh.matchAll(/\{(\w+)\}/g)).map((m) => m[1]);
      names.forEach((n) => {
        expect(dictEnUS[id], `${id} 的英文缺占位符 {${n}}`).toContain(`{${n}}`);
        expect(dictZhTW[id], `${id} 的繁中缺占位符 {${n}}`).toContain(`{${n}}`);
      });
      // 插值之后不许残留占位符
      const values: Record<string, unknown> = {};
      names.forEach((n) => (values[n] = "7"));
      expect(t(id, zh, values)).not.toMatch(/\{\w+\}/);
    });

    setLocale("zh-TW");
    expect(t("nav.actionSearch", "搜索")).toBe("搜尋");
    // 🔴 同上：`markdown.copyCode` 已按站长裁定移除 ⇒ 换成确定在用的 key
    expect(t("nav.actionSearch", "搜索")).toBe("搜尋");
    expect(t("postCard.copiedTitle", "已复制标题到剪切板！")).toMatch(/剪貼簿/);
    // 🔴 繁中词典里不许出现**简体专用字**。
    // ⚠️ 这个字符类第一版写错了：我把 `搜`/`打`/`制`/`寻` 也放了进去，而它们是**简繁共用**的
    //    （`搜尋` 的 `搜` 就是共用字）⇒ 断言被自己误伤。
    //    👉 🔴 写"简体专用字表"必须逐字确认它是**只在简体里出现**的（本项目后台那份 69 字表是逐字核过的，
    //    见 `--zh-tw-audit`），不能凭印象凑 —— 凭印象凑出来的字表会**假红**，
    //    而假红比漏红更糟：它会把下一个人训练成"这条断言不用管"。
    Object.values(dictZhTW).forEach((v) => {
      expect(v).not.toMatch(/[复开时阅读关闭单显设让说话马]/);
    });

    setLocale(DEFAULT_FRONT_LOCALE);
    expect(t("nav.actionSearch", "搜索")).toBe("搜索");
  });

  it("⑥ 🔴 覆盖率**棘轮**：词典 key 数只许增不许减（迁一批就该涨）", () => {
    // 🔴 140 = 期 10 第十二批之后的实测值（第十一批 128 - 1 条按裁定移除的 `markdown.copyCode` + 13 条新迁）
    //    历史：第五批 39 → 第八批 66 → 第九批 105 → 第十批 101（合并去重）→ 第十一批 128 → 第十二批 **140**。
    //    （下面这段是第十批留下的说明，保留：）
    // 🔴 101 = 期 10 第十批之后的实测值（第九批曾是 105，第十批**移除**了 `comment.time*` 4 个孤儿 key：
    //    站长裁定「超过 30 天显示日期」⇒ 评论区的本地 `timeAgo()` 被删、改用共享的
    //    `formatTimeAgoOrDate()` ⇒ 相对时间统一走 `relativeTime.*` 那 5 个 key）。
    //    ⚠️ 🔴 这是棘轮**第一次下调**，所以要把原因写在这里：下调的唯一合法理由是
    //    "**key 被合并/删除了**"（不是"懒得翻所以删掉"）；而上调的理由是"又迁了一批"。
    //    👉 棘轮的语义是"覆盖率不许退步"，而**合并重复 key 是让覆盖率更真实**（一份文案一条译文），
    //    所以这种下调是**进步**，不是退步 —— 但必须在注释里说清，否则下一个人会以为可以随便调小。
    expect(Object.keys(dictEnUS).length).toBeGreaterThanOrEqual(140);
    expect(Object.keys(dictZhTW).length).toBeGreaterThanOrEqual(140);
    expect(ids.size).toBeGreaterThanOrEqual(140);
  });
});

describe("🔴 语种偏好：cookie 白名单与不可信输入", () => {
  afterEach(() => {
    __resetI18nForTests();
  });

  it("normalizeLocale 只认白名单，其余一律回落默认语种", () => {
    expect(normalizeLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeLocale("zh-TW")).toBe("zh-TW");
    expect(normalizeLocale("en-US")).toBe("en-US");
    expect(normalizeLocale("ZH-tw")).toBe("zh-TW"); // 大小写不敏感
    // 🔴 宽容匹配：浏览器给的是这些形状
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(normalizeLocale("zh-HK")).toBe("zh-TW");
    expect(normalizeLocale("en-GB")).toBe("en-US");
    // 🔴 **cookie 是不可信输入**：非法值/注入尝试一律回落默认语种（这个值会进 `<html lang>`）
    expect(normalizeLocale('"><script>alert(1)</script>')).toBe(DEFAULT_FRONT_LOCALE);
    expect(normalizeLocale("fr")).toBe(DEFAULT_FRONT_LOCALE);
    expect(normalizeLocale("")).toBe(DEFAULT_FRONT_LOCALE);
    expect(normalizeLocale(null)).toBe(DEFAULT_FRONT_LOCALE);
    expect(normalizeLocale(undefined)).toBe(DEFAULT_FRONT_LOCALE);
    expect(normalizeLocale({ toString: () => "en-US" })).toBe(DEFAULT_FRONT_LOCALE);
  });

  it("readCookieValue 只取自己那一个，且容忍缺等号/空值/编码值", () => {
    expect(readCookieValue("a=1; vanblog_locale=en-US; b=2", LOCALE_COOKIE_NAME)).toBe("en-US");
    expect(readCookieValue("vanblog_locale=zh-TW", LOCALE_COOKIE_NAME)).toBe("zh-TW");
    expect(readCookieValue("other=x", LOCALE_COOKIE_NAME)).toBeNull();
    expect(readCookieValue("", LOCALE_COOKIE_NAME)).toBeNull();
    expect(readCookieValue("=1; broken", LOCALE_COOKIE_NAME)).toBeNull();
    expect(readCookieValue("vanblog_locale=en%2DUS", LOCALE_COOKIE_NAME)).toBe("en-US");
    // 🔴 前缀相似的名字不许误命中（`vanblog_locale_x` ≠ `vanblog_locale`）
    expect(readCookieValue("vanblog_locale_x=fr", LOCALE_COOKIE_NAME)).toBeNull();
  });

  it("🔴 没有 document 的环境（SSR / node 测试）里，读写偏好必须**安全空转**而不是抛错", () => {
    expect(typeof document).toBe("undefined");
    expect(readSavedLocale()).toBeNull();
    expect(() => writeSavedLocale("en-US")).not.toThrow();
    expect(() => writeSavedLocale("zh-CN")).not.toThrow();
    // 🔴 非法值连写都不许写（白名单）
    expect(() => writeSavedLocale("fr" as never)).not.toThrow();
    // applyFrontLocale 在没有 DOM 时也要能跑（它只负责 setLocale + 写 cookie + 改 <html lang>）
    expect(() => applyFrontLocale("en-US")).not.toThrow();
    expect(nextFrontLocale("zh-CN")).toBe("zh-TW");
    expect(nextFrontLocale("zh-TW")).toBe("en-US");
    expect(nextFrontLocale("en-US")).toBe("zh-CN");
    expect(localeShortLabel("zh-CN")).toBe("简");
    expect(localeShortLabel("zh-TW")).toBe("繁");
    expect(localeShortLabel("en-US")).toBe("EN");
    // 🔴 cookie 的存活时间是一年级别（偏好不是会话状态）
    expect(LOCALE_COOKIE_MAX_AGE_SECONDS).toBeGreaterThan(60 * 60 * 24 * 30);
  });

  it("🔴 源码级钉子：切换按钮必须真的挂在导航栏上（桌面端与移动端都要有）", () => {
    const nav = readFileSync(path.join(websiteRoot, "components/NavBar/index.tsx"), "utf8");
    const navMobile = readFileSync(path.join(websiteRoot, "components/NavBarMobile/index.tsx"), "utf8");
    expect(nav).toMatch(/<LocaleSwitcher\s*\/>/);
    expect(navMobile).toMatch(/<LocaleSwitcher\s*\/>/);
    // 🔴 `_app.tsx` 必须注册词典并在挂载后恢复偏好（少一件，按钮就是死的）
    const app = readFileSync(path.join(websiteRoot, "pages/_app.tsx"), "utf8");
    expect(app).toMatch(/setDictionary\("zh-TW", dictZhTW\)/);
    expect(app).toMatch(/setDictionary\("en-US", dictEnUS\)/);
    expect(app).toMatch(/detectInitialLocale\(\)/);
    expect(app).toMatch(/applyFrontLocale\(saved\)/);
    // 🔴 恢复偏好必须在 `useEffect` 里（渲染期读 cookie 会造成 SSR/客户端首帧不一致 ⇒ 水合告警）
    const effectIdx = app.indexOf("useEffect(() => {\n    const saved = detectInitialLocale();");
    expect(effectIdx, "恢复语种必须在 useEffect 里，不能在渲染期").toBeGreaterThan(-1);
  });
});
