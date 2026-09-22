import { readFileSync } from 'fs';
import { join } from 'path';

import {
  bootstrapRoutes,
  isSuperAdminOnlyRoute,
  normalizeRoutePath,
  pathPermissionMap,
  permissionRoutes,
  publicRoutes,
} from 'src/types/access/access';
import { AccessGuard } from './access.guard';

/**
 * 🔴 钉住一条**安全性质**：`AccessGuard` 的路由键来自**路由定义**，不是来自请求。
 *
 * 背景：本轮在四个模块里各修掉一处「大小写敏感的路径比较 对着 大小写不敏感的 Express 路由」
 * （`staticGuard`、`cacheControl`、`main.ts` 的 pre-Nest 门控、`rateLimit`），并加了仓库级横切守卫
 * `utils/pathPrefixCaseDrift.spec.ts`。🔴 **但那条横切守卫扫不到本文件所保护的这一处** ——
 * 因为 `AccessGuard` 不是「对以 / 开头的字面量做 startsWith」，而是「构造一个键然后查表」。
 *
 * 结论（已用最小 Express 应用实测，见下面的「实测依据」）：**这一处没有洞**，因为
 * `request.route.path` 与 `Object.keys(request.route.methods)[0]` **都来自路由定义**：
 * Express 在大小写不敏感匹配下会把 `/API/admin/article/7` 路由到定义 `/api/admin/article/:id`，
 * 而 `req.route.path` 始终是**定义串**，攻击者改不了它。
 *
 * 实测依据（/tmp 里的最小 Express 应用，注册一个小写路由，用五种写法请求）：
 *   /api/admin/article/7 | /API/admin/article/7 | /api/admin/ARTICLE/7 | /Api/Admin/Article/7
 *   | /api/admin/article/7/   —— 五者全部 HTTP 200，且
 *   req.route.path 一律 = /api/admin/article/:id（定义串）、
 *   Object.keys(req.route.methods)[0] 一律 = get（小写）、
 *   ⇒ 构造出的 key 五个完全相同 = get-/api/admin/article/:id。
 *   对照：req.path 则逐个反映请求侧的大小写（即攻击者可控的那一侧）。
 *
 * 🔴 所以本 spec 的职责不是「修一个洞」，而是**把这个性质钉住**：将来若有人把键构造改成读
 * `request.path` / `request.url` / `request.originalUrl` / `request.method`，本 spec 必须红。
 * 那种改动会同时打开两个洞：①查表 miss ⇒ 落到 else 拒绝（可用性回归）；
 * 🔴 ②**更严重**：`isSuperAdminOnlyRoute(path)` 也会拿到请求侧的值，于是
 * `/API/admin/backup/...` 这类大写变体**绕过「只有超管能碰」那道拒绝**，
 * 而下游 `permissions.includes('all')` 会把「所有权限」的协作者放过去 —— 那正是
 * `SUPER_ADMIN_ONLY_ROUTE_PREFIXES` 当初要堵的（备份里含 jwt 密钥）。
 *
 * ⚠️ 另一个动机：既有的 `accessGuard.spec.ts` 用的替身是
 * `{ route: { path, methods }, user }`，**根本没有请求侧的 path/url** ⇒ 那个替身把
 * 「守卫读的是 route.path」这个假设**悄悄编码进了自己的形状**，所以它无法发现上面那种改动
 * （改了会读到 undefined 而抛异常、落进 catch 返回 false，于是「期望 true」的用例红、
 * 而「期望 false」的用例**恒真**）。本 spec 的替身**两侧都有、且故意大小写不同**。
 */

const guard = new AccessGuard();

const readGuardSource = () => readFileSync(join(__dirname, 'access.guard.ts'), 'utf8');

/** 剥掉注释与字符串字面量：钉「代码里有没有某个调用」时必须连字符串一起剥，否则本文件自己的注释会喂饱断言。 */
const stripCommentsAndStrings = (src: string): string => {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += '\n';
      continue;
    }
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};

/**
 * 造一个**两侧都有**的请求替身：
 * - `route.path` / `route.methods`：**路由定义**那一侧（Express 给的，攻击者改不了）；
 * - `path` / `url` / `originalUrl` / `method`：**请求**那一侧（攻击者可控，故意用不同大小写）。
 * 🔴 两侧故意不一致，这样「守卫读错了哪一侧」才会产生**可观测的判定差异**，而不是抛异常。
 */
