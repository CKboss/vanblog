/** @type {import('next').NextConfig} */
const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});
const isDev = process.env.NODE_ENV == "development";
const rewites =
  process.env.NODE_ENV == "development"
    ? {
        async rewrites() {
          return [
            {
              source: "/api/comment",
              destination: "http://127.0.0.1:8360/comment", // Proxy to Backend
            },
            {
              source: "/api/:path*",
              destination: "http://127.0.0.1:3000/api/:path*", // Proxy to Backend
            },
            {
              // robots.txt 由 server 动态生成（Sitemap: 必须是绝对 URL，静态文件不知道域名）
              source: "/robots.txt",
              destination: "http://127.0.0.1:3000/robots.txt",
            },
            {
              // sitemap 同理：server 生成到 <static>/sitemap/sitemap.xml，
              // 生产环境由 caddy 把 /sitemap.xml 重写到 /sitemap/sitemap.xml
              source: "/sitemap.xml",
              destination: "http://127.0.0.1:3000/static/sitemap/sitemap.xml",
            },
          ];
        },
      }
    : {};

const getAllowDomains = () => {
  const domainsInEnv = process.env.VAN_BLOG_ALLOW_DOMAINS || "";
  if (domainsInEnv && domainsInEnv != "") {
    const arr = domainsInEnv.split(",");
    return arr;
  } else {
    if (isDev) {
      return ["pic.mereith.com",'localhost','127.0.0.1'];
    }
    return [];
  }
};
// Next 14 起 images.domains 已弃用，改用 images.remotePatterns。
// 只写 hostname（不写 protocol/port/pathname）= 三者全放行，与旧 domains 的
// 匹配语义逐项等价（domains 也是"任意协议、任意端口、任意路径"）。
// ⚠️ 空数组的语义必须保留：VAN_BLOG_ALLOW_DOMAINS 为空 ⇒ 生产构建只优化本站图片
// （AGENTS §7.38 的刻意收紧），不是"允许所有远程域名"。
const getImageRemotePatterns = () =>
  getAllowDomains().map((hostname) => ({ hostname }));
const getCdnUrl = () => {
  if (isDev) {
    return {};
  }
  const UrlInEnv = (process.env.VAN_BLOG_CDN_URL || "").trim().replace(/\/+$/, "");
  if (UrlInEnv) {
    return { assetPrefix: UrlInEnv };
  } else {
    return {};
  }
};
const adminNoStoreHeaders = [
  {
    key: "Cache-Control",
    value: "private, no-store, no-cache, must-revalidate",
  },
  { key: "CDN-Cache-Control", value: "no-store" },
  { key: "Cloudflare-CDN-Cache-Control", value: "no-store" },
  { key: "Pragma", value: "no-cache" },
  { key: "Expires", value: "0" },
];

// TS 5.9 之后本包 `tsc --noEmit` 是 0 错误（AGENTS §7.51），所以**生产构建不再跳过
// 类型检查**：skipChecks 只认显式逃生口 VANBLOG_SKIP_TYPECHECK=true（本地量体积用）。
// ⚠️ 以前这里还挂了 `process.env.isBuild === "t"`（官方镜像构建命令带的），等于镜像
// 构建一直在裸奔。isBuild=t 仍然在用，但它管的是 api/getAllData.ts 等「构建期连不上
// server 就用默认数据」的兜底（AGENTS §7.23），跟类型检查无关，别再挂回来。
const skipChecks = process.env.VANBLOG_SKIP_TYPECHECK === "true";

module.exports = withBundleAnalyzer({
  reactStrictMode: true,
  output: "standalone",
  // Next 14 起 swcMinify 默认就是 true（Next 15 里该配置项被移除），无需再写。
  poweredByHeader: false,
  // 类型检查在正式构建里是**开着**的：TS 5.9 之后本包 `tsc --noEmit` 为 0 错误（AGENTS §7.51），
  // 以前 `isBuild=t` 一并跳过类型检查的拐杖已经撤掉；
  // 只保留 VANBLOG_SKIP_TYPECHECK=true 这个显式逃生口（本地量体积时用）。
  typescript: {
    ignoreBuildErrors: skipChecks,
  },
  eslint: {
    // 本包没有 .eslintrc*（仓库的 lint 配置只在 server/admin），`next lint` 只会交互式
    // 提示创建配置，next build 的 lint 步骤没有可执行的配置可跑。
    // 实测（next 14.2.35 源码 dist/lib/eslint/runLintCheck.js:274）：即使设成 false，
    // 无配置时构建也只 warn「No ESLint configuration detected」不会失败，所以这里保持
    // true 只是省掉一条每次构建都出现的无效警告；引入 lint 基线是另一个独立项目。
    ignoreDuringBuilds: true,
  },
  experimental: {
    // Next 13/14 的默认值都是 128KB（14.2.35 的 config-shared.js:127 实测仍是 128*1000，
    // 且构建日志会把它列在 Experiments 里）。以前这里抬到了 10MB（80 倍），
    // 结果是**把唯一会报警的机制关掉了**：列表页把全文塞进 pageProps、
    // /timeline 把没人读的文章数组塞两份，都不会再有任何提示。
    // 256KB 对现有页面绰绰有余（最大的是 /timeline 的 73KB），
    // 再超出去说明有人往 pageProps 里塞了不该塞的东西，那时就该看到构建告警。
    // ⚠️ 这个阈值在 Next 14 仍然真实生效：把副本里的值改成 1KB 重新构建，
    // 4 个页面立刻打出 "exceeds the threshold of 1.02 kB"（A/B 实测，见升级记录）。
    largePageDataBytes: 256 * 1024,
  },
  images: {
    remotePatterns: getImageRemotePatterns(),
  },
  async headers() {
    // Defense in depth if /admin is ever routed to Next.js; public pages stay cacheable.
    return [
      { source: "/admin", headers: adminNoStoreHeaders },
      { source: "/admin/:path*", headers: adminNoStoreHeaders },
    ];
  },
  ...getCdnUrl(),
  ...rewites,
});
