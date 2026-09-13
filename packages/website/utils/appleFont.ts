/**
 * Apple 皮肤的字体来源（集中在一处，方便换源或改成自托管）。
 *
 * - 中文 / Nerd Font 子集（family = `Maple Mono NF CN`）：zeoseven 的字体 CSS，
 *   里面是**按 unicode-range 切好的几十上百个分包**，所以不能自己写 @font-face 顶掉。
 * - 拉丁子集（family = `Maple Mono`）：`styles/apple.css` 里的本地 @font-face（jsDelivr fontsource），
 *   同时充当「中文子集加载不上时」的兜底。
 *
 * 自托管的做法见 docs/features/config.md 的「字体」小节：下载 NF-CN 变体放进
 * `public/fonts/`，按 unicode-range 分包声明 @font-face，然后把 APPLE_FONT_CSS_URL 设为 null。
 */
export const APPLE_FONT_CSS_URL: string | null =
  "https://static.zeoseven.com/zsft/442/main/result.css";

/** 需要提前建连的字体源（只在皮肤开启时输出） */
export const APPLE_FONT_PRECONNECT_HOSTS = [
  "https://static.zeoseven.com",
  "https://cdn.jsdelivr.net",
];