const reqBothSides = (defPath: string, defMethod: string, requestUrl: string, user: any) =>
  ({
    route: { path: defPath, methods: { [defMethod]: true } },
    path: requestUrl,
    url: requestUrl,
    originalUrl: requestUrl,
    method: defMethod.toUpperCase(),
    user,
  }) as any;

const collaborator = (permissions: string[], id = 7) => ({ id, permissions });

/** 同一条路由定义，配上若干「请求侧大小写/尾斜杠变体」。 */
const requestVariants = (defPath: string, concreteTail: string): string[] => {
  const body = defPath.replace(/\/:[^/]+/g, '') + concreteTail;
  return [
    body,
    body.toUpperCase(),
    body.replace('/api', '/API'),
    body.replace('/admin', '/Admin'),
    body + '/',
    body.toUpperCase() + '/',
  ];
};

describe('AccessGuard 的路由键来自路由定义，不受请求侧大小写影响（同族第四处的排除性守卫）', () => {
  it('源码级：键的两个组成部分都取自 request.route，而不是请求侧字段', () => {
    const code = stripCommentsAndStrings(readGuardSource());
    // 定义侧：必须在用
    expect(code).toContain('request.route.path');
    expect(code).toContain('Object.keys(request.route.methods)[0]');
    // 🔴 请求侧：一个都不许读（这四个正是攻击者可控的那一侧）
    for (const forbidden of ['request.path', 'request.url', 'request.originalUrl', 'request.method']) {
      expect(code).not.toContain(forbidden);
    }
    // 🔴 传给 isSuperAdminOnlyRoute 的必须是定义侧的那个变量
    expect(code).toMatch(/isSuperAdminOnlyRoute\(\s*path\s*\)/);
    expect(code).not.toMatch(/isSuperAdminOnlyRoute\(\s*request\./);
  });

  it('尺子有效性：请求侧变体确实与定义串不同，否则上面的行为断言会恒真', () => {
    const defPath = '/api/admin/article/:id';
    const variants = requestVariants(defPath, '/7');
    expect(variants.length).toBeGreaterThan(3);
    for (const v of variants) {
      expect(v).not.toBe(defPath);
      // 🔴 关键：如果用请求侧的值构造键，它不会命中任何一张表 ⇒ 判定会改变
      const wouldBeKey = 'get-' + v;
      expect(bootstrapRoutes.includes(wouldBeKey)).toBe(false);
      expect(publicRoutes.includes(wouldBeKey)).toBe(false);
      expect(permissionRoutes.includes(wouldBeKey)).toBe(false);
    }
    // 而定义侧构造出的键确实命中免权限档 ⇒ 两侧行为可区分
    expect(publicRoutes.includes('get-' + defPath)).toBe(true);
  });

  it('行为级：零权限协作者打免权限档路由，六种请求侧变体的判定完全一致（都是拒绝）', async () => {
    const defPath = '/api/admin/article/:id';
    for (const v of requestVariants(defPath, '/7')) {
      await expect(
        guard.validateRequest(reqBothSides(defPath, 'get', v, collaborator([]))),
      ).resolves.toBe(false);
    }
  });

  it('行为级：有权限的协作者打免权限档路由，六种请求侧变体的判定完全一致（都是放行）', async () => {
    const defPath = '/api/admin/article/:id';
    for (const v of requestVariants(defPath, '/7')) {
      await expect(
        guard.validateRequest(reqBothSides(defPath, 'get', v, collaborator(['article:update']))),
      ).resolves.toBe(true);
    }
  });

  it('行为级：引导层对零权限协作者开放，且不受请求侧大小写影响', async () => {
    const defPath = '/api/admin/collaborator/list';
    expect(bootstrapRoutes.includes('get-' + defPath)).toBe(true);
    for (const v of requestVariants(defPath, '')) {
      await expect(
        guard.validateRequest(reqBothSides(defPath, 'get', v, collaborator([]))),
      ).resolves.toBe(true);
    }
  });

  it('行为级：超管在任何请求侧变体下都放行（别把超管锁在外面）', async () => {
    const defPath = '/api/admin/backup/full/list';
    for (const v of requestVariants(defPath, '')) {
      await expect(guard.validateRequest(reqBothSides(defPath, 'get', v, { id: 0 }))).resolves.toBe(true);
      await expect(guard.validateRequest(reqBothSides(defPath, 'get', v, { id: '0' }))).resolves.toBe(true);
    }
  });

  it('行为级：高危前缀对协作者一律拒绝，且请求侧大小写变体不能绕过它', async () => {
    // 🔴 这一条是「如果有人把 isSuperAdminOnlyRoute 改成吃请求侧的值」时最该红的一条：
    //    大写变体会让前缀匹配 miss，然后落到 permissions.includes('all') 那道放行。
    const defPath = '/api/admin/backup/full/list';
    expect(isSuperAdminOnlyRoute(defPath)).toBe(true);
    for (const v of requestVariants(defPath, '')) {
      await expect(
        guard.validateRequest(reqBothSides(defPath, 'get', v, collaborator(['all'], 9))),
      ).resolves.toBe(false);
    }
  });

  it('行为级：按权限档的路由，请求侧大小写变体不会绕过权限检查', async () => {
    // 取一条真实存在于 permissionRoutes 且不在高危前缀下的键
    const key = permissionRoutes.find(
      (k) => !isSuperAdminOnlyRoute(k.slice(k.indexOf('-') + 1)) && !bootstrapRoutes.includes(k),
    );
    expect(typeof key).toBe('string');
    const dash = (key as string).indexOf('-');
    const defMethod = (key as string).slice(0, dash);
    const defPath = (key as string).slice(dash + 1);
    const needed = pathPermissionMap[key as string];
    expect(typeof needed).toBe('string');
    const concrete = defPath.includes(':') ? '/7' : '';
    for (const v of requestVariants(defPath, concrete)) {
      // 缺这项权限 ⇒ 拒绝
      await expect(
        guard.validateRequest(reqBothSides(defPath, defMethod, v, collaborator(['article:create']))),
      ).resolves.toBe(needed === 'article:create' ? true : false);
      // 有这项权限 ⇒ 放行
      await expect(
        guard.validateRequest(reqBothSides(defPath, defMethod, v, collaborator([needed]))),
      ).resolves.toBe(true);
    }
  });

  it('req.route 缺失时落进 catch 并拒绝（fail-closed），而不是抛给调用方', async () => {
    // Express 在请求没有匹配任何路由时不会设置 req.route；守卫第一行就解引用它 ⇒ 抛 TypeError。
    const warn = jest.spyOn(guard.logger, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        guard.validateRequest({ path: '/api/admin/meta', url: '/api/admin/meta', user: { id: 0 } } as any),
      ).resolves.toBe(false);
      await expect(
        guard.validateRequest({ user: collaborator(['all']) } as any),
      ).resolves.toBe(false);
      await expect(guard.validateRequest(undefined as any)).resolves.toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('normalizeRoutePath 的口径（它故意不小写化 —— 因为吃的是路由定义串）', () => {
  it('去 query 与尾斜杠，但保留大小写；且高危前缀判定对定义串是可靠的', () => {
    expect(normalizeRoutePath('/api/admin/auth/')).toBe('/api/admin/auth');
    expect(normalizeRoutePath('/api/admin/auth/?x=1')).toBe('/api/admin/auth');
    expect(normalizeRoutePath('/api/admin/auth')).toBe('/api/admin/auth');
    expect(normalizeRoutePath('/')).toBe('/');
    expect(normalizeRoutePath('/api/admin/settingX')).toBe('/api/admin/settingX');
    expect(isSuperAdminOnlyRoute('/api/admin/settingX')).toBe(false);
    expect(isSuperAdminOnlyRoute('/api/admin/setting')).toBe(true);
    expect(isSuperAdminOnlyRoute('/api/admin/setting/layout')).toBe(true);
    // 🔴 记录这条口径的**前提**：不小写化是安全的，**当且仅当**输入来自路由定义。
    //    如果将来有人把请求侧的值喂进来，大写变体就会绕过这张表 —— 上面那条行为级断言会红。
    expect(isSuperAdminOnlyRoute('/API/admin/setting')).toBe(false);
    expect(isSuperAdminOnlyRoute(undefined)).toBe(false);
    expect(isSuperAdminOnlyRoute('')).toBe(false);
  });
});
