import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { LocalStrategy } from './local.strategy';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * `LocalStrategy.validate()` 的返回契约，以及它那个 **truthy 哨兵**的安全前提。
 *
 * 🔴 这个文件的重点不是"策略做了什么"，而是"策略的返回值**不能**被 Nest 当成认证失败"：
 * Nest 的 `AuthGuard('local')` 只在 `validate()` 返回 **falsy** 时才抛 401，
 * 而本实现在失败时返回 `{ fail: true }` —— 一个**truthy** 对象。
 * 也就是说：**从 passport 的角度看，口令错误等于认证成功**，`req.user` 被设成 `{fail:true}`。
 * 真正把它翻译成 401 的是控制器里的第一句 `if (request?.user?.fail)`
 * （`controller/admin/auth/auth.controller.ts:62`），紧接着才是 `recordFailure` + 401。
 *
 * 后果：**任何新增的 `AuthGuard('local')` 路由，只要忘了检查 `.fail`，就是一条认证绕过**
 * （`authProvider.login({fail:true})` 会拿 `user.name`/`user.id` 全是 undefined 去签 token）。
 * 所以这里除了行为级断言，还有一条**跨文件漂移守卫**：仓库里每一处 `AuthGuard('local')`
 * 都必须在调用 `authProvider.login(` 之前检查过 `.fail`。
 *
 * ⚠️ 顺带说明为什么不用"返回 null 让 Nest 自己 401"这种更安全的写法：现有实现要区分
 * "口令错"（要计数、要写审计日志、要 401 带自定义文案）与"用户不存在"（本轮做了时序均衡，
 * 见 `provider/user/userProviderTiming.spec.ts`），哨兵是把这两种情况都交回控制器统一处理的办法。
 * 这是**有意设计**，不是疏漏；本文件钉住的是它的前提条件。
 */

describe('LocalStrategy.validate：成功与失败的返回契约', () => {
  function makeStrategy(validateUser: any) {
    const s = Object.create(LocalStrategy.prototype) as any;
    s.authProvider = { validateUser };
    return s;
  }

  it('口令正确 ⇒ 原样返回 authProvider 给的用户对象（引用相同，不重新包装）', async () => {
    const user = { id: 0, name: 'admin', nickname: 'n', type: 'admin' };
    const s = makeStrategy(jest.fn(async () => user));
    const r = await s.validate('admin', 'pw');
    expect(r).toBe(user);
  });

  it('把用户名与口令**原样**传给 authProvider（不做 trim / 大小写折叠 —— 那会改变口令语义）', async () => {
    const validateUser = jest.fn(async () => null);
    const s = makeStrategy(validateUser);
    await s.validate('  Admin ', '  p@ss ');
    expect(validateUser).toHaveBeenCalledWith('  Admin ', '  p@ss ');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['false', false],
  ] as const)('authProvider 返回 %s ⇒ validate 返回 `{fail:true}` 哨兵', async (_label, falsy) => {
    const s = makeStrategy(jest.fn(async () => falsy));
    const r = await s.validate('u', 'p');
    expect(r).toEqual({ fail: true });
  });

  it('🔴 哨兵是 **truthy** 的 —— 这正是"忘记检查就等于绕过"的根源，钉住它以免有人误以为 Nest 会兜底', async () => {
    const s = makeStrategy(jest.fn(async () => null));
    const r = await s.validate('u', 'p');
    expect(Boolean(r)).toBe(true);
    expect(r).not.toBeNull();
    // 负向对照：如果哪天改成返回 null，Nest 会自己 401，上面两条会红 ⇒ 那时要同步改本文件的说明
  });

  it('🔴 哨兵里**不含任何身份字段**：即使某个路由忘了检查 `.fail`，' +
    '拿到的也是一个没有 id/name/permissions 的对象，而不是某个真实用户', async () => {
    const s = makeStrategy(jest.fn(async () => null));
    const r = await s.validate('u', 'p');
    expect(Object.keys(r)).toEqual(['fail']);
    expect(r.id).toBeUndefined();
    expect(r.name).toBeUndefined();
    expect(r.permissions).toBeUndefined();
  });

  it('"用户不存在"与"口令错误"在这一层**不可区分**（返回完全相同的哨兵）', async () => {
    const notFound = makeStrategy(jest.fn(async () => null)); // user.provider 对两种情况都返回 null
    const wrongPw = makeStrategy(jest.fn(async () => null));
    const a = await notFound.validate('ghost', 'x');
    const b = await wrongPw.validate('admin', 'wrong');
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // ⚠️ 这里刻意**不做计时断言**（会 flaky）：真正的时序均衡在 user.provider 里
    //    （不存在的用户也跑一次 dummy scrypt），由 provider/user/userProviderTiming.spec.ts 负责。
  });

  it('authProvider 抛错时**向上传播**（不被吞成哨兵）—— 数据库坏了应该是 500，' +
    '而不是被记成一次"口令错误"并计入防爆破', async () => {
    const s = makeStrategy(jest.fn(async () => {
      throw new Error('db down');
    }));
    await expect(s.validate('u', 'p')).rejects.toThrow(/db down/);
  });
});

