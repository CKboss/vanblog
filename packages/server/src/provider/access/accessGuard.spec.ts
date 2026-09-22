/**
 * `AccessGuard` 的权限边界：**凭据类 / 高危路由只认超管，`'all'` 也不例外**。
 *
 * ## 修复前
 * `validateRequest` 里有一句 `if (permissions.includes('all')) return true;`，
 * 而后台「协作者 → 权限」有一个叫「所有权限」的普通勾选项（`CollaboratorModal` 的 `value:'all'`）。
 * 于是勾了它的协作者**等价于超管**，能做的事（都逐条对过路由与实现）：
 *  - `PUT /api/admin/auth` 改 `id:0` 管理员的用户名与口令；
 *  - `/api/admin/token/**` 签 API Token，而它签的是 `{sub:0, role:'admin'}` ⇒ 一枚超管凭证；
 *  - `/api/admin/backup/full/**` 下载整站备份（含全部口令 scrypt 哈希与 `settings{type:'jwt'}` 的 jwt 密钥）；
 *  - `/api/admin/pipeline/**` 流水线 = 写文件 + `fork()` 执行 ⇒ 容器内 RCE；
 *  - `/api/admin/collaborator/**` 改自己或别人的权限 ⇒ 自我提权；
 *  - `/api/admin/setting/**` 含 `layout`（css/html/head/script，前台**原样注入**每个页面 ⇒ 全站任意 JS）、
 *    `static`（对象存储凭据）、`waline`（评论库凭据）、`login`（防爆破开关）；
 *  - `/api/admin/caddy/**` 改反代与证书。
 *
 * ## 修复后
 * `SUPER_ADMIN_ONLY_ROUTE_PREFIXES` 里的前缀只有 `user.id === 0`（API Token 本来就是 sub:0）能过，
 * 判定放在 `publicRoutes` **之后**（所以 `get-/api/admin/collaborator/list` 对协作者仍然开放），
 * 拒绝时打一条说清"哪条路由、需要什么身份"的 WARN。
 *
 * ⚠️ 本文件里所有"某文本不存在"的断言都跑在 `stripCommentsForAnchor` 之后：
 * 上面这段注释与实现里的注释都**必然**写着 `permissions.includes('all')`，
 * 不剥注释就会自己喂绿自己（本仓库已踩 6 次）。
 */
import { AccessGuard } from './access.guard';
import {
  ALL_PERMISSION_VALUES,
  SUPER_ADMIN_ONLY_ROUTE_PREFIXES,
  bootstrapRoutes,
  isSuperAdminOnlyRoute,
  isSuperAdminUser,
  normalizeRoutePath,
  pathPermissionMap,
  permissionRoutes,
  publicRoutes,
} from 'src/types/access/access';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
const code = stripCommentsForAnchor;

/**
 * 造一个 guard 请求上下文，🔴 **两侧都有、且故意不同**：
 * - `route.path` / `route.methods`：**路由定义**那一侧（Express 匹配后挂上的，攻击者改不了）；
 * - 请求侧的四个字段：**攻击者可控**的那一侧，刻意用大写变体。
 *
 * 🔴 **为什么必须两侧都有**：这个替身此前只有定义侧，等于把「守卫读的是 route.path」这个假设
 * **悄悄编码进了替身自己的形状**。若有人把守卫改成读请求侧，用例会读到 undefined ⇒
 * 键变成 `get-undefined` ⇒ 不命中任何表 ⇒ 🔴 **所有「期望拒绝」的用例会因为错误的理由通过**
 * （实测：把守卫改成读请求侧之后，本文件 18 条「带具体权限的协作者也被拒」全绿，
 * 而拒绝 WARN 一次都没打 ⇒ 高危前缀那一支根本没走到，拒绝来自垃圾键的兜底）。
 * 两侧故意不同之后，「读错了哪一侧」会产生**可观测的判定差异**，而不是被兜底掩盖。
 * ⚠️ `method` 用大写也是忠实的：真实 Express 的请求方法是大写，而表里的键是小写，
 * 守卫取的是 `Object.keys(route.methods)[0]`（小写）—— 这正是它能对上表的原因。
 * ⚠️ 同族的 `accessGuardRouteKeyCase.spec.ts` 用 `reqBothSides()` 做同一件事；
 * 本文件保留 `req(method, path, user)` 的签名不变，以免改动 24 处调用点的语义。
 */
