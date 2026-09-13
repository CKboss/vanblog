/**
 * 给标签算一个**稳定**的色相：同名标签在任何页面、任何一次渲染都是同一个颜色。
 * 列表页原本只有黑/灰/白，加一点低饱和的彩色胶囊是让它不那么单调最便宜的办法
 * （Apple 的做法也是「大面积中性色 + 少量柔和彩色」，不是到处涂颜色）。
 */
export function tagHue(tag: string): number {
  const text = String(tag ?? "");
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) % 360;
  }
  return h;
}

/** 以 CSS 自定义属性的形式给出，深浅色两套配色都写在 CSS 里（内联样式做不了暗色适配） */
export function tagChipStyle(tag: string): React.CSSProperties {
  return { ["--chip-h" as any]: String(tagHue(tag)) };
}
