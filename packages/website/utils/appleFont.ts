/**
 * Apple 皮肤的字体来源（集中在一处，方便换源或改成自托管）。
 *
 * - 拉丁子集（family = `Maple Mono`）：**已自托管**——文件在 `public/fonts/`，
 *   @font-face 声明在 `styles/apple.css`（版本、SHA-256、许可证都记录在那里的注释），
 *   同时充当「中文子集加载不上时」的兜底。首屏用的这一个文件由 Layout 输出
 *   `<link rel="preload">`（见 APPLE_FONT_LATIN_WOFF2）。
 * - 中文 / Nerd Font 子集（family = `Maple Mono NF CN`）：zeoseven 的字体 CSS，
 *   里面是**按 unicode-range 切好的几十上百个分包**，所以不能自己写 @font-face 顶掉；
 *   它是异步加载的（media="print" → 水合后翻 all），解析不了/加载不上时退回
 *   拉丁子集与系统字体栈，不阻塞首屏。
 *
 * 把 NF-CN 也自托管的做法见 docs/features/config.md 的「字体」小节：下载 NF-CN 变体放进
 * `public/fonts/`，按 unicode-range 分包声明 @font-face，然后把 APPLE_FONT_CSS_URL 设为 null
 * （= null 时 <link> 与 preconnect 一个字节都不输出）。
 */
export const APPLE_FONT_CSS_URL: string | null =
  "https://static.zeoseven.com/zsft/442/main/result.css";

/**
 * 自托管的拉丁子集 woff2（首屏站点名/导航就用它，preload 让下载与阻塞 CSS 解析并行）。
 * ⚠️ 只 preload 这一个文件：CJK 分包走上面那份异步 CSS，preload 它们反而抢首屏带宽；
 * 默认皮肤（uiStyle=default）不引用 Maple Mono，Layout 里按皮肤开关决定是否输出。
 */
export const APPLE_FONT_LATIN_WOFF2 = "/fonts/maple-mono-latin-400-normal.woff2";

/**
 * 需要提前建连的字体源（只在皮肤开启时输出）。
 * ⚠️ cdn.jsdelivr.net 已移除：拉丁子集自托管后，前台代码不再从 jsDelivr 取任何字节，
 * 留着它等于每个 apple 皮肤页面白建一条跨域连接（preconnect 不免费）。
 */
export const APPLE_FONT_PRECONNECT_HOSTS = ["https://static.zeoseven.com"];