const req = (method: string, path: string, user: any) =>
  ({
    route: { path, methods: { [method.toLowerCase()]: true } },
    path: path.toUpperCase(),
    url: path.toUpperCase(),
    originalUrl: path.toUpperCase(),
    method: method.toUpperCase(),
    user,
  }) as any;

const collaborator = (permissions: string[], id = 7) => ({ id, permissions });

describe('SUPER_ADMIN_ONLY_ROUTE_PREFIXES：表本身', () => {
  it('覆盖了站长点名的 7 类高危前缀（按前缀断言，不钉条数）', () => {
    for (const prefix of [
      '/api/admin/auth',
      '/api/admin/token',
      '/api/admin/backup',
      '/api/admin/pipeline',
      '/api/admin/collaborator',
      '/api/admin/setting',
      '/api/admin/caddy',
    ]) {
      expect(SUPER_ADMIN_ONLY_ROUTE_PREFIXES).toContain(prefix);
    }
  });

  it('非空，且每一项都是 /api/admin 下的绝对前缀（防止有人塞进奇怪的值）', () => {
    expect(SUPER_ADMIN_ONLY_ROUTE_PREFIXES.length).toBeGreaterThan(0);
    for (const p of SUPER_ADMIN_ONLY_ROUTE_PREFIXES) {
      expect(p.startsWith('/api/admin/')).toBe(true);
      expect(p.endsWith('/')).toBe(false);
    }
  });

  it('normalizeRoutePath 去掉尾斜杠与查询串（@Controller("/api/admin/auth/") + @Put() 会带尾斜杠）', () => {
    expect(normalizeRoutePath('/api/admin/auth/')).toBe('/api/admin/auth');
    expect(normalizeRoutePath('/api/admin/auth///')).toBe('/api/admin/auth');
    expect(normalizeRoutePath('/api/admin/setting/layout?x=1')).toBe('/api/admin/setting/layout');
    expect(normalizeRoutePath('/')).toBe('/');
    expect(normalizeRoutePath(undefined)).toBe('');
    expect(normalizeRoutePath(123)).toBe('');
  });

  it('前缀判定不会把同前缀的兄弟路由误伤（/api/admin/settingX 不算 /api/admin/setting）', () => {
    expect(isSuperAdminOnlyRoute('/api/admin/settingX')).toBe(false);
    expect(isSuperAdminOnlyRoute('/api/admin/settings')).toBe(false);
    expect(isSuperAdminOnlyRoute('/api/admin/setting')).toBe(true);
    expect(isSuperAdminOnlyRoute('/api/admin/setting/layout')).toBe(true);
    expect(isSuperAdminOnlyRoute('/api/admin/caddy')).toBe(true);
    expect(isSuperAdminOnlyRoute('')).toBe(false);
    expect(isSuperAdminOnlyRoute(null)).toBe(false);
  });
});

