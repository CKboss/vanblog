import { describe, expect, it } from "vitest";

import { formatReadingTime } from "../utils/readingTime";
import { formatTimeAgo } from "../utils/relativeTime";
import { formatTimelineMonthLabel } from "../utils/timelineMonths";
import { IDENTITY_T, type TFunc } from "../utils/i18n";

/**
 * 🔴 期 10 第二批：证明"注入尾参 `t`"这个接缝**真的接通了**（不是装饰）。
 *
 * 三件事各钉一条：
 * ① **默认行为逐字节不变**：不传 `t` 时（= `IDENTITY_T`）输出与迁移前完全一样；
 * ② **传进词典就能换语言**：用一个假 `t` 返回英文模板 ⇒ 输出真的变成英文，且 `{n}` / `{m}` 被插值；
 * ③ 🔴 **反向**：如果哪天有人把 `t(...)` 改回硬编码中文，②就会红 ——
 *    这正是"接缝有没有被偷偷拆掉"的唯一可判定信号（①是看不出来的，因为默认值就是中文）。
 */
const EN: Record<string, string> = {
  "readingTime.minutes": "About {n} min read",
  "relativeTime.justNow": "just now",
  "relativeTime.seconds": "{n}s ago",
  "relativeTime.minutes": "{n} minutes ago",
  "relativeTime.hours": "{n} hours ago",
  "relativeTime.days": "{n} days ago",
  "timeline.monthLabel": "Month {m}",
};

/** 极简假翻译器：查得到就用（并做 {name} 插值），查不到就退回中文默认值。 */
const fakeT: TFunc = (id, defaultMessage, values) => {
  const hit = EN[id];
  const tpl = typeof hit === "string" && hit ? hit : defaultMessage;
  let out = tpl;
  for (const [k, v] of Object.entries(values || {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
};

describe("前台 i18n 接缝 · 注入尾参 t（readingTime / relativeTime / timelineMonths）", () => {
  it("① 不传 t 时行为与迁移前逐字节相同（IDENTITY_T 是默认值）", () => {
    expect(formatReadingTime(7)).toBe("约 7 分钟");
    expect(formatReadingTime(7, IDENTITY_T)).toBe("约 7 分钟");
    expect(formatReadingTime(null)).toBeNull();
    expect(formatReadingTime("abc")).toBeNull();

    const now = Date.parse("2026-09-30T10:00:00Z");
    const at = (iso: string) => formatTimeAgo(iso, now);
    expect(at("2026-09-30T10:00:00Z")).toBe("刚刚");
    expect(at("2026-09-30T09:59:30Z")).toBe("30秒前");
    expect(at("2026-09-30T09:30:00Z")).toBe("30分钟前");
    expect(at("2026-09-30T07:00:00Z")).toBe("3小时前");
    expect(at("2026-09-28T10:00:00Z")).toBe("2天前");
    expect(formatTimeAgo(null, now)).toBe("-");

    expect(formatTimelineMonthLabel(12)).toBe("12月");
    expect(formatTimelineMonthLabel(3)).toBe("3月");
  });

  it("② 传入词典就能换语言，且占位符被真的插值（接缝是通的）", () => {
    expect(formatReadingTime(7, fakeT)).toBe("About 7 min read");
    expect(String(formatReadingTime(7, fakeT))).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);

    const now = Date.parse("2026-09-30T10:00:00Z");
    const at = (iso: string) => formatTimeAgo(iso, now, fakeT);
    expect(at("2026-09-30T10:00:00Z")).toBe("just now");
    expect(at("2026-09-30T09:59:30Z")).toBe("30s ago");
    expect(at("2026-09-30T09:30:00Z")).toBe("30 minutes ago");
    expect(at("2026-09-30T07:00:00Z")).toBe("3 hours ago");
    expect(at("2026-09-28T10:00:00Z")).toBe("2 days ago");
    // 🔴 词典里没有的 key ⇒ 回落中文默认值（不是裸 key、不是 undefined）
    expect(formatTimeAgo(null, now, fakeT)).toBe("-");

    expect(formatTimelineMonthLabel(12, fakeT)).toBe("Month 12");
  });

  it("③ 🔴 反向：三个函数都必须**把 t 用在返回值上**（有人改回硬编码中文就会红）", () => {
    // 用一个"总是返回哨兵"的 t：如果函数没有把 t 用在返回值上，哨兵就不会出现。
    const SENTINEL = "__I18N_SEAM_WAS_USED__";
    const sentinelT: TFunc = () => SENTINEL;
    expect(formatReadingTime(7, sentinelT)).toBe(SENTINEL);
    expect(formatTimeAgo("2026-09-30T09:30:00Z", Date.parse("2026-09-30T10:00:00Z"), sentinelT)).toBe(SENTINEL);
    expect(formatTimelineMonthLabel(3, sentinelT)).toBe(SENTINEL);
    // ⚠️ "不可展示"的分支不该过 t（它返回 null / "-"，不是文案）
    expect(formatReadingTime(null, sentinelT)).toBeNull();
  });
});
