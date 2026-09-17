export interface Article {
  content: string;
  category: string;
  tags: string[];
  createdAt: string;
  title: string;
  updatedAt: string;
  id: number;
  top?: number;
  private: boolean;
  author?: string;
  copyright?: string;
  pathname?: string;
  cover?: string;
  /**
   * 服务端算好的列表摘要（列表请求带 withExcerpt 时下发，此时 content 不再进
   * __NEXT_DATA__ —— 实测首页 5 篇正文 25,053 B、摘要只要 3,263 B，87% 白送）。
   * 语义与 utils/articleExcerpt.ts 逐字符一致，由 __tests__/articleExcerptParity.spec.ts 钉住；
   * 老缓存页没有这个字段，PostCard 会回退到本地计算。
   */
  excerpt?: string;
  /** 正文里文档顺序的第一张可用图（卡片缩略图兜底；cover 仍优先）。同上，可能缺失。 */
  firstImage?: string;
  /**
   * 阅读量。列表接口与文章接口都会下发（server 用原子 `$inc` 维护，是唯一权威值）。
   * 卡片上的阅读量直接用它播种，首帧就是真数字，不必再发
   * `GET /api/public/article/viewer/:id`（那个接口读的是**按 pathname 分家**的
   * visit 台账，拼音别名启用后比这个值小得多，见 utils/viewerApi.ts 顶部）。
   */
  viewer?: number;
  /** 访问次数（同上，前台暂时不显示） */
  visited?: number;
  /**
   * 服务端算好的阅读时间（分钟，整数 ≥ 1）。列表（toListView）与详情 payload 都会带。
   * 可选契约：server 未实现 / 旧 ISR 缓存页没有它时 UI 什么都不渲染
   * （见 utils/readingTime.ts —— 不做客户端兜底计算，列表响应里根本没有 content）。
   */
  readingMinutes?: number | null;
  /**
   * 缩略图的 AVIF 版本（可选契约，server `VANBLOG_THUMB_AVIF` 默认关）。
   * ⚠️ server 最终契约嵌在 **`meta.thumbAvif`**；顶层字段保留为兼容位。
   * 统一经 `utils/firstImage.articleThumbAvif()` 读取（两个位置都认，meta 优先），
   * 缺失时 ListThumb 的渲染输出与没有这个契约时逐字节一致（金标对照测试钉住）。
   */
  thumbAvif?: string | null;
  /** server 静态项的 meta 子对象（AVIF 契约的最终位置，见上） */
  meta?: {
    thumbAvif?: string | null;
    thumbAvifBytes?: number | null;
  } | null;
}