describe('isSuperAdminUser：不再用松散比较', () => {
  it('数字 0 与字符串 "0" 都算超管（jwt 的 sub 经过 JSON 往返，两种形状都可能出现）', () => {
    expect(isSuperAdminUser({ id: 0 })).toBe(true);
    expect(isSuperAdminUser({ id: '0' })).toBe(true);
  });

  it('⚠️ 松散比较会放过的形状一律不是超管', () => {
    // `'' == 0` 与 `[] == 0` 在 JS 里都是 true —— 这正是不能用 `user.id == 0` 的原因
    expect(isSuperAdminUser({ id: '' })).toBe(false);
    expect(isSuperAdminUser({ id: [] })).toBe(false);
    expect(isSuperAdminUser({ id: null })).toBe(false);
    expect(isSuperAdminUser({ id: undefined })).toBe(false);
    expect(isSuperAdminUser({})).toBe(false);
    expect(isSuperAdminUser(null)).toBe(false);
    expect(isSuperAdminUser(undefined)).toBe(false);
    expect(isSuperAdminUser({ id: false })).toBe(false);
    // ⚠️ 字符串只认字面 "0"：`Number(' 0 ')`、`Number('00')`、`Number('0x0')` 都等于 0，
    //    但"能转成 0"与"就是 0"是两件事，判定身份不该接受宽松写法。
    expect(isSuperAdminUser({ id: ' 0 ' })).toBe(false);
    expect(isSuperAdminUser({ id: '00' })).toBe(false);
    expect(isSuperAdminUser({ id: '0x0' })).toBe(false);
    expect(isSuperAdminUser({ id: 0.0 })).toBe(true); // 0.0 === 0，整数
    expect(isSuperAdminUser({ id: NaN })).toBe(false);
    expect(isSuperAdminUser({ id: 1 })).toBe(false);
    expect(isSuperAdminUser({ id: -0 })).toBe(true); // -0 是整数且 === 0
  });
});

