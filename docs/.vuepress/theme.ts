import { getDirname, path } from '@vuepress/utils';
import { hopeTheme } from 'vuepress-theme-hope';

const __dirname = getDirname(import.meta.url);

export default hopeTheme({
  hostname: 'https://vanblog.mereith.com',

  // ⚠️ 这三个值决定每页底部「编辑此页」链接指向哪里：必须指向**本仓库**与**本分支**。
  //    以前写的是上游的 `Mereithhh/vanblog` + `master`，生成的链接形如
  //    https://github.com/Mereithhh/vanblog/edit/master/docs/… —— 读者点进去要么 404，
  //    要么改到别人仓库去（本 fork 的文档改动永远提不上来）。
  docsRepo: 'CKboss/vanblog',
  docsBranch: 'dev/dsh',
  docsDir: 'docs',
  author: {
    name: 'Mereith',
    url: 'https://www.mereith.com',
  },

  darkmode: 'switch',
  iconAssets: 'fontawesome-with-brands',

  logo: '/logo.svg',

  // 右上角那个仓库图标/链接：本 fork 自己的仓库（原来写的是上游旧名 `Mereithhh/van-blog`，
  // 连仓库名都是旧的 —— 上游现在叫 `Mereithhh/vanblog`，而这里本该指向本仓库）
  repo: 'CKboss/vanblog',

  // navbar
  navbar: [
    '/intro',
    '/guide/get-started',
    {
      text: '速查表',
      icon: 'fas fa-terminal',
      link: '/guide/cheatsheet.html',
    },
    '/features/',
    '/faq/',
    {
      text: 'API',
      icon: 'fas fa-book',
      // ⚠️ 指向本站内的 API 参考页，不是任何人的演示站 /swagger：
      //    本项目 `/swagger` 默认是**关闭**的（要 VANBLOG_SWAGGER=true 才开），
      //    把导航指过去等于给读者一个大概率 404 的链接。
      link: '/reference/api.html',
    },
  ],

  sidebar: 'structure',

  footer: 'GPL-3.0 协议',

  displayFooter: true,

  pageInfo: ['Author', 'Original', 'Date', 'Category', 'Tag', 'ReadingTime'],

  plugins: {
    // ⚠️ 这里原来配的是 Giscus，repo 指向 `mereithhh/vanblog-comment`（**上游作者**的讨论仓库）。
    // 本 fork 没有开 GitHub Discussions（实测 `has_discussions: false`），也没有部署文档站
    // （GitHub Pages 404），所以它一直是空转的；可一旦哪天把文档站部署出去，
    // 读者的评论就会全部落到上游作者的仓库里 —— 那是把我们的读者送去别人家。
    // 要恢复评论功能：先在 CKboss/vanblog 开 Discussions、装 giscus App，
    // 再把 provider/repo/repoId/category/categoryId 填成本仓库的值（四个 ID 都能从 giscus 配置页拿到）。
    //
    // ⚠️ 另一处待站长裁定：文件开头的 `hostname` 仍是上游文档站 `https://vanblog.mereith.com`，
    // 它决定 sitemap 与每页 `og:url`/canonical。本 fork 没部署文档站，所以现在无实际影响；
    // 真要部署时必须先改成自己的域名，否则每页的规范地址都指向上游。

    mdEnhance: {
      align: true,
      codetabs: true,
      figure: true,
      imgLazyload: true,
      imgSize: true,
      include: {
        deep: true,
        resolvePath: (filePath, cwd) => {
          if (filePath.startsWith('@'))
            return filePath.replace('@', path.resolve(__dirname, '../'));

          return path.resolve(cwd, filePath);
        },
      },
      tabs: true,
      tasklist: true,
    },
  },
});
