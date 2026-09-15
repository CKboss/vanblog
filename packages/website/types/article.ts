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
}