describe('AccessGuard：高危路由对协作者（含 all）一律拒绝', () => {
  const guard = new AccessGuard();
  const warn = jest.spyOn(guard.logger, 'warn').mockImplementation(() => undefined);
  beforeEach(() => warn.mockClear());

  const cases: Array<[string, string]> = [
    ['put', '/api/admin/auth/'], // 改管理员口令（@Controller 带尾斜杠 + @Put() 空子路径）
    ['put', '/api/admin/auth'],
    ['post', '/api/admin/token'],
    ['get', '/api/admin/token'],
    ['delete', '/api/admin/token/:id'],
    ['get', '/api/admin/backup/full/list'],
    ['get', '/api/admin/backup/full/download'],
    ['post', '/api/admin/backup/full/restore'],
    ['post', '/api/admin/pipeline'],
    ['put', '/api/admin/pipeline/:id'],
    ['post', '/api/admin/collaborator'],
    ['put', '/api/admin/collaborator'],
    ['delete', '/api/admin/collaborator/:id'],
    ['put', '/api/admin/setting/layout'], // css/html/head/script ⇒ 全站任意 JS
    ['put', '/api/admin/setting/static'], // 对象存储凭据
    ['put', '/api/admin/setting/waline'],
    ['put', '/api/admin/setting/login'], // 防爆破开关
    ['get', '/api/admin/caddy/config'],
  ];

  it.each(cases)('%s %s：permissions=["all"] 的协作者被拒', async (method, path) => {
    await expect(guard.validateRequest(req(method, path, collaborator(['all'])))).resolves.toBe(false);
  });

  it.each(cases)('%s %s：带具体权限的协作者也被拒（不能靠凑权限绕过）', async (method, path) => {
    const perms = Object.values(pathPermissionMap);
    await expect(guard.validateRequest(req(method, path, collaborator(perms)))).resolves.toBe(false);
    // 🔴 **并且必须是因为「高危前缀只认超管」这一支而拒，不是因为键对不上表而落到兜底。**
    //    只断言结论的话，这条用例在「守卫读错了路径来源」时会因为错误的理由通过：
    //    键变成垃圾值 ⇒ 不命中任何表 ⇒ 兜底也是拒绝 ⇒ 断言恒真（实测过 18 条全绿而 WARN 零次）。
    //    那条 WARN 只在 isSuperAdminOnlyRoute 命中的分支里打，所以它正好钉住「拒绝的理由」。
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`${method}-${path}`);
  });

  it.each(cases)('%s %s：超管（id=0）照常放行', async (method, path) => {
    await expect(guard.validateRequest(req(method, path, { id: 0 }))).resolves.toBe(true);
  });

  it('🔴 替身自检：请求上下文两侧都有、且故意不同（否则「读错侧」会被兜底掩盖）', () => {
    const r = req('put', '/api/admin/setting/layout', collaborator(['all'], 9));
    // 定义侧（守卫应当读的那一侧）
    expect(r.route.path).toBe('/api/admin/setting/layout');
    expect(Object.keys(r.route.methods)[0]).toBe('put');
    // 请求侧四个字段都必须存在（缺任何一个，「守卫改读请求侧」就又会读到 undefined）
    for (const f of ['path', 'url', 'originalUrl', 'method']) {
      expect({ field: f, present: typeof r[f] === 'string' && r[f].length > 0 }).toEqual({
        field: f,
        present: true,
      });
    }
    // 🔴 两侧必须**不同**：相同的话，读错侧不会产生任何可观测差异，上面那些断言就白加了
    expect(r.path).not.toBe(r.route.path);
    expect(r.method).not.toBe(Object.keys(r.route.methods)[0]);
    // 并且请求侧那个值**不命中**高危前缀判定（这正是"读错侧会改变结论"的机制）
    expect(isSuperAdminOnlyRoute(r.path)).toBe(false);
    expect(isSuperAdminOnlyRoute(r.route.path)).toBe(true);
  });

  it('API Token（sub:0 ⇒ id:0）不受影响：它本来就是超管身份', async () => {
    await expect(guard.validateRequest(req('get', '/api/admin/backup/full/list', { id: '0' }))).resolves.toBe(
      true,
    );
  });

  it('拒绝时打一条能说清"哪条路由 + 需要什么身份"的 WARN', async () => {
    await guard.validateRequest(req('put', '/api/admin/setting/layout', collaborator(['all'], 9)));
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('put-/api/admin/setting/layout');
    expect(msg).toContain('超管');
    expect(msg).toContain('id=9');
  });

  it('⚠️ 顺序钉子：**引导层** bootstrapRoutes 在高危前缀判定之前，否则协作者列表接口会被一起关掉', async () => {
    // get-/api/admin/collaborator/list 在引导层里，而 /api/admin/collaborator 在高危前缀里。
    // 后台的协作者下拉框靠它，所以这条必须对**没有任何权限**的协作者也开放。
    expect(bootstrapRoutes).toContain('get-/api/admin/collaborator/list');
    expect(publicRoutes).not.toContain('get-/api/admin/collaborator/list');
    expect(isSuperAdminOnlyRoute('/api/admin/collaborator/list')).toBe(true);
    await expect(
      guard.validateRequest(req('get', '/api/admin/collaborator/list', collaborator([]))),
    ).resolves.toBe(true);
    // 源码级：引导层的判定必须出现在高危前缀判定之前
    const src = code(read('./access.guard.ts'));
    expect(src.indexOf('bootstrapRoutes.includes(key)')).toBeGreaterThan(0);
    expect(src.indexOf('bootstrapRoutes.includes(key)')).toBeLessThan(src.indexOf('isSuperAdminOnlyRoute(path)'));
  });

  it('🔴 顺序钉子（B′ 的核心）：免权限档 publicRoutes 必须在「零权限拒绝」**之后**判定', () => {
    // 这条就是本次安全修复本身：以前 publicRoutes 排在那道拒绝之前，
    // 于是 permissions:[] 的协作者能命中全部 24 条（含能读全站正文与导出打包的两条）。
    const src = code(read('./access.guard.ts'));
    const iZero = src.indexOf('permissions.length == 0');
    const iPublic = src.indexOf('publicRoutes.includes(key)');
    const iSuper = src.indexOf('isSuperAdminOnlyRoute(path)');
    const iBoot = src.indexOf('bootstrapRoutes.includes(key)');
    // 反空转：四个锚点都真的存在（否则 indexOf 返回 -1 会让下面的比大小恒真）
    for (const [name, idx] of [
      ['bootstrapRoutes.includes(key)', iBoot],
      ['isSuperAdminOnlyRoute(path)', iSuper],
      ['permissions.length == 0', iZero],
      ['publicRoutes.includes(key)', iPublic],
    ] as Array<[string, number]>) {
      expect({ anchor: name, found: idx }).toEqual({ anchor: name, found: expect.any(Number) });
      if (idx < 0) {
        throw new Error(`锚点未找到：${name}（剥注释后的源码里没有它）`);
      }
    }
    // 引导层 < 高危前缀 < 零权限拒绝 < 免权限档
    expect(iBoot).toBeLessThan(iSuper);
    expect(iSuper).toBeLessThan(iZero);
    expect(iZero).toBeLessThan(iPublic);
  });
});

