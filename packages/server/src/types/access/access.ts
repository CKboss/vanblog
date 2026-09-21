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
 * ⚠️ 顺序很关键：`AccessGuard` 先查**引导层 `bootstrapRoutes`** 再查这张表，所以
 * `get-/api/admin/collaborator/list`（在引导层里，只返回 id/name/nickname）
 * 对协作者仍然开放 —— 后台的协作者下拉框靠它。别把这张表的判定挪到 `bootstrapRoutes` 之前。
 * 🔴 2026-09-22 更正措辞：这里以前写的是 `publicRoutes`，而那张表已被拆成
 * "引导层 `bootstrapRoutes`（4 条，在本表之前）"与"免权限档 `publicRoutes`（20 条，在本表**之后**、
 * 且在 `permissions.length == 0` 那道拒绝之后）"⇒ **只有引导层需要排在本表之前**。
 * 免权限档的 20 条里没有一条落在本表的前缀下（已逐条核实），所以把它挪到本表之后是安全的、而且更保守。
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


/**
 * ## ① 引导层（bootstrap）：**零权限协作者也必须能调**的极小集
 *
 * 🔴 2026-09-22 从原 `publicRoutes`（24 条）里拆出来的 4 条。拆分的理由见下面 ② 的注释。
 *
 * 为什么这 4 条必须留在"`permissions.length == 0` 那道拒绝**之前**"：
 *  - `get-/api/admin/collaborator/list`：后台的协作者下拉框靠它。🔴 它落在**超管专属前缀**
 *    `/api/admin/collaborator` 下，所以本层的判定还必须在 `SUPER_ADMIN_ONLY_ROUTE_PREFIXES`
 *    之前 —— 这是 `accessGuard.spec.ts` 里那条"顺序钉子"真正在保护的东西。
 *  - `get-/api/admin/meta`：后台外壳渲染站点信息靠它。零权限协作者登录后如果连外壳都拿不到，
 *    看到的会是一片报错而不是"你没有权限"，无法自助理解现状。
 *  - `post-/api/admin/auth/login` / `post-/api/admin/auth/logout`：⚠️ **实测这两条目前根本到不了
 *    `AccessGuard`** —— `auth.controller.ts` 的 `@Post('/login')` 挂的是
 *    `@UseGuards(LoginGuard, AuthGuard('local'))`、`@Post('/logout')` 挂的是 `@UseGuards(TokenGuard)`，
 *    都**不含** AdminGuard/AccessGuard；而且本守卫第一步就是 `if (!user) return false`，
 *    未认证的 login 本来就过不去。⇒ 这两条是**历史遗留的防御性条目**（vestigial）。
 *    🔴 **刻意保留**：它们无害，而且万一将来有人把 login 挂进 AdminGuard 链，留在引导层才不会把登录搞坏。
 *
 * ⚠️ **宁少勿多**：往这一层加键 = 给零权限协作者开一个能力，必须有明确理由并同步更新守卫。
 */
export const bootstrapRoutes = [
  'get-/api/admin/meta',
  'post-/api/admin/auth/login',
  'post-/api/admin/auth/logout',
  'get-/api/admin/collaborator/list',
];

/**
 * ## ② 免权限档：**只对"至少勾了一项权限"的协作者开放**（原 `publicRoutes` 的其余 20 条）
 *
 * 🔴 **2026-09-22 的安全修复（站长裁定 B′）**：这张表以前和上面那 4 条混在一起，
 * 而 `AccessGuard` 的判定顺序是"**先查本表、后查 `permissions.length == 0` 那道拒绝**"
 * ⇒ **一个权限为空数组的协作者能命中全部 24 条**。后果按严重度：
 *  - 🔴 `get-/api/admin/article/:id` 与 `get-/api/admin/draft/:id` 用的 `adminView` **都投影 `content: 1`**
 *    ⇒ 能读全站文章与草稿正文；
 *  - 🔴 `post-/api/admin/export/markdown` 也在这张表里，而 `markdownExport.provider.ts` 在
 *    `type` 为 `article`/`draft` 时会 `loadDoc(id,…)` **从库里取正文并把图片打包成 zip**
 *    ⇒ **一次请求带走任意一篇的正文与图片**；
 *  - 🔴 `get-/api/admin/article/:id/revisions/:revisionId` 返回**历史版本的完整 `content`**；
 *  - 🔴 `post-/api/admin/img/upload` 与 `post-/api/admin/file/upload` 是**写接口**
 *    ⇒ 零权限协作者能上传图片与附件（⚠️ 磁盘配额与专用限流是**后来**才补的纵深防御）。
 *  （⚠️ 减轻情节：`password` 出口经 `redactAccessSecretList` 换成布尔 `hasPassword`，**访问密码不外泄**。）
 *
 * **为什么会变成这样**：`permissions.length == 0` 那道拒绝是协作者功能首版 `ebc85431` 的原始契约
 * （"没勾权限就什么都不能干"），而本表的免检是**后来** `d3d95363` 叠加的 ⇒ **两者从未对齐**。
 *
 * **修法**：本表整体移到 `permissions.length == 0` 那道拒绝**之后**判定，引导层留在之前。
 * 🔴 **对"勾了至少一项权限"的协作者行为逐条不变**（零回归），只有零权限协作者在这 20 条上从放行变成拒绝。
 *
 * ⚠️ 下面几条注释里"协作者本来就能读"的措辞，前提已从"任何协作者"收窄为"**有权限的**协作者"。
 */
export const publicRoutes = [
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
  'post-/api/admin/img/upload',
  // 只读：批量查图片被哪些文章引用（列表视图用）
  'post-/api/admin/img/references',
  // 只读：检测图片里的隐写水印（协作者也能用来验图）
  'post-/api/admin/img/stego/detect',
  'post-/api/admin/article/searchByLink',
  // 只读：导出文章/草稿为 Markdown（含图片打包）。⚠️ 2026-09-22 更正：原注释写"协作者本来就能读这些内容"，
  // 那个前提只对**有权限的**协作者成立 —— 零权限协作者此前也能靠这条一次带走任意一篇的正文与图片。
  'post-/api/admin/export/markdown',
  // 只读：回收站列表（P3）。软删列表不含 content，泄露面不大于既有列表接口。
  // ⚠️ 2026-09-22 更正：原注释的理由是"协作者本来就能读文章/草稿列表"，现在这条对**零权限**协作者不再成立
  // （本表已移到那道拒绝之后），所以理由收窄为"**有权限的**协作者与既有只读列表口径一致"。
  'get-/api/admin/article/deleted',
  'get-/api/admin/draft/deleted',
  // 只读：历史版本列表与单条（P4）。**还原**是写操作，走 pathPermissionMap 的 article:update 档。
  // ⚠️ 2026-09-22 更正：原注释写"协作者有 article:update（能读能改正文），读历史版本没有额外授权"——
  // 🔴 那个前提对**零权限**协作者根本不成立（他们没有任何权限，却能读到历史版本的完整 content）。
  // 现在本表在 `permissions.length == 0` 之后判定，所以理由改为"**勾了权限的**协作者读历史版本没有额外授权"。
  'get-/api/admin/article/:id/revisions',
  'get-/api/admin/article/:id/revisions/:revisionId',
];
