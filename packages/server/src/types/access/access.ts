export type LimitPermission =
  | 'article:create'
  | 'article:delete'
  | 'article:update'
  | 'draft:publish'
  | 'draft:create'
  | 'draft:delete'
  | 'draft:update'
  | 'img:delete'
  | 'img:replace'
  | 'file:delete';

export type Permission = LimitPermission | 'all';

export const permissionPathMap: Record<LimitPermission, string> = {
  'article:create': 'post-/api/admin/article',
  'article:delete': 'delete-/api/admin/article/:id',
  'article:update': 'put-/api/admin/article/:id',
  'draft:create': 'post-/api/admin/draft',
  'draft:publish': 'post-/api/admin/draft/publish',
  'draft:delete': 'delete-/api/admin/draft/:id',
  'draft:update': 'put-/api/admin/draft/:id',
  'img:delete': 'delete-/api/admin/img/:sign',
  'img:replace': 'post-/api/admin/img/:sign/replace',
  'file:delete': 'delete-/api/admin/file/:sign',
};

export const pathPermissionMap: Record<string, LimitPermission> = {
  'post-/api/admin/article': 'article:create',
  'delete-/api/admin/article/:id': 'article:delete',
  'put-/api/admin/article/:id': 'article:update',
  // P3 回收站：恢复是"改文章"（article:update 档），彻底删除与既有软删同权限档
  // （任务要求：purge 用 existing delete 的同一权限 = article:delete）。
  'put-/api/admin/article/:id/restore': 'article:update',
  'delete-/api/admin/article/:id/purge': 'article:delete',
  // P4 历史版本：还原本质是一次内容更新，走 article:update 档
  'put-/api/admin/article/:id/revisions/:revisionId/restore': 'article:update',
  'post-/api/admin/draft/publish': 'draft:publish',
  'post-/api/admin/draft': 'draft:create',
  'delete-/api/admin/draft/:id': 'draft:delete',
  'put-/api/admin/draft/:id/restore': 'draft:update',
  'delete-/api/admin/draft/:id/purge': 'draft:delete',
  'put-/api/admin/draft/:id': 'draft:update',
  'delete-/api/admin/img/:sign': 'img:delete',
  'post-/api/admin/img/:sign/replace': 'img:replace',
  'delete-/api/admin/file/:sign': 'file:delete',
};

/**
 * 带权限要求的 method-path 键集合。
 * ⚠️ 从 pathPermissionMap 的 **keys** 派生（历史上是 Object.values(permissionPathMap)，
 * 两张表当时互为镜像，结果集相同）；permissionPathMap 一个权限只挂一条代表路径，
 * 同一权限有多条路径时（restore/purge/revisions-restore）必须由这张表派生才拦得住。
 */
export const permissionRoutes = Object.keys(pathPermissionMap);

/**
 * ## 只有**超管**能碰的路由前缀（`'all'` 权限也不例外）
 *
 * 为什么需要这张表：`AccessGuard` 以前是 `if (permissions.includes('all')) return true;`，
 * 而后台「协作者 → 权限」里就有一个叫「所有权限」的普通勾选项。于是勾了它的协作者
 * **等价于超管**，具体能做的事（都不是理论推演，逐条对过路由与实现）：
 *
 *  - `PUT /api/admin/auth`：直接改掉 `id:0` 管理员的用户名与口令；
 *  - `/api/admin/token/**`：签发 API Token，而它签的是 `{sub:0, role:'admin'}`
 *    （`token.provider.ts` 的 `createAPIToken`），`AccessGuard` 见到 `id===0` 无条件放行
 *    ⇒ **一枚永久有效的超管凭证**；
 *  - `/api/admin/backup/full/**`：下载整站备份 —— 里面有全部口令的 scrypt 哈希，
 *    以及 `settings{type:'jwt'}` 里的 **jwt 签名密钥**（拿到它就能自己签任意身份的 token）；
 *  - `/api/admin/pipeline/**`：流水线 = 把代码写进 `codeRunner` 目录再 `fork()` 执行，
 *    子进程继承 `process.env` 且容器内是 root ⇒ **远程代码执行**；
 *  - `/api/admin/collaborator/**`：改自己或别人的权限 ⇒ 自我提权；
 *  - `/api/admin/setting/**`：含 `layout`（`css`/`html`/`head`/`script`，前台**原样注入**每个页面
 *    ⇒ 全站任意 JS）、`static`（对象存储凭据）、`waline`（评论库凭据）、`login`（防爆破开关）；
 *  - `/api/admin/caddy/**`：改反向代理与证书（能把 `/admin` 指到别处、或关掉 TLS 强制跳转）。
 *
 * 所以这张表里的前缀**只认 `user.id === 0`**（API Token 本来就是 `sub:0`，不受影响）。
 *
 * ⚠️ 这是**行为变化**：现有勾了「所有权限」的协作者会少掉上面这些能力。
 * 他们仍然能做的（刻意保留，否则 `'all'` 就没意义了）：文章、草稿、图片、附件、评论、
 * 分类与标签、导航/友链/社交/捐赠等 meta、自定义页面、主题、统计分析、导出 markdown、ISR 手动触发。
 *
 * ⚠️ 顺序很关键：`AccessGuard` 先查 `publicRoutes` 再查这张表，所以
 * `get-/api/admin/collaborator/list`（在 publicRoutes 里，只返回 id/name/nickname）
 * 对协作者仍然开放 —— 后台的协作者下拉框靠它。别把这张表的判定挪到 publicRoutes 之前。
 */