describe('AccessGuard：不能一刀切 —— 协作者的正常能力必须还在', () => {
  const guard = new AccessGuard();
  jest.spyOn(guard.logger, 'warn').mockImplementation(() => undefined);

  it('permissions=["all"] 仍然能管文章/草稿/图片/附件/评论/分类/标签/自定义页面/主题/统计/导出', async () => {
    const stillAllowed: Array<[string, string]> = [
      ['post', '/api/admin/article'],
      ['put', '/api/admin/article/:id'],
      ['delete', '/api/admin/article/:id'],
      ['post', '/api/admin/draft'],
      ['put', '/api/admin/draft/:id'],
      ['delete', '/api/admin/img/:sign'],
      ['post', '/api/admin/img/upload'],
      ['delete', '/api/admin/file/:sign'],
      ['get', '/api/admin/comment'],
      ['post', '/api/admin/category'],
      ['post', '/api/admin/tag'],
      ['post', '/api/admin/customPage'],
      ['post', '/api/admin/theme'],
      ['get', '/api/admin/analysis/overview'],
      ['post', '/api/admin/export/markdown'],
      ['get', '/api/admin/meta/site'],
    ];
    for (const [method, path] of stillAllowed) {
      // 这些都不在高危前缀下，所以 'all' 必须放行
      expect(isSuperAdminOnlyRoute(path)).toBe(false);
      await expect(guard.validateRequest(req(method, path, collaborator(['all'])))).resolves.toBe(true);
    }
  });

  it('具体权限档照旧生效：有 article:update 能改文章，没有就被拒', async () => {
    await expect(
      guard.validateRequest(req('put', '/api/admin/article/:id', collaborator(['article:update']))),
    ).resolves.toBe(true);
    await expect(
      guard.validateRequest(req('put', '/api/admin/article/:id', collaborator(['draft:update']))),
    ).resolves.toBe(false);
  });

  // 🔴 2026-09-22 更正：这一条原来把三种不同情况塞在一个用例里，而标题写的是"没有权限"——
  // 但第一行传的第三个参数是 **user**（helper 是 req(method, path, user)），测的其实是"没有 user"；
  // 第二行打的路由**不在**免权限档里。⇒ 整个文件此前**没有任何一条**断言用 permissions:[] 去打
  // 免权限档里的键，而那正是本次修复的缺陷所在。下面把四种情况拆成独立断言。
  it('没有 user ⇒ 关门（helper 第三个参数是 user，不是 permissions）', async () => {
    await expect(guard.validateRequest(req('get', '/api/admin/meta', undefined))).resolves.toBe(false);
    await expect(guard.validateRequest(req('get', '/api/admin/meta', null))).resolves.toBe(false);
  });

  it('permissions 缺失 / 空数组 / 不是数组 ⇒ 全都关门', async () => {
    await expect(guard.validateRequest(req('post', '/api/admin/article', { id: 3 }))).resolves.toBe(false);
    await expect(guard.validateRequest(req('post', '/api/admin/article', { id: 3, permissions: [] }))).resolves.toBe(
      false,
    );
    await expect(
      guard.validateRequest(req('post', '/api/admin/article', { id: 3, permissions: undefined })),
    ).resolves.toBe(false);
    await expect(
      guard.validateRequest(req('post', '/api/admin/article', { id: 3, permissions: null })),
    ).resolves.toBe(false);
    // 不是数组：`permissions.length` 对字符串也存在，所以必须显式核实它不会放行
    await expect(
      guard.validateRequest(req('post', '/api/admin/article', { id: 3, permissions: 'all' })),
    ).resolves.toBe(false);
    await expect(
      guard.validateRequest(req('post', '/api/admin/article', { id: 3, permissions: {} })),
    ).resolves.toBe(false);
  });

  it('判定过程抛异常 ⇒ 关门（失败方向不许反）', async () => {
    await expect(guard.validateRequest({} as any)).resolves.toBe(false);
    // route 存在但 methods 为空 ⇒ Object.keys(...)[0] 是 undefined，仍必须关门而不是抛出去
    await expect(
      guard.validateRequest({ route: { path: '/api/admin/meta', methods: {} }, user: { id: 3, permissions: [] } }),
    ).resolves.toBe(false);
  });

  it('ALL_PERMISSION_VALUES 就是 pathPermissionMap 的值 + all（去重），且不含未知值', () => {
    const expected = Array.from(new Set([...Object.values(pathPermissionMap), 'all']));
    expect([...ALL_PERMISSION_VALUES].sort()).toEqual(expected.sort());
    expect(ALL_PERMISSION_VALUES).toContain('all');
    // 10 个 LimitPermission + 'all'（pathPermissionMap 有重复值，所以要去重后比）
    expect(ALL_PERMISSION_VALUES.length).toBe(expected.length);
    expect(ALL_PERMISSION_VALUES.length).toBeLessThanOrEqual(Object.keys(pathPermissionMap).length + 1);
    // permissionRoutes 仍然从 pathPermissionMap 的 keys 派生（既有钉子，别回退）
    expect(permissionRoutes).toEqual(Object.keys(pathPermissionMap));
  });
});

