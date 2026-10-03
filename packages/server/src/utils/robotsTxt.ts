/**
 * robots.txt 的生成与净化（**纯函数**，控制器与写入侧共用同一份口径）。
 *
 * 为什么要抽出来：`robots.txt` 是**匿名可达**的（爬虫不需要登录），而它的内容现在可以由站长在后台改。
 * 于是同一个字符串会经过两条路径 —— ①后台保存（写入侧）②爬虫请求（读出侧）。
 * 🔴 两条路径必须**同一份净化口径**，否则会出现"后台看到的与爬虫拿到的不一样"这种最难查的漂移
 * （本仓库在 `siteInfo` 的三段页面文案上吃过一次：写入侧净化、读侧原样透传，靠注释才说清）。
 *
 * 设计取舍（都有守卫钉住，见 `robotsTxt.spec.ts`）：
 * - **默认必须"开放收录"**：`User-agent: *` + `Allow: /`，只挡接口/后台/文档/临时目录。
 *   🔴 刻意**不**写 `Crawl-delay`（它会拖慢收录，而本站没有需要保护带宽的动态页面），
 *   也刻意**不**默认 `Disallow: /`（那是"从搜索引擎消失"，与站长的意图相反）。
 * - **站长写了自定义内容就完全以他为准**（哪怕内容是"全站禁止收录"）——
 *   这是站长的裁定，代码不该替他改主意；只在**他没写 Sitemap 行**时补一条
 *   （因为 `Sitemap:` 必须是绝对 URL，而只有服务端知道站点域名 ⇒ 这正是动态生成的理由）。
 * - **长度上限**是防"把 robots.txt 当网盘"的兜底：爬虫（含 Google）对超大 robots.txt 会直接判无效，
 *   所以超限**按行截断**而不是报错（报错会让爬虫拿到 500，比截断更糟）。
 */

/** robots.txt 的字节上限。Google 的实际上限是 500 KiB，这里取一个远低于它的值当兜底。 */
export const ROBOTS_TXT_MAX_BYTES = 16 * 1024;

/** 默认要挡住的路径（顺序即输出顺序）。⚠️ 加新路径前先确认它确实不该被收录。 */
export const DEFAULT_ROBOTS_DISALLOW: readonly string[] = [
  '/api/', // 所有接口（含后台 API 面）
  '/admin/',
  '/admin',
  '/swagger', // 后台 API 的交互文档
  '/swagger-json',
  '/static/export/', // 导出归档（有鉴权，但没必要让爬虫去撞）
  '/static/tmp/',
  '/static/upload-tmp/',
] as const;

/**
 * 把站点 URL 规整成"可以拼 `/sitemap.xml` 的绝对前缀"。
 *
 * 🔴 不合法（空、没有 host、只是几个字）时返回 `''`，**不要**返回 `https://`：
 * `washUrl('')` 会给没有协议的字符串补 `https://`，直接用就会写出
 * `Sitemap: https:///sitemap.xml` 这种垃圾行（爬虫会当无效文件）。
 */
export function normalizeRobotsBaseUrl(rawBaseUrl: unknown, washUrl: (s: string) => string): string {
  let base = '';
  try {
    base = washUrl(typeof rawBaseUrl === 'string' ? rawBaseUrl : '').replace(/\/+$/, '');
  } catch {
    base = '';
  }
  return /^https?:\/\/[^/\s]/i.test(base) ? base : '';
}

/**
 * 净化 robots.txt 文本（写入侧与读出侧都调它）。
 *
 * - 不是字符串 ⇒ 用 `fallback`（"库里躺着脏数据"不该让爬虫拿到 500）；
 * - 🔴 去掉 `\r`、NUL 与其它控制字符（只留 `\n` 与 `\t`）：文本会被原样写进 HTTP 响应体，
 *   `\r\n` 混进去会让某些爬虫把一行读成两行（`\r` 还可能被当成路径的一部分）；
 * - 去掉行尾空白与末尾多余空行（输出时统一补**一个** `\n`）；
 * - 🔴 超过 {@link ROBOTS_TXT_MAX_BYTES} 时**按行截断**（不切断半行：半行会被爬虫当成一条残缺规则）。
 *
 * @param raw     来自后台表单的原始值（可能是 undefined / null / 数字 / 对象）
 * @param fallback raw 不可用时回落的值（写入侧传库里的旧值 ⇒ "存不进新值就保持原样"）
 */