describe('漂移守卫：每一处 `AuthGuard(\'local\')` 都必须在 login 之前检查 `.fail`', () => {
  const ROOT = resolve(__dirname, '../../..');

  function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) yield* walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) yield p;
    }
  }

  const hits: { file: string; src: string }[] = [];
  for (const f of walk(join(ROOT, 'src'))) {
    const raw = readFileSync(f, 'utf-8');
    // ⚠️ **检测也必须在剥注释后的文本上做**：第一版在原文里找 `AuthGuard('local')`，
    //    结果 `provider/auth/login.guard.ts` 命中了 —— 它只是在**注释里**解释与这个守卫的关系，
    //    并没有真的用它。这是本仓库第 9 次踩"断言匹配到解释性注释"（前 8 次记在 AGENTS 里）。
    //    检测与断言用同一份剥过注释的文本，才不会一边误报、一边被注释伪装成通过。
    const src = stripCommentsForAnchor(raw);
    if (src.includes("AuthGuard('local')")) {
      hits.push({ file: f.replace(ROOT + '/', ''), src });
    }
  }

  it('尺子没有空转：确实扫到了使用 `AuthGuard(\'local\')` 的文件', () => {
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.file.includes('auth.controller.ts'))).toBe(true);
  });

  it.each(hits.map((h) => [h.file, h] as const))(
    '%s：`.fail` 检查必须出现在 `authProvider.login(` **之前**',
    (_file, h) => {
      const iFail = h.src.search(/\.fail\b/);
      const iLogin = h.src.search(/authProvider\.login\(/);
      // 两处都必须存在（⚠️ 不要用 expect.any(Number)：search 找不到时返回 -1，那也是 Number，
      //    那种写法看起来在检查、其实什么都检查不到）
      expect(iFail).toBeGreaterThan(-1);
      expect(iLogin).toBeGreaterThan(-1);
      // ⚠️ 顺序才是安全性质：先检查哨兵、后签发 token。反过来就等于用哨兵去签 token。
      expect(iFail).toBeLessThan(iLogin);
      // 检查必须是"拒绝"形状（抛 401 / return），而不是只读一下
      const between = h.src.slice(iFail, iLogin);
      expect(between).toMatch(/UnauthorizedException|throw|return/);
    },
  );

  it('负向对照：把 `.fail` 检查挪到 login 之后，上面那条顺序断言必须能抓到', () => {
    const broken = [
      "const data = await this.authProvider.login(request.user);",
      "if (request?.user?.fail) { throw new UnauthorizedException(); }",
    ].join('\n');
    const iFail = broken.search(/\.fail\b/);
    const iLogin = broken.search(/authProvider\.login\(/);
    expect(iFail).toBeGreaterThan(iLogin); // ← 顺序反了，尺子量得出来
    // 空转反证：正确形状下顺序断言成立
    const good = [
      "if (request?.user?.fail) { throw new UnauthorizedException(); }",
      "const data = await this.authProvider.login(request.user);",
    ].join('\n');
    expect(good.search(/\.fail\b/)).toBeLessThan(good.search(/authProvider\.login\(/));
  });

  it('⚠️ 记录现状（不是断言它应该如此）：真正**使用** `AuthGuard(\'local\')` 的只有一个控制器，' +
    '所以"忘记检查 `.fail`"的风险面目前只有一个文件；新增第二处时这条会红，提醒重新评估', () => {
    expect(hits.map((h) => h.file)).toEqual(['src/controller/admin/auth/auth.controller.ts']);
  });

  it('空转反证：注释里提到这个守卫的文件**不算**命中（否则漂移守卫会被注释喂假阳性）', () => {
    // login.guard.ts 的注释里写着 AuthGuard('local')，剥注释后就不该再命中
    const guardSrc = stripCommentsForAnchor(
      readFileSync(resolve(__dirname, 'login.guard.ts'), 'utf-8'),
    );
    expect(readFileSync(resolve(__dirname, 'login.guard.ts'), 'utf-8')).toContain("AuthGuard('local')");
    expect(guardSrc.includes("AuthGuard('local')")).toBe(false);
    expect(hits.some((h) => h.file.endsWith('login.guard.ts'))).toBe(false);
  });
});
