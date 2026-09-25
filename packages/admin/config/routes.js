/**
 * 🔴 多语言第二期第一块：**侧边栏菜单国际化**。
 *
 * ## 做法：保留中文 `name`，另加显式 `locale` —— 而不是把 `name` 改成 key
 *
 * 权威实现是 `@umijs/route-utils` 的 `transformRoute`（由 `@ant-design/pro-layout`
 * 的 `utils/getMenuData` 引入），关键三行：
 *
 *     const getItemLocaleName = (item, parentName) => {
 *       const { name, locale } = item;
 *       if (('locale' in item && locale === false) || !name) return false;
 *       return item.locale || `${parentName}.${name}`;   // ← 显式 locale 优先
 *     };
 *     formatMessage({ id: locale, defaultMessage: name }) // ← 回落值永远是 name
 *     finallyItem.name = localeName;                      // ← 菜单渲染的是译文
 *     // 子路由：parentName = 父的 locale
 *
 * `pro-layout` 的 `getPageTitle` 与 `SiderMenu/BaseMenu.getIntlName` 也是同一口径
 * （都用 `item.locale` + `defaultMessage: item.name`）⇒ **侧边栏、面包屑、页面标题
 * 三者一起被翻译，不需要各改一处**。
 *
 * 🔴 **所以 `name` 必须保持中文显示文本**，这有两个作用：
 *   ① **回落方向正确**：某个 `menu.*` 漏翻译时，用户看到的是中文（与改动前完全一样），
 *      而不是裸 key（若把 `name` 改成 key，漏翻译就会在菜单上显示 `article` 这种原文）；
 *   ② 🔴 **任何直接读 `name` 的消费方零影响**（面包屑、`document.title`，以及
 *      `tests/unit/attachmentManage.test.js` 里那两条按文本匹配「附件管理」路由的断言）。
 *      ⚠️ 本注释**刻意不逐字引用那两条断言的搜索串**：该测试用 `indexOf` 比较「图片管理」与
 *      「附件管理」两个路由谁在前，而 `indexOf` 取的是**最早出现**的位置 ⇒ 注释里一旦出现同样的
 *      字面量，比较基准就被抢到注释里、断言会假红（写这段说明时真的踩过一次）。
 *      🔴 这正是本仓库记过多次的那条规矩：**注释里不要写别处要搜索或断言的字面量**。
 * 👉 这条前提由 `tests/unit/localePackParity.test.js` 的
 *    「routes.js 的 name 必须仍是中文显示文本」那条断言钉住 —— 🔴 **它钉的不是文案，
 *    而是本方案的安全前提**：将来谁把 `name` 改成 key，那条会红。
 *    ⚠️ 第二期不要把它当成"菜单还是中文"的障碍删掉。
 *
 * ⚠️ 嵌套默认 key 是 `menu.<父name>.<子name>`（中文拼进 key）⇒ 这里**每一处都显式写
 * `locale`**，不依赖拼接，key 因此稳定、可读、与语言无关。
 */
export default [
  {
    path: '/user',
    layout: false,
    // 🔴 这两条必须显式写 `locale: false`（2026-09-25 浏览器实测后更正）。
    //
    // ⚠️ **此前这里的注释说的是"刻意不加 locale，因为 layout:false 的子树不经过 ProLayout、
    //    加了也是死条目"—— 那个推理是不完整的，实测推翻了它。**
    // 🔴 实测：不加任何东西时，`transformRoute` 仍然会为**整棵路由树**（含 layout:false 的路由）
    //    计算 `locale = item.locale || 'menu.' + name` 并调用 `formatMessage`，
    //    于是浏览器控制台出现 **48 条 `[React Intl] Missing message`**：
    //    `menu.登录`（36 次）与 `menu.忘记密码`（12 次）—— 因为语言包里没有这两个 key
    //    （它们本来也不该有：这两页不是菜单项）。
    // 🔴 **正确做法就是权威实现里那个逃生口**：
    //    `if (('locale' in item && locale === false) || !name) return false;`
    //    ⇒ 显式写 `locale: false` 后 `getItemLocaleName` 返回 false，**根本不会调用 formatMessage**，
    //    48 条报错消失，而且**语言包里不需要任何 menu.* 死条目**（反向断言仍然成立）。
    // ⚠️ 父路由 `/user` 本身**没有 name** ⇒ 它已经由 `|| !name` 那一支返回 false，不需要写。
    // 🔴 这两页自己的文案由第一期加的 <SelectLang /> 与 login.* 语言包覆盖。
    routes: [
      { name: '登录', path: '/user/login', component: './user/Login', locale: false },
      { name: '忘记密码', path: '/user/restore', component: './user/Restore', locale: false },
      { component: './404' },
    ],
  },
  { path: '/init', layout: false, component: './InitPage' },
  {
    path: '/welcome',
    name: '分析概览',
    locale: 'menu.welcome',
    icon: 'smile',
    component: './Welcome',
    access: 'isAdmin',
  },
  {
    name: '文章管理',
    locale: 'menu.article',
    icon: 'form',
    path: '/article',
    component: './Article',
  },
  {
    name: '图形编辑器',
    locale: 'menu.editor',
    icon: 'form',
    path: '/editor',
    component: './Editor',
    hideInMenu: true,
  },
  {
    name: '代码编辑器',
    locale: 'menu.code',
    icon: 'tool',
    path: '/code',
    component: './Code',
    hideInMenu: true,
    access: 'isAdmin',
  },
  {
    name: '关于',
    locale: 'menu.about',
    icon: 'form',
    path: '/about',
    component: './About',
    hideInMenu: true,
  },
  {
    name: '草稿管理',
    locale: 'menu.draft',
    icon: 'container',
    path: '/draft',
    component: './Draft',
  },
  {
    name: '图片管理',
    locale: 'menu.img',
    icon: 'picture',
    path: '/static/img',
    hideInBreadcrumb: true,
    component: './Static/img',
  },
  {
    name: '附件管理',
    locale: 'menu.file',
    // 必须写 paper-clip：umi 的 icon 解析是 toHump(首字母大写) + 'Outlined'，
    // 'paperclip' 会拼出不存在的 PaperclipOutlined，菜单里就会显示成纯文本。
    icon: 'paper-clip',
    path: '/static/file',
    hideInBreadcrumb: true,
    component: './Static/file',
  },
  {
    name: '站点管理',
    locale: 'menu.site',
    icon: 'tool',
    path: '/site',
    hideInBreadcrumb: true,
    access: 'isAdmin',
    routes: [
      {
        name: '数据管理',
        locale: 'menu.site.data',
        path: '/site/data',
        component: './DataManage',
      },
      {
        name: '评论管理',
        locale: 'menu.site.comment',
        path: '/site/comment',
        component: './CommentManage',
      },
      {
        name: '流水线',
        locale: 'menu.site.pipeline',
        path: '/site/pipeline',
        component: './Pipeline',
      },
      {
        name: '系统设置',
        locale: 'menu.site.setting',
        path: '/site/setting',
        component: './SystemConfig',
      },
      {
        name: '自定义页面',
        locale: 'menu.site.customPage',
        path: '/site/customPage',
        component: './CustomPage',
      },
      {
        name: '日志管理',
        locale: 'menu.site.log',
        path: '/site/log',
        component: './LogManage',
      },
    ],
  },
  { path: '/', redirect: '/article' },
  { component: './404' },
];