export function sanitizeRobotsTxt(raw: unknown, fallback = ''): string {
  if (typeof raw !== 'string') {
    return typeof fallback === 'string' ? fallback : '';
  }
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const lines = cleaned
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  // 🔴 按行截断：从后往前丢整行，直到不超限
  while (lines.length > 0 && Buffer.byteLength(lines.join('\n'), 'utf8') > ROBOTS_TXT_MAX_BYTES) {
    lines.pop();
  }
  return lines.join('\n');
}

/**
 * 生成**默认**的 robots.txt 正文（不含结尾换行）。
 *
 * 🔴 这份默认的立场是"**开放收录**"：`Allow: /` 明确写出"整站可抓"，
 * 后面的 `Disallow:` 只挡接口/后台/文档/临时目录。
 * ⚠️ robots.txt 的规则是**最长路径前缀优先**，所以 `Allow: /` 不会让 `/api/` 重新变得可抓
 * （本文件本来就依赖这条规则：`Allow: /static/` 与 `Disallow: /static/export/` 同时存在）。
 *
 * @param baseUrl 已规整的站点绝对前缀（`''` 表示未配置 ⇒ 写一条说明注释，不写错误的 Sitemap 行）
 */
export function buildDefaultRobotsTxt(baseUrl: string): string {
  const lines = [
    '# 由 VanBlog 生成；后台「站点设置 → 高级设置 → robots.txt」可以整份替换这份默认内容',
    '# 默认立场是开放收录：只挡接口、后台、API 文档与临时目录，其余全部允许抓取',
    'User-agent: *',
    'Allow: /',
    ...DEFAULT_ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`),
    'Allow: /static/',
    '',
  ];
  if (baseUrl) {
    lines.push(`Sitemap: ${baseUrl}/sitemap.xml`);
  } else {
    lines.push('# Sitemap: 未配置站点 URL（后台「站点设置 → 网站 URL」），填好后这里会自动出现');
  }
  return lines.join('\n');
}

/** 自定义内容里"已经写了 Sitemap 行"的判定（大小写不敏感，允许行首空白）。 */
const HAS_SITEMAP_LINE = /^[ \t]*sitemap[ \t]*:/im;

/**
 * 组装最终要下发的 robots.txt 正文（**含**结尾换行）。
 *
 * - 站长写了自定义内容 ⇒ **完全以他为准**（哪怕他写的是"全站禁止收录"，那是他的裁定）；
 *   只在他**没写 Sitemap 行**且站点 URL 已配置时补一条（🔴 不覆盖他写的 Sitemap）。
 * - 没写（空串/只有空白/字段缺失）⇒ 用 {@link buildDefaultRobotsTxt} 的默认内容。
 *
 * @returns `body` 是要下发的完整文本；`custom` 表示这次用的是站长自定义内容（守卫/测试用来区分两条路径）
 */
export function buildRobotsTxt(
  siteInfo: { baseUrl?: unknown; robotsTxt?: unknown } | null | undefined,
  washUrl: (s: string) => string,
): { body: string; custom: boolean } {
  const base = normalizeRobotsBaseUrl(siteInfo?.baseUrl, washUrl);
  const custom = sanitizeRobotsTxt(siteInfo?.robotsTxt, '');
  if (custom === '') {
    return { body: buildDefaultRobotsTxt(base) + '\n', custom: false };
  }
  const lines = [custom];
  if (base && !HAS_SITEMAP_LINE.test(custom)) {
    // 前面 sanitize 已经去掉了末尾空行 ⇒ 这里补一个空行再补 Sitemap，视觉上与默认那份一致
    lines.push('', `Sitemap: ${base}/sitemap.xml`);
  }
  return { body: lines.join('\n') + '\n', custom: true };
}
