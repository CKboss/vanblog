import { tagHue } from "./tagColor";

/**
 * 没有图的文章用「渐变占位封面」：色相由**标题**哈希得到（同一篇文章永远同一个颜色），
 * 纯 CSS 渐变，**零网络请求**。
 *
 * 为什么是抽象渐变而不是标题首字：中文标题取一个字既没有语义、看上去又像乱码，
 * 而且标题就印在封面旁边，再写一遍是冗余。Apple 自己的占位图也是抽象渐变，不是字母。
 *
 * 为了让相邻卡片不至于"只有色相不同、构图完全一样"，另外用标题哈希出**两个光斑的位置**
 * （见 coverOrbs），所以每篇的渐变构图也略有差别，但同一篇永远稳定。
 */

/** 与标签胶囊共用同一套哈希（utils/tagColor.ts），保证「同名同色」的规则一致 */
export function coverHue(title: string): number {
  return tagHue(String(title ?? ""));
}

function seededHash(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return h;
}

export interface CoverOrbs {
  /** 两个光斑的中心位置，单位是百分比（相对封面宽高） */
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** 由标题稳定地推出两个光斑的位置：一个偏左上、一个偏右下，范围受限以免跑出画面 */
export function coverOrbs(title: string): CoverOrbs {
  const text = String(title ?? "");
  const a = seededHash(text, 7);
  const b = seededHash(text, 91);
  return {
    ax: 10 + (a % 38), // 10% ~ 47%
    ay: 6 + (Math.floor(a / 38) % 40), // 6% ~ 45%
    bx: 54 + (b % 40), // 54% ~ 93%
    by: 22 + (Math.floor(b / 40) % 56), // 22% ~ 77%
  };
}

/** 以 CSS 变量下发（深浅两套配色都写在 CSS 里，内联样式做不了暗色适配） */
export function coverStyle(title: string): React.CSSProperties {
  const orbs = coverOrbs(title);
  return {
    ["--chip-h" as any]: String(coverHue(title)),
    ["--orb-ax" as any]: `${orbs.ax}%`,
    ["--orb-ay" as any]: `${orbs.ay}%`,
    ["--orb-bx" as any]: `${orbs.bx}%`,
    ["--orb-by" as any]: `${orbs.by}%`,
  };
}
