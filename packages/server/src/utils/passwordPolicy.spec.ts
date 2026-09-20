import { BadRequestException, Logger } from '@nestjs/common';
import {
  assertAccessPasswordLength,
  ACCESS_PASSWORD_WARN_BELOW_LENGTH,
  MIN_ACCESS_PASSWORD_LENGTH,
  resolveAccessPasswordWrite,
  resolveAccessPasswordWriteAsync,
} from './accessPassword';
import { isScryptHash } from './crypto';
import {
  assertAccountPasswordStrength,
  isBrowserDerivedPassword,
  MAX_ACCOUNT_PASSWORD_LENGTH,
  MIN_ACCOUNT_PASSWORD_LENGTH,
} from '../provider/user/user.provider';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 口令长度策略：**账号口令 ≥10（硬拒）、访问密码 ≥4（硬拒）+ <8（WARN）**。
 *
 * ## 三条必须钉住的性质
 *
 *  1. **只约束"新设或修改"**。启动时不校验既有口令、登录时不校验输入的口令 ——
 *     否则升级本身就会把站长锁在站点外面，而"发不出内容"是这个部署最怕的失败模式。
 *  2. **同步与异步两个入口都约束**。访问密码有 `resolveAccessPasswordWrite` 与
 *     `…Async` 两个入口（异步是本轮为"哈希别阻塞事件循环"加的），只在一个入口上加校验
 *     就是留了一条绕过路径 —— 而且这种漂移在各自的测试里都看不出来。
 *  3. **导入/恢复路径不被误伤**。已经是 scrypt 哈希的值不参与长度判定，
 *     否则"恢复一份老备份"会因为里面某个短密码而整体失败。
 *
 * ## 一条必须写下来的架构事实（否则会以为服务端能强制账号口令长度）
 *
 * 后台所有账号口令入口都在浏览器里先 sha256 派生再发（`encryptPwd.js`），
 * 派生结果恒为 64 个十六进制字符、**与原始口令长度无关** ⇒ 服务端在数学上判不了
 * 原始强度。所以 `assertAccountPasswordStrength` 是**诚实的两分支**：
 * 派生形状放行（真正的 ≥10 由前端与 env bootstrap 负责），其它形状强制 ≥10
 * （覆盖脚本 / curl / 第三方集成这些直接拿原始口令调 API 的客户端）。
 */
