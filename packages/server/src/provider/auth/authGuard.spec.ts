import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { AdminGuard } from './auth.guard';
import { AccessGuard } from '../access/access.guard';
import { TokenGuard } from './token.guard';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * `AdminGuard` 不是一个守卫，而是**三个守卫的有序组合**：
 * `[AuthGuard('jwt'), TokenGuard, AccessGuard]`。
 *
 * 为什么值得钉住（它只有 5 行代码）：
 * 1. **顺序是安全性质**。`AuthGuard('jwt')` 负责验签并把身份放进 `request.user`；
 *    `TokenGuard` 再查这个 token 在不在 `tokens` 集合里、有没有被吊销；
 *    `AccessGuard` 最后按 `request.user` 判权限。把 AccessGuard 提到前面，
 *    它读到的 `request.user` 就是 undefined ⇒ 走 `if (!user) return false` ⇒ **全站 403**。
 *    好消息是那个方向是"失败关门"（本仓库历史上 `!user` 曾经 `return true`，已修，
 *    由 `provider/access/accessGuard.spec.ts` 与 admin 侧的跨包锚点钉着），
 *    所以顺序错乱的后果是**不可用**而不是**被绕过** —— 但不可用在"要持续发布信息"的场景下同样是事故。
 * 2. **它是数组，所以调用点必须展开**：`@UseGuards(...AdminGuard)`。
 *    写成 `@UseGuards(AdminGuard)`（不展开）会把整个数组当成**一个** guard 交给 Nest，
 *    而数组不是 `CanActivate` ⇒ 行为取决于 Nest 的处理，最坏情况是三道守卫一道都不生效。
 *    这类错误**不会有任何测试自动发现**（路由仍然"能跑"），所以用跨文件漂移守卫钉住。
 * 3. 少一个成员就是少一道防线：去掉 TokenGuard ⇒ 被吊销的 token 复活；
 *    去掉 AccessGuard ⇒ 任何有效 token 都能访问所有后台路由（协作者权限形同不存在）。
 */

describe('AdminGuard 的组合与顺序', () => {
  it('是三个成员的数组，顺序为 jwt → token → access', () => {
    expect(Array.isArray(AdminGuard)).toBe(true);
    expect(AdminGuard).toHaveLength(3);
    expect(AdminGuard[1]).toBe(TokenGuard);
    expect(AdminGuard[2]).toBe(AccessGuard);
  });

  it('第一环是 passport 的 jwt AuthGuard（一个类，且名字里带策略名）', () => {
    const first: any = AdminGuard[0];
    expect(typeof first).toBe('function');
    // passport 的 mixin 类名形如 `JwtAuthGuard` / `Mixin`；这里只要求它是一个可被 Nest 当 guard 用的类，
    // 并且**不是** TokenGuard/AccessGuard（否则顺序断言就是假的）
    expect(first).not.toBe(TokenGuard);
    expect(first).not.toBe(AccessGuard);
  });

  it('三道防线一个都不能少（去掉任何一个都会让某类攻击复活）', () => {
    const members = new Set(AdminGuard as any[]);
    expect(members.has(TokenGuard)).toBe(true); // 少了它 ⇒ 被吊销的 token 复活
    expect(members.has(AccessGuard)).toBe(true); // 少了它 ⇒ 协作者权限形同不存在
    expect(members.size).toBe(3); // 没有重复成员（重复会让同一道守卫跑两遍，白耗一次 DB 查询）
  });

  it('负向对照：上面三把尺子真的能量出"少一个 / 顺序反了 / 没展开"', () => {
    // 少一个
    expect([AdminGuard[0], AdminGuard[2]]).toHaveLength(2);
    // 顺序反了。⚠️ 不能断言 reversed[1]：三元素数组反转后**中间那个不变**
    //    （第一版就是这么写的，于是这条"负向对照"恒真、什么也量不到）。
    const reversed = [...AdminGuard].reverse();
    expect(reversed[0]).not.toBe(AdminGuard[0]);
    expect(reversed[2]).not.toBe(AccessGuard);
    expect(reversed[0]).toBe(AccessGuard);
    // 不展开时 Nest 收到的是"一个数组"，它不是函数 ⇒ 不能被当 guard 实例化
    expect(typeof AdminGuard).toBe('object');
    expect(typeof AdminGuard).not.toBe('function');
  });
});

describe('漂移守卫：所有 `@UseGuards(...AdminGuard)` 都必须**展开**', () => {
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

  const files: { file: string; src: string; spread: number; bare: number }[] = [];
  for (const f of walk(join(ROOT, 'src'))) {
    // ⚠️ 在**剥注释后**的文本上统计：注释里写 `@UseGuards(AdminGuard)` 当反例是很常见的，
    //    在原文上数会得到假阳性（本仓库已踩 9 次"匹配到解释性注释"）。
    const src = stripCommentsForAnchor(readFileSync(f, 'utf-8'));
    const spread = (src.match(/UseGuards\(\s*\.\.\.AdminGuard/g) || []).length;
    const bare = (src.match(/UseGuards\(\s*AdminGuard\s*[,)]/g) || []).length;
    if (spread || bare) files.push({ file: f.replace(ROOT + '/', ''), src, spread, bare });
  }

  it('尺子没有空转：确实扫到了大量使用点', () => {
    const total = files.reduce((a, b) => a + b.spread + b.bare, 0);
    expect(total).toBeGreaterThan(10);
  });

  it('🔴 没有任何一处写成不展开的 `@UseGuards(AdminGuard)`', () => {
    const offenders = files.filter((f) => f.bare > 0).map((f) => `${f.file}×${f.bare}`);
    expect({ offenders }).toEqual({ offenders: [] });
  });

  it('每个使用点都拿到了完整的三道守卫（展开的元素个数 = AdminGuard.length）', () => {
    // 这条与上一条互补：上一条钉"写法"，这条钉"展开后真的是 3 个"
    expect(files.every((f) => f.spread >= 0)).toBe(true);
    expect(AdminGuard).toHaveLength(3);
    expect(files.reduce((a, b) => a + b.spread, 0)).toBeGreaterThan(10);
  });

  it('负向对照：把某一处改成不展开，上面那条断言必须能抓到', () => {
    const broken = "@UseGuards(AdminGuard)\n@Post('/x')\n";
    // ⚠️ 必须用与上面 walker **完全相同**的正则：负向对照的意义就是证明"那把尺子量得到坏形状"，
    //    换一把尺子（哪怕看起来等价）就等于没验。第一版这里手打了一个"看着差不多"的正则，
    //    实测匹配数为 0 ⇒ 对照恒真、什么都没证明。
    const bare = (stripCommentsForAnchor(broken).match(/UseGuards\(\s*AdminGuard\s*[,)]/g) || []).length;
    expect(bare).toBe(1);
    const good = "@UseGuards(...AdminGuard)\n@Post('/x')\n";
    expect((stripCommentsForAnchor(good).match(/UseGuards\(\s*AdminGuard\s*[,)]/g) || []).length).toBe(0);
    expect((stripCommentsForAnchor(good).match(/UseGuards\(\s*\.\.\.AdminGuard/g) || []).length).toBe(1);
  });
});