export const SUPER_ADMIN_ONLY_ROUTE_PREFIXES: readonly string[] = [
  '/api/admin/auth',
  '/api/admin/token',
  '/api/admin/backup',
  '/api/admin/pipeline',
  '/api/admin/collaborator',
  '/api/admin/setting',
  '/api/admin/caddy',
];

/**
 * 归一化路由路径：去掉查询串与**尾部**斜杠。
 * ⚠️ 必须做：`@Controller('/api/admin/auth/')` + `@Put()` 生成的 route path 带尾斜杠，
 * 而表里写的是不带尾斜杠的前缀 —— 不做归一化就会漏掉最要命的那条（改管理员口令）。
 */
export function normalizeRoutePath(path: unknown): string {
  const raw = typeof path === 'string' ? path : '';
  const withoutQuery = raw.split('?')[0];
  // 只去掉尾部斜杠，保留根路径 '/' 本身
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
}

/** 这条路由是否属于"只有超管能碰"那一类（按前缀，`/api/admin/settingX` 不会被误判）。 */
export function isSuperAdminOnlyRoute(path: unknown): boolean {
  const p = normalizeRoutePath(path);
  if (!p) {
    return false;
  }
  return SUPER_ADMIN_ONLY_ROUTE_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/**
 * 是不是超管。
 * ⚠️ 不用 `user.id == 0` 这种松散比较：`null == 0` 是 false 没错，但 `'' == 0` 与 `[] == 0`
 * 都是 **true**，而 id 来自 jwt payload 的 `sub`（经过 JSON 往返），形状不完全可控。
 * 这里只接受 number 与 string 两种形态，且必须是整数 0 —— "看不懂就当不是超管"。
 */
export function isSuperAdminUser(user: any): boolean {
  const raw = user?.id;
  // 数字：必须是整数 0（`Number.isInteger` 顺带挡掉 NaN / Infinity / 小数）
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw === 0;
  }
  // 字符串：只认**字面就是 "0"**（不去空白、不接受 "00"/"0x0"/" 0 "）。
  // ⚠️ 不能用 `Number(raw) === 0`：`Number(' 0 ')`、`Number('00')`、`Number('0x0')` 都等于 0，
  //    而"能转成 0"与"就是 0"是两件事 —— 判定身份的代码应该只接受最严格的那一种写法，
  //    看不懂就当不是超管（fail closed）。我们自己签的 token 里 `sub` 是数字 0，
  //    所以严格化不会影响任何合法调用方。
  if (typeof raw === 'string') {
    return raw === '0';
  }
  // 其它类型（null / undefined / boolean / 数组 / 对象）一律不是超管。
  // ⚠️ 特别是数组：`[] == 0` 在松散比较下是 true。
  return false;
}

/** 合法的权限取值集合（`pickPermissions` 用它收口，未知字符串一律丢弃）。 */
export const ALL_PERMISSION_VALUES: readonly string[] = Array.from(
  new Set<string>([
    ...(Object.keys(pathPermissionMap) as string[]).map((key) => pathPermissionMap[key]),
    'all',
  ]),
);


export const publicRoutes = [
  'get-/api/admin/meta',
  'post-/api/admin/auth/login',
  'post-/api/admin/auth/logout',
  'get-/api/admin/article',
  'get-/api/admin/draft',
  'get-/api/admin/category/all',
  'get-/api/admin/tag/all',
  'get-/api/admin/article/:id',
  'get-/api/admin/draft/:id',
  'get-/api/admin/img/all',
  'get-/api/admin/img',
  'get-/api/admin/file/all',
  'get-/api/admin/file',
  'post-/api/admin/file/upload',
  'get-/api/admin/collaborator/list',
  'post-/api/admin/img/upload',
  // 只读：批量查图片被哪些文章引用（列表视图用）
  'post-/api/admin/img/references',
  // 只读：检测图片里的隐写水印（协作者也能用来验图）
  'post-/api/admin/img/stego/detect',
  'post-/api/admin/article/searchByLink',
  // 只读：导出文章/草稿为 Markdown（含图片打包），协作者本来就能读这些内容
  'post-/api/admin/export/markdown',
  // 只读：回收站列表（P3）。协作者本来就能读文章/草稿列表（上面两条 get-），
  // 软删列表不含 content，泄露面不大于既有列表接口。
  'get-/api/admin/article/deleted',
  'get-/api/admin/draft/deleted',
  // 只读：历史版本列表与单条（P4）。协作者有 article:update（能读能改正文），
  // 读历史版本没有额外授权；**还原**是写操作，走 pathPermissionMap 的 article:update 档。
  'get-/api/admin/article/:id/revisions',
  'get-/api/admin/article/:id/revisions/:revisionId',
];
