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

/** 造一个 guard 请求上下文：`request.route.path` + `route.methods`，与 Express 一致。 */
const req = (method: string, path: string, user: any) =>
  ({ route: { path, methods: { [method.toLowerCase()]: true } }, user }) as any;

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
  });

  it.each(cases)('%s %s：超管（id=0）照常放行', async (method, path) => {
    await expect(guard.validateRequest(req(method, path, { id: 0 }))).resolves.toBe(true);
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

  it('⚠️ 顺序钉子：publicRoutes 在高危前缀判定**之前**，否则协作者列表接口会被一起关掉', async () => {
    // get-/api/admin/collaborator/list 在 publicRoutes 里，而 /api/admin/collaborator 在高危前缀里。
    // 后台的协作者下拉框靠它，所以这条必须对**没有任何权限**的协作者也开放。
    expect(publicRoutes).toContain('get-/api/admin/collaborator/list');
    expect(isSuperAdminOnlyRoute('/api/admin/collaborator/list')).toBe(true);
    await expect(
      guard.validateRequest(req('get', '/api/admin/collaborator/list', collaborator([]))),
    ).resolves.toBe(true);
    // 源码级：publicRoutes 的判定必须出现在高危前缀判定之前
    const src = code(read('./access.guard.ts'));
    expect(src.indexOf('publicRoutes.includes(key)')).toBeGreaterThan(0);
    expect(src.indexOf('publicRoutes.includes(key)')).toBeLessThan(src.indexOf('isSuperAdminOnlyRoute(path)'));
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

  it('没有权限 / 没有 user / 判定异常，全都关门（既有行为不回退）', async () => {
    await expect(guard.validateRequest(req('get', '/api/admin/meta', undefined))).resolves.toBe(false);
    await expect(guard.validateRequest(req('post', '/api/admin/article', { id: 3 }))).resolves.toBe(false);
    await expect(guard.validateRequest({} as any)).resolves.toBe(false);
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