describe('账号口令：assertAccountPasswordStrength', () => {
  const derived = 'a'.repeat(64); // 64 个小写十六进制字符 = 浏览器派生形状

  it('阈值就是裁定值（改动必须是有意的，不能顺手漂）', () => {
    expect(MIN_ACCOUNT_PASSWORD_LENGTH).toBe(10);
    expect(MAX_ACCOUNT_PASSWORD_LENGTH).toBe(200);
    expect(MIN_ACCESS_PASSWORD_LENGTH).toBe(4);
    expect(ACCESS_PASSWORD_WARN_BELOW_LENGTH).toBe(8);
  });

  it('浏览器派生形状被识别，且不因长度被拒（服务端看不到原始口令）', () => {
    expect(isBrowserDerivedPassword(derived)).toBe(true);
    expect(assertAccountPasswordStrength(derived, '管理员')).toBe(derived);
    // 真实的派生值（sha256 of 'x'）也认
    const realSha = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881';
    expect(isBrowserDerivedPassword(realSha)).toBe(true);
    expect(assertAccountPasswordStrength(realSha, '协作者')).toBe(realSha);
  });

  it('不是派生形状的大小写/长度变体都不算派生（判定不能放宽）', () => {
    for (const notDerived of [
      'A'.repeat(64), // 大写 hex
      'a'.repeat(63), // 短一位
      'a'.repeat(65), // 长一位
      'g'.repeat(64), // 非 hex 字符
      ` ${'a'.repeat(64)}`, // 带空白
      '', // 空
    ]) {
      expect(isBrowserDerivedPassword(notDerived)).toBe(false);
    }
  });

  it('原始口令 ≥10 ⇒ 通过（10 是边界，含）', () => {
    expect(assertAccountPasswordStrength('abcdefghij', '管理员')).toBe('abcdefghij');
    expect(assertAccountPasswordStrength('x'.repeat(200), '管理员').length).toBe(200);
  });

  it('原始口令 <10 ⇒ 400，消息点名最小长度、当前长度与理由', () => {
    for (const weak of ['1', 'ab', 'pwn12345', 'x'.repeat(9)]) {
      let caught: any = null;
      try {
        assertAccountPasswordStrength(weak, '管理员');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const message = String(caught.getResponse().message ?? caught.getResponse());
      expect(message).toContain('管理员'); // 说清是哪一类账号
      expect(message).toContain(String(MIN_ACCOUNT_PASSWORD_LENGTH)); // 可照做：最小多少
      expect(message).toContain(String(weak.length)); // 可照做：你现在是多少
      expect(message).toMatch(/太短/);
    }
  });

  it('空值 / 非字符串 ⇒ 400 且消息里保留既有措辞「密码不合法」（有跨包锚点钉着它）', () => {
    for (const bad of ['', null, undefined, 12345, {}, [], 'x'.repeat(201)]) {
      expect(() => assertAccountPasswordStrength(bad, '协作者')).toThrow(BadRequestException);
    }
    let caught: any = null;
    try {
      assertAccountPasswordStrength('', '协作者');
    } catch (err) {
      caught = err;
    }
    expect(String(caught.getResponse().message)).toMatch(/密码不合法/);
    expect(String(caught.getResponse().message)).toContain('协作者');
  });

  it('label 会出现在消息里（管理员与协作者要能区分）', () => {
    const msgOf = (label: string) => {
      try {
        assertAccountPasswordStrength('short', label);
      } catch (err: any) {
        return String(err.getResponse().message);
      }
      return '';
    };
    expect(msgOf('管理员')).toContain('管理员');
    expect(msgOf('协作者')).toContain('协作者');
  });

  /**
   * ⚠️ 这条钉的是一个**当前看不出来**的耦合，值得写清楚：
   *
   * `assertAccountPasswordStrength` 里那个"派生形状直接放行"的分支，在
   * `MIN_ACCOUNT_PASSWORD_LENGTH = 10` 时是**行为冗余**的 —— 派生值恒为 64 个字符，
   * 走不走那个分支都 ≥10，结果一样。所以它今天不是靠"挡住什么"来证明自己的价值，
   * 而是靠下面这个不变量：
   *
   *     下限一旦超过 64，派生分支就是唯一还能让后台登录/改密码工作的东西。
   *
   * 换句话说：如果哪天有人把下限调到 100（听起来"更安全"），没有那个分支的话
   * **所有** UI 路径都会被自己的下限拒掉（因为它们送来的都是 64 字符摘要），
   * 站长当场被锁在门外 —— 而这正是本轮反复强调的最坏失败模式。
   * 这条断言把"冗余"变成"有明确职责"，也防止有人顺手把分支当死代码删掉。
   */
  it('MIN 必须 ≤ 64（派生口令的长度），否则 UI 路径会被自己的下限全拒', () => {
    const DERIVED_LENGTH = 64;
    expect(MIN_ACCOUNT_PASSWORD_LENGTH).toBeLessThanOrEqual(DERIVED_LENGTH);
    // 反向证明这个耦合是真的：把下限抬到 65 时，"没有派生分支"的判定会拒掉派生值
    const judgeWithoutDerivedBranch = (value: string, min: number) =>
      value.length >= min; // ← 就是删掉派生分支后的形状
    expect(judgeWithoutDerivedBranch('a'.repeat(64), MIN_ACCOUNT_PASSWORD_LENGTH)).toBe(true);
    expect(judgeWithoutDerivedBranch('a'.repeat(64), 65)).toBe(false); // ← 抬到 65 就崩
    // 而有派生分支时，抬到 65 也不会拒掉 UI 送来的摘要
    expect(isBrowserDerivedPassword('a'.repeat(64))).toBe(true);
  });
});

describe('账号口令：校验点覆盖 + 不能蔓延到登录路径', () => {
  const userProviderSrc = () =>
    stripCommentsForAnchor(
      readFileSync(join(__dirname, '../provider/user/user.provider.ts'), 'utf-8'),
    );

  const bodyOf = (src: string, methodName: string) => {
    const start = src.indexOf(methodName);
    expect(start).toBeGreaterThan(-1);
    // 取到下一个方法定义之前，够覆盖方法体即可
    const next = src.indexOf('\n  async ', start + methodName.length);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it('改管理员密码（updateUser，也就是「忘记密码」恢复的落点）走统一入口', () => {
    const body = bodyOf(userProviderSrc(), 'async updateUser(');
    expect(body).toMatch(/assertAccountPasswordStrength\(password, '管理员'\)/);
    // 旧的内联判定不许回来（它只判空与超长，不判过短）
    expect(body).not.toMatch(/if \(!password \|\| password\.length > 200\)/);
  });

  it('建协作者与改协作者都走统一入口（经由 assertCollaboratorPassword）', () => {
    const src = userProviderSrc();
    expect(bodyOf(src, 'function assertCollaboratorPassword')).toMatch(
      /return assertAccountPasswordStrength\(password, '协作者'\)/,
    );
    expect(bodyOf(src, 'async createCollaborator(')).toMatch(/assertCollaboratorPassword\(/);
    expect(bodyOf(src, 'async updateCollaborator(')).toMatch(/assertCollaboratorPassword\(/);
  });

  it('负向对照：上面那几条在"校验被删掉"时必须失败（不是靠 import 行蒙过去的）', () => {
    const gutted = `
      function assertCollaboratorPassword(password: unknown): string {
        return String(password ?? '');
      }
      export class UserProvider {
        async updateUser(dto: any) {
          const password = dto.password;
          const nextPassword = await hashSecretAsync(password);
          return nextPassword;
        }
      }`;
    expect(gutted).not.toMatch(/assertAccountPasswordStrength\(password, '管理员'\)/);
    expect(gutted).not.toMatch(/return assertAccountPasswordStrength\(password, '协作者'\)/);
  });

  it('登录校验（validateUser）**不做**长度校验：口令太短的既有账号仍然能登进来', () => {
    // 这是"只对新设/修改生效"的核心：如果登录也校验，升级当天所有弱口令账号会被锁死，
    // 而站长唯一的自救路径（忘记密码）又要求设一个 ≥10 的新密码 —— 在急着发内容时是灾难。
    const body = bodyOf(userProviderSrc(), 'async validateUser(');
    expect(body).not.toMatch(/assertAccountPasswordStrength/);
    expect(body).not.toMatch(/MIN_ACCOUNT_PASSWORD_LENGTH/);
  });

  it('启动时的迁移（washUserWithSalt）也不做长度校验', () => {
    const body = bodyOf(userProviderSrc(), 'async washUserWithSalt(');
    expect(body).not.toMatch(/assertAccountPasswordStrength/);
  });
});

describe('访问密码：≥4 硬下限、<8 WARN', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  const warnings = () => warnSpy.mock.calls.map((call) => String(call[0])).join('\n');

  it('<4 ⇒ 400（1、2、3 个字符，含全空白被 trim 后不足 4 的）', () => {
    for (const weak of ['1', 'ab', 'abc', '  ab  ', '\t\n']) {
      // 全空白在 intent 阶段就算"没填"，不会走到长度校验；其余都该被拒
      if (weak.trim() === '') continue;
      expect(() => assertAccessPasswordLength(weak)).toThrow(BadRequestException);
    }
    let caught: any = null;
    try {
      assertAccessPasswordLength('abc');
    } catch (err) {
      caught = err;
    }
    const message = String(caught.getResponse().message);
    expect(message).toContain(String(MIN_ACCESS_PASSWORD_LENGTH));
    expect(message).toContain('3'); // 当前长度
    expect(message).toMatch(/匿名可达/); // 说清为什么这个下限不是形式主义
  });

  it('恰好 4 ⇒ 通过但 WARN（4~7 是"允许但不建议"）', () => {
    expect(() => assertAccessPasswordLength('abcd')).not.toThrow();
    expect(warnings()).toMatch(/只有 4 个字符/);
    expect(warnings()).toContain(String(ACCESS_PASSWORD_WARN_BELOW_LENGTH));
  });

  it('≥8 ⇒ 通过且不 WARN（正常长度不该产生噪音）', () => {
    expect(() => assertAccessPasswordLength('abcdefgh')).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('按 **trim 之后**的长度判：首尾空格不能把 2 位密码伪装成 6 位', () => {
    expect(() => assertAccessPasswordLength('  ab  ')).toThrow(BadRequestException);
    expect(() => assertAccessPasswordLength('  abcd  ')).not.toThrow();
  });

  it('已经是 scrypt 哈希的值不做长度判定（导入 / 整站恢复不能被误伤）', () => {
    const hashed = resolveAccessPasswordWrite({ password: 'a-long-enough-password' }, 'create').password!;
    expect(isScryptHash(hashed)).toBe(true);
    warnSpy.mockClear();
    expect(() => assertAccessPasswordLength(hashed)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ 上面那条用例其实**测不出**"跳过哈希"这个分支的价值 —— 真实哈希有 100+ 个字符，
   * 有没有那个早退都既不抛也不 WARN。变异对照实测：删掉早退 ⇒ **0 红**。
   *
   * 这个分支唯一可观测的地方是 WARN：`isScryptHash` 只看 `scrypt$` 前缀，所以一个
   * 7 个字符的 `'scrypt$'` 也算"已是哈希"，而 7 < 8 会触发 WARN。下面这条把它钉住，
   * 于是删掉早退真的会红（M7 从 0 红变成 1 红）。
   *
   * 顺带记录一个不变量：任何满足 `isScryptHash` 的字符串至少 7 个字符（前缀本身），
   * 所以"跳过长度校验"**永远不可能**让一个 <4 的值蒙过去 —— 这个早退不会削弱下限。
   */
  it('前缀形状的畸形值（"scrypt$"）被当成已哈希：不抛、也不 WARN', () => {
    expect(isScryptHash('scrypt$')).toBe(true);
    expect('scrypt$'.length).toBeGreaterThanOrEqual(MIN_ACCESS_PASSWORD_LENGTH);
    warnSpy.mockClear();
    expect(() => assertAccessPasswordLength('scrypt$')).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled(); // ← 没有早退的话这里会 WARN（7 < 8）
  });

  it('同步入口强制下限', () => {
    expect(() => resolveAccessPasswordWrite({ password: 'abc' }, 'create')).toThrow(
      BadRequestException,
    );
    expect(() => resolveAccessPasswordWrite({ password: 'abc' }, 'update')).toThrow(
      BadRequestException,
    );
  });

  it('异步入口**同样**强制下限（只加一边就是留了一条绕过路径）', async () => {
    await expect(
      resolveAccessPasswordWriteAsync({ password: 'abc' }, 'create'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      resolveAccessPasswordWriteAsync({ password: 'abc' }, 'update'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('两个入口对同一组输入的判定逐条一致（防止同步/异步漂移）', async () => {
    const inputs: Array<[any, 'create' | 'update']> = [
      [{ password: 'abc' }, 'create'],
      [{ password: 'abc' }, 'update'],
      [{ password: 'abcd' }, 'create'],
      [{ password: 'a-long-enough-password' }, 'update'],
      [{ password: '' }, 'create'],
      [{ password: '' }, 'update'],
      [{ password: '   ' }, 'update'],
      [{ clearPassword: true }, 'update'],
      [{ password: 'abcd', clearPassword: true }, 'update'],
      [{ password: 12345 }, 'create'],
      [{}, 'create'],
      [null, 'update'],
    ];
    for (const [input, mode] of inputs) {
      const sync = await run(() => resolveAccessPasswordWrite(input, mode));
      const async = await run(() => resolveAccessPasswordWriteAsync(input, mode));
      // 抛同样的错，或返回同样的写入决策
      expect({ input, mode, async }).toEqual({ input, mode, async: sync });
    }
  });

  it('清除密码与"留空不动"这两条路不受长度下限影响', async () => {
    expect(resolveAccessPasswordWrite({ clearPassword: true }, 'update')).toEqual({
      password: '',
      hashed: false,
      cleared: true,
    });
    expect(resolveAccessPasswordWrite({ password: '' }, 'update').password).toBeUndefined();
    expect((await resolveAccessPasswordWriteAsync({ password: '' }, 'create')).password).toBe('');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('访问密码：下限只在写入路径上，不在读取/校验路径上', () => {
  it('校验既有短密码的文章仍然能解锁（否则老文章永久打不开）', async () => {
    // 直接构造一个"库里已有的短密码哈希"：绕过写入校验，模拟本轮之前设的 2 位密码
    const { hashAccessPasswordIdempotent } = await import('./accessPassword');
    const { verifyAccessPassword } = await import('./crypto');
    const stored = hashAccessPasswordIdempotent('ab'); // 2 个字符
    expect(isScryptHash(stored)).toBe(true);
    expect(verifyAccessPassword(stored, 'ab')).toBe(true);
    expect(verifyAccessPassword(stored, 'wrong')).toBe(false);
  });
});

/**
 * 把"抛异常"与"返回值"都收敛成可比较的形状，便于同步/异步逐条对拍。
 *
 * ⚠️ 哈希值本身**不能**直接比：scrypt 每次带随机盐，同步与异步两次调用一定不相等。
 * 要比的是"写入决策"—— 是哈希 / 是空串（清除）/ 是不动（undefined），加上两个布尔标记。
 */
async function run(fn: () => any) {
  try {
    const value = await fn();
    const normalized =
      value && typeof value === 'object' && 'hashed' in value
        ? {
            hashed: value.hashed,
            cleared: value.cleared,
            passwordShape:
              value.password === undefined
                ? 'undefined'
                : value.password === ''
                  ? 'empty'
                  : isScryptHash(value.password)
                    ? 'scrypt'
                    : 'other',
          }
        : value;
    return { threw: false, normalized };
  } catch (err: any) {
    return {
      threw: true,
      // 只比较状态码与消息：异常对象本身带栈，逐条对拍会很吵
      status: err?.status ?? err?.getStatus?.(),
      message: String(err?.getResponse?.().message ?? err?.message ?? err),
    };
  }
}

describe('「忘记密码」恢复接口：口令校验走同一个入口', () => {
  const src = () =>
    stripCommentsForAnchor(
      readFileSync(join(__dirname, '../controller/admin/auth/auth.controller.ts'), 'utf-8'),
    );

  it('restore() 调用统一入口，而不是自己抄一份长度判定', () => {
    const body = src().slice(src().indexOf('async restore('));
    expect(body).toMatch(/assertAccountPasswordStrength\(password, '管理员'\)/);
    // 旧的独立副本不许回来：两份校验一定会漂移（下限只加在一边就是这么来的）
    expect(body).not.toMatch(/if \(!password \|\| password\.length > 200\)/);
  });

  it('负向对照：把统一入口换回内联判定时，上面那条必须失败', () => {
    const reverted = stripCommentsForAnchor(`
      async restore() {
        if (!password || password.length > 200) {
          throw new BadRequestException('密码不合法（1-200 个字符）');
        }
        await this.userProvider.updateUser({ name, password });
      }`);
    expect(reverted).not.toMatch(/assertAccountPasswordStrength\(password, '管理员'\)/);
    expect(reverted).toMatch(/if \(!password \|\| password\.length > 200\)/);
  });
});
