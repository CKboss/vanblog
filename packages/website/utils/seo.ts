/**
 * SEO 相关的纯函数与结构化数据（JSON-LD）。
 *
 * 这里的每个函数都必须是**纯函数 + 可单测**的：搜索引擎看到的东西出错很难被发现
 * （页面照常渲染，只是收录/摘要不对），所以要有测试钉住。
 */

/** 把站点 URL 收敛成不带尾斜杠的形式（后台可能填 `https://x.com/`） */
export function normalizeSiteUrl(siteUrl?: string | null): string {
  return String(siteUrl ?? "").trim().replace(/\/+$/, "");
}

/** 站内路径 → 绝对 URL；拿不到站点 URL 时返回相对路径（总比输出错误域名好） */
export function absoluteUrl(siteUrl: string | null | undefined, path: string): string {
  const base = normalizeSiteUrl(siteUrl);
  const target = String(path ?? "");
  if (!target) {
    return base || "/";
  }
  if (/^https?:\/\//i.test(target)) {
    return target;
  }
  if (!base) {
    return target.startsWith("/") ? target : `/${target}`;
  }
  return `${base}${target.startsWith("/") ? "" : "/"}${target}`;
}

/**
 * 规范化一个路径，用来生成 canonical：
 * - 去掉 query 与 hash（`/tag/x?page=2` 之类的分页参数不该产生新的规范地址）
 * - `/index.html`、多余斜杠收敛
 * - `/page/1` 与首页内容完全相同 → 规范到 `/`（否则两份一样的内容互相分权重）
 */
export function canonicalPath(asPath: string | null | undefined): string {
  let path = String(asPath ?? "/").split("?")[0].split("#")[0];
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // 坏的转义就按原样用
  }
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) {
    path = path.replace(/\/+$/, "");
  }
  if (path === "/page/1" || path === "/page/1/") {
    return "/";
  }
  return path || "/";
}

export function canonicalUrl(siteUrl: string | null | undefined, asPath: string | null | undefined): string {
  return absoluteUrl(siteUrl, canonicalPath(asPath));
}

/** JSON-LD 里的日期必须是 ISO 8601；非法值返回 undefined（宁可缺字段，不要写 Invalid Date） */
function isoDate(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export interface ArticleSeoInput {
  title: string;
  description?: string;
  url: string;
  imageUrl?: string;
  datePublished?: unknown;
  dateModified?: unknown;
  authorName?: string;
  category?: string;
  tags?: string[];
  siteName?: string;
  siteUrl?: string;
  logoUrl?: string;
  lang?: string;
}

/** 文章页的 BlogPosting（Google 富结果、百度/必应的摘要都吃这个） */
export function articleJsonLd(input: ArticleSeoInput): Record<string, unknown> {
  const authorName = String(input.authorName ?? "").trim() || String(input.siteName ?? "").trim();
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: String(input.title ?? "").slice(0, 110),
    mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
    inLanguage: input.lang || "zh-CN",
  };
  if (input.description) {
    data.description = String(input.description).slice(0, 300);
  }
  if (input.imageUrl) {
    data.image = [input.imageUrl];
  }
  const published = isoDate(input.datePublished);
  const modified = isoDate(input.dateModified) || published;
  if (published) data.datePublished = published;
  if (modified) data.dateModified = modified;
  if (authorName) {
    data.author = { "@type": "Person", name: authorName };
  }
  if (input.siteName || input.siteUrl) {
    data.publisher = {
      "@type": "Organization",
      name: String(input.siteName ?? authorName ?? ""),
      ...(input.logoUrl ? { logo: { "@type": "ImageObject", url: input.logoUrl } } : {}),
    };
  }
  if (input.category) {
    data.articleSection = [String(input.category)];
  }
  const keywords = (input.tags || []).filter((t) => typeof t === "string" && t.trim());
  if (keywords.length) {
    data.keywords = keywords.join(", ");
  }
  return data;
}

/** 面包屑（文章页：首页 → 分类 → 文章） */
export function breadcrumbJsonLd(
  siteUrl: string | null | undefined,
  items: Array<{ name: string; path?: string }>,
): Record<string, unknown> | null {
  const list = items.filter((item) => item && item.name);
  if (!list.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: list.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      ...(item.path ? { item: absoluteUrl(siteUrl, item.path) } : {}),
    })),
  };
}

/** 首页的 WebSite + Blog（让搜索引擎知道这是一个博客站点、作者是谁） */
export function websiteJsonLd(input: {
  siteName: string;
  siteUrl: string;
  description?: string;
  authorName?: string;
  logoUrl?: string;
  lang?: string;
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": ["WebSite", "Blog"],
    name: String(input.siteName ?? ""),
    url: normalizeSiteUrl(input.siteUrl) || undefined,
    description: input.description ? String(input.description).slice(0, 300) : undefined,
    inLanguage: input.lang || "zh-CN",
    author: input.authorName ? { "@type": "Person", name: String(input.authorName) } : undefined,
    publisher: input.authorName
      ? {
          "@type": "Organization",
          name: String(input.siteName ?? input.authorName),
          ...(input.logoUrl ? { logo: { "@type": "ImageObject", url: input.logoUrl } } : {}),
        }
      : undefined,
  };
}

/** 渲染 JSON-LD：内容必须经过 JSON.stringify（自动转义 `</script>` 之类），不能手工拼字符串 */
export function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}


/**
 * 把 markdown 压成适合放进 meta description 的纯文本。
 * 搜索引擎的摘要不认 markdown 记号，`**加粗**` 会原样显示成星号。
 */
export function toPlainText(markdown: string | null | undefined, maxLength = 160): string {
  let text = String(markdown ?? "");
  if (!text) return "";
  text = text
    .replace(/```[\s\S]*?(```|$)/g, " ") // 围栏代码块整块丢掉
    .replace(/`([^`]*)`/g, "$1") // 行内代码只留内容
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片 → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接 → 文字
    .replace(/<!-- more -->/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // 标题记号
    .replace(/^\s{0,3}>\s?/gm, "") // 引用
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, "") // 列表记号
    .replace(/[*_~]{1,3}/g, "") // 强调/删除线
    .replace(/<[^>]+>/g, " ") // 残留的 HTML 标签
    .replace(/\|/g, " ") // 表格竖线
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  // 截断时尽量落在标点或空格上，别把词切一半
  const cut = text.slice(0, maxLength);
  const at = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return (at > maxLength * 0.6 ? cut.slice(0, at) : cut).trim() + "…";
}