/**
 * 🔴 B′ 拆表的核心契约：**零权限协作者只能命中引导层那 4 条，免权限档那 20 条一律拒绝**。
 *
 * 这一节就是本次安全修复的判据。它**穷举**两层的每一个键（不抽样），所以
 * 将来往任意一层加键都会**自动**被覆盖 —— 加到免权限档 ⇒ 自动断言「零权限打它被拒」；
 * 加到引导层 ⇒ 自动断言「零权限打它放行」，而引导层还有一条「恰好等于这 4 条」的断言会红。
 *
 * ⚠️ 键的形状是 method 与 path 用第一个连字符连接（与 AccessGuard 内部拼的一致）。
 * 🔴 拆开时不能用 split：path 里将来若出现连字符就会错 ⇒ 用 indexOf 取第一个。
 */
describe('AccessGuard：B′ 分层契约（零权限协作者）', () => {
  const guard = new AccessGuard();
  jest.spyOn(guard.logger, 'warn').mockImplementation(() => undefined);

  const splitKey = (key: string): [string, string] => {
    const i = key.indexOf('-');
    if (i <= 0) {
      throw new Error('路由键形状不对（应当是 method-path）：' + key);
    }
    return [key.slice(0, i), key.slice(i + 1)];
  };

  /** 拆表前的原始 24 条（从 git 历史逐字取出，不手抄）。并集必须恒等于它。 */
  const ORIGINAL_24: string[] = [
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
  'post-/api/admin/img/references',
  'post-/api/admin/img/stego/detect',
  'post-/api/admin/article/searchByLink',
  'post-/api/admin/export/markdown',
  'get-/api/admin/article/deleted',
  'get-/api/admin/draft/deleted',
  'get-/api/admin/article/:id/revisions',
  'get-/api/admin/article/:id/revisions/:revisionId',
  ];

  it('反空转：两层都非空，且条数是 4 / 20（防止有人把某一层清空后断言恒真）', () => {
    expect(bootstrapRoutes.length).toBe(4);
    expect(publicRoutes.length).toBe(20);
    expect(ORIGINAL_24.length).toBe(24);
  });

  it('🔴 引导层恰好是站长裁定的那 4 条（多一条 = 给零权限协作者开了新能力）', () => {
    expect([...bootstrapRoutes].sort()).toEqual(
      [
        'get-/api/admin/collaborator/list',
        'get-/api/admin/meta',
        'post-/api/admin/auth/login',
        'post-/api/admin/auth/logout',
      ].sort(),
    );
  });

  it('🔴 两层不重叠，且并集恰好等于拆表前的 24 条（漏一条 / 多一条 / 重复都会红）', () => {
    const overlap = bootstrapRoutes.filter((k) => (publicRoutes as string[]).includes(k));
    expect(overlap).toEqual([]);
    const union = [...bootstrapRoutes, ...publicRoutes];
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual([...ORIGINAL_24].sort());
  });

  it.each(publicRoutes)('🔴 零权限协作者被拒：%s', async (key) => {
    const [method, path] = splitKey(key);
    await expect(guard.validateRequest(req(method, path, collaborator([])))).resolves.toBe(false);
  });

  it.each(bootstrapRoutes)('引导层对零权限协作者放行：%s', async (key) => {
    const [method, path] = splitKey(key);
    await expect(guard.validateRequest(req(method, path, collaborator([])))).resolves.toBe(true);
  });

  it.each(publicRoutes)('零回归：勾了 article:update 的协作者仍可用 %s', async (key) => {
    const [method, path] = splitKey(key);
    expect(isSuperAdminOnlyRoute(path)).toBe(false);
    await expect(
      guard.validateRequest(req(method, path, collaborator(['article:update']))),
    ).resolves.toBe(true);
  });

  it('零回归：超管（id=0）对两层的每一条都放行', async () => {
    for (const key of [...bootstrapRoutes, ...publicRoutes]) {
      const [method, path] = splitKey(key);
      await expect(guard.validateRequest(req(method, path, { id: 0 }))).resolves.toBe(true);
    }
  });

  it('🔴 修复生效的直接证据：能读全站正文、能打包导出、能上传的那几条，零权限协作者现在被拒', async () => {
    for (const key of [
      'get-/api/admin/article/:id',
      'get-/api/admin/draft/:id',
      'post-/api/admin/export/markdown',
      'post-/api/admin/img/upload',
      'post-/api/admin/file/upload',
      'get-/api/admin/article/:id/revisions/:revisionId',
    ]) {
      const [method, path] = splitKey(key);
      await expect(guard.validateRequest(req(method, path, collaborator([])))).resolves.toBe(false);
    }
  });

  it('🔴 非数组 permissions 一律关门（字符串 all 曾能一路走到 includes 而放行）', async () => {
    for (const bad of ['all', 'article:update', {}, 0, 1, true, NaN]) {
      await expect(
        guard.validateRequest(req('post', '/api/admin/article', { id: 3, permissions: bad })),
      ).resolves.toBe(false);
    }
  });
});

describe('源码级钉子', () => {
  const src = code(read('./access.guard.ts'));

  it('超管判定走 isSuperAdminUser，不再是 `user.id == 0` 松散比较', () => {
    expect(src).toMatch(/if \(isSuperAdminUser\(user\)\)/);
    expect(src).not.toMatch(/user\.id == 0/);
  });

  it('高危前缀判定确实在 guard 里被调用（不是只 import 不用）', () => {
    expect(src).toMatch(/if \(isSuperAdminOnlyRoute\(path\)\) \{/);
  });

  it('⚠️ 反证的反证：上面两条正则跑在**旧形状**上必须命中（证明它们不是空断言）', () => {
    const oldShape = 'if (user.id == 0) {\n  return true;\n}';
    expect(oldShape).toMatch(/user\.id == 0/);
    expect('const x = 1;').not.toMatch(/isSuperAdminOnlyRoute\(path\)/);
  });

  it('`permissions.includes(\'all\')` 仍然保留（它是协作者的正常能力，不能被顺手删掉）', () => {
    expect(src).toMatch(/permissions\.includes\('all'\)/);
  });
});
