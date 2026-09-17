/**
 * `utils/accessPassword.ts` 的纯规则钉子（不碰 DB）。
 *
 * 这个模块是文章/分类访问密码「怎么存、怎么下发」的唯一真源，两边（article.provider、
 * category.provider、两个 schema 的 toJSON）都引用它，所以规则本身必须逐条钉死：
 *
 *  - 三态写入契约（填新值 / 留空=不修改 / clearPassword=显式清除）；
 *  - 幂等（已经是 scrypt 的值绝不二次哈希）；
 *  - 空值语义（'' 不会变成"空串的哈希"）；
 *  - 脱敏的"键存在才动"规则（公开面投影没 select password ⇒ 响应一个字节都不变）。
 *
 * 负控（已实测）：把 `resolveAccessPasswordWrite` 里的 `hashAccessPasswordIdempotent`
 * 换成 `String(text)`（= 退回明文存储），下面「明文绝不落库」那组立刻红；
 * 把 `redactPasswordInPlain` 的 `delete plain.password` 删掉，脱敏那组立刻红。
 */
import { BadRequestException } from '@nestjs/common';
import {
  CLEAR_PASSWORD_FIELD,
  SECRET_EVENT_FIELDS,
  accessPasswordToJson,
  carryAccessSecretFields,
  redactAccessSecretDeep,
  hasAccessPasswordValue,
  hashAccessPasswordIdempotent,
  isClearPasswordFlag,
  redactAccessSecret,
  redactAccessSecretList,
  redactPasswordInPlain,
  resolveAccessPasswordWrite,
} from './accessPassword';
import { isScryptHash, verifyAccessPassword } from './crypto';

describe('isClearPasswordFlag：只认 true / "true"', () => {
  it('布尔 true 与字符串 "true" 算显式清除', () => {
    expect(isClearPasswordFlag(true)).toBe(true);
    expect(isClearPasswordFlag('true')).toBe(true);
  });
  it('其它真值一律当没传（宁可"没清掉"也不要"意外清掉"）', () => {
    for (const v of [1, '1', 'yes', 'TRUE', 'True', {}, [], false, 'false', null, undefined, '']) {
      expect(isClearPasswordFlag(v)).toBe(false);
    }
  });
  it('导出给 DTO/前端对齐用的字段名是 clearPassword', () => {
    expect(CLEAR_PASSWORD_FIELD).toBe('clearPassword');
  });
});

describe('resolveAccessPasswordWrite：update 模式（编辑既有文章/分类）', () => {
  it('填了新密码 ⇒ scrypt 哈希，明文不出现在结果里', () => {
    const res = resolveAccessPasswordWrite({ password: 'abc123' }, 'update');
    expect(res.hashed).toBe(true);
    expect(res.cleared).toBe(false);
    expect(isScryptHash(res.password)).toBe(true);
    expect(res.password).not.toContain('abc123');
    expect(verifyAccessPassword(res.password, 'abc123')).toBe(true);
  });

  it('留空 / 缺键 / 全空白 ⇒ password 是 undefined（= 不修改，不是清空）', () => {
    for (const input of [{ password: '' }, {}, { password: '   ' }, { password: '\t\n' }, null, undefined]) {
      const res = resolveAccessPasswordWrite(input as any, 'update');
      expect(res.password).toBeUndefined();
      expect(res.hashed).toBe(false);
      expect(res.cleared).toBe(false);
    }
  });

  it('clearPassword: true ⇒ 存空串（显式解除加密）', () => {
    const res = resolveAccessPasswordWrite({ clearPassword: true }, 'update');
    expect(res.password).toBe('');
    expect(res.cleared).toBe(true);
    expect(res.hashed).toBe(false);
  });

  it('"设新密码" 与 "清除" 同时给 ⇒ 400（两种意图冲突，不能猜）', () => {
    expect(() =>
      resolveAccessPasswordWrite({ password: 'abc', clearPassword: true }, 'update'),
    ).toThrow(BadRequestException);
    expect(() =>
      resolveAccessPasswordWrite({ password: 'abc', clearPassword: 'true' }, 'update'),
    ).toThrow(BadRequestException);
  });

  it('clearPassword: true + 空密码 ⇒ 正常清除（空不算"设新密码"）', () => {
    for (const input of [
      { password: '', clearPassword: true },
      { password: '   ', clearPassword: true },
      { clearPassword: true },
    ]) {
      expect(resolveAccessPasswordWrite(input as any, 'update').password).toBe('');
    }
  });

  it('password 不是字符串 ⇒ 400（不把 12345 / {} 悄悄 String() 成密码）', () => {
    for (const bad of [12345, 0, true, {}, [], Symbol('x') as any]) {
      expect(() => resolveAccessPasswordWrite({ password: bad } as any, 'update')).toThrow(
        BadRequestException,
      );
    }
  });

  it('null password 当作没填（JSON 里显式 null 是常见形状）', () => {
    expect(resolveAccessPasswordWrite({ password: null } as any, 'update').password).toBeUndefined();
  });
});

describe('resolveAccessPasswordWrite：create 模式（新建 / 发布草稿）', () => {
  it('留空 ⇒ 空串（= 不加密），而不是 undefined', () => {
    for (const input of [{ password: '' }, {}, { password: '  ' }]) {
      expect(resolveAccessPasswordWrite(input as any, 'create').password).toBe('');
    }
  });

  it('填了密码 ⇒ 哈希', () => {
    const res = resolveAccessPasswordWrite({ password: 'pw' }, 'create');
    expect(isScryptHash(res.password)).toBe(true);
    expect(verifyAccessPassword(res.password, 'pw')).toBe(true);
  });

  it('clearPassword: true ⇒ 空串（新建时等价于"不加密"）', () => {
    expect(resolveAccessPasswordWrite({ clearPassword: true }, 'create').password).toBe('');
  });
});

describe('hashAccessPasswordIdempotent：幂等（防止把哈希再哈希一次）', () => {
  it('已经是 scrypt 的值原样返回', () => {
    const hash = hashAccessPasswordIdempotent('first');
    expect(isScryptHash(hash)).toBe(true);
    expect(hashAccessPasswordIdempotent(hash)).toBe(hash);
    // 反复调用多少次都不变（导入 → 导出 → 再导入 的往返也安全）
    expect(hashAccessPasswordIdempotent(hashAccessPasswordIdempotent(hash))).toBe(hash);
    expect(verifyAccessPassword(hash, 'first')).toBe(true);
  });

  it('空值 ⇒ 空串（"空串的哈希" 会把全站文章锁死）', () => {
    expect(hashAccessPasswordIdempotent('')).toBe('');
    expect(hashAccessPasswordIdempotent(undefined)).toBe('');
    expect(hashAccessPasswordIdempotent(null)).toBe('');
  });

  it('明文 ⇒ scrypt 哈希，且原密码能校验通过', () => {
    const hash = hashAccessPasswordIdempotent('明文密码');
    expect(isScryptHash(hash)).toBe(true);
    expect(verifyAccessPassword(hash, '明文密码')).toBe(true);
    expect(verifyAccessPassword(hash, '明文密码 ')).toBe(false);
  });

  it('用户真的想用 "scrypt$..." 当密码这种畸形输入不会被误判成已哈希', () => {
    // 只有**前缀**匹配就当已哈希是刻意的取舍：真拿这种字符串当密码的人会锁死自己，
    // 而"把哈希再哈希一次"会静默毁掉整站备份的往返。这条用例把这个取舍写下来。
    const weird = 'scrypt$not-a-real-hash';
    expect(hashAccessPasswordIdempotent(weird)).toBe(weird);
  });
});

describe('hasAccessPasswordValue：什么算"设了密码"', () => {
  it('非空字符串算设了；空串/undefined/null 算没设', () => {
    expect(hasAccessPasswordValue('x')).toBe(true);
    expect(hasAccessPasswordValue(' ')).toBe(true); // 空白也是"设了"（历史上就能这么存）
    expect(hasAccessPasswordValue('')).toBe(false);
    expect(hasAccessPasswordValue(undefined)).toBe(false);
    expect(hasAccessPasswordValue(null)).toBe(false);
  });
});

describe('redactPasswordInPlain / redactAccessSecret：下发脱敏（P3）', () => {
  it('有 password 键 ⇒ 换成布尔 hasPassword，原键删掉', () => {
    expect(redactPasswordInPlain({ id: 1, password: 'scrypt$x' })).toEqual({
      id: 1,
      hasPassword: true,
    });
    expect(redactPasswordInPlain({ id: 1, password: 'legacy-plain' })).toEqual({
      id: 1,
      hasPassword: true,
    });
    expect(redactPasswordInPlain({ id: 1, password: '' })).toEqual({ id: 1, hasPassword: false });
  });

  it('没有 password 键（公开面投影）⇒ 一个字节都不改，也不会多出 hasPassword', () => {
    const publicItem = { id: 1, title: 't', private: true };
    expect(redactPasswordInPlain({ ...publicItem })).toEqual(publicItem);
  });

  it('password: undefined（listView 展开产物）⇒ 只删键，不下"没设密码"这种骗人的结论', () => {
    const out = redactPasswordInPlain({ id: 1, title: 't', password: undefined });
    expect('password' in out).toBe(false);
    expect('hasPassword' in out).toBe(false);
  });

  it('redactAccessSecret 对普通对象与"带 toJSON 的文档"都管用', () => {
    expect(redactAccessSecret({ id: 1, password: 'p' })).toEqual({ id: 1, hasPassword: true });
    const fakeDoc = {
      _doc: { id: 2, password: 'p2' },
      toJSON: () => ({ id: 2, hasPassword: true }), // schema transform 已经处理过
    };
    expect(redactAccessSecret(fakeDoc as any)).toEqual({ id: 2, hasPassword: true });
    const docWithoutToJson = { _doc: { id: 3, password: 'p3' } };
    expect(redactAccessSecret(docWithoutToJson as any)).toEqual({ id: 3, hasPassword: true });
  });

  it('redactAccessSecret 对 null / undefined 原样返回（别让坏形状打成 500）', () => {
    expect(redactAccessSecret(null)).toBeNull();
    expect(redactAccessSecret(undefined)).toBeUndefined();
  });

  it('redactAccessSecretList 处理数组，非数组原样返回', () => {
    expect(redactAccessSecretList([{ password: 'a' }, { password: '' }])).toEqual([
      { hasPassword: true },
      { hasPassword: false },
    ]);
    expect(redactAccessSecretList(undefined as any)).toBeUndefined();
  });

  it('accessPasswordToJson 能直接当 mongoose 的 toJSON transform 用', () => {
    const ret = { id: 9, title: 't', password: 'scrypt$y' };
    expect(accessPasswordToJson({}, ret)).toEqual({ id: 9, title: 't', hasPassword: true });
    // transform 必须**返回** ret（mongoose 用返回值当序列化结果）
    expect(accessPasswordToJson({}, ret)).toBe(ret);
  });

  it('脱敏是幂等的：过两遍不会把 hasPassword 弄丢或变成 false', () => {
    const once = redactAccessSecret({ id: 1, password: 'p' });
    const twice = redactAccessSecret(once);
    expect(twice).toEqual({ id: 1, hasPassword: true });
  });
});

describe('redactAccessSecretDeep：事件 payload / 日志的脱敏（G5）', () => {
  it('摘掉 password 与 clearPassword，补一个布尔 hasPassword，且**不改入参**', () => {
    const dto: any = { title: 't', password: 'plain', clearPassword: false, private: true };
    const out: any = redactAccessSecretDeep(dto);
    expect(out).toEqual({ title: 't', private: true, hasPassword: true });
    expect('password' in out).toBe(false);
    expect('clearPassword' in out).toBe(false);
    // 入参一个字节都不动（控制器还要拿它去写库）
    expect(dto).toStrictEqual({ title: 't', password: 'plain', clearPassword: false, private: true });
  });

  it('空密码 ⇒ hasPassword: false（脚本能区分"没设"与"这次在改"）', () => {
    expect((redactAccessSecretDeep({ password: '' }) as any).hasPassword).toBe(false);
    expect((redactAccessSecretDeep({ password: '  ' }) as any).hasPassword).toBe(true);
  });

  it('没有 password 键 ⇒ 不会凭空多出一个 hasPassword', () => {
    const out: any = redactAccessSecretDeep({ title: 't' });
    expect('hasPassword' in out).toBe(false);
  });

  it('要摘的键就是这两个（防止以后加了别的密文字段却忘了登记）', () => {
    expect([...SECRET_EVENT_FIELDS].sort()).toEqual(['clearPassword', 'password']);
  });
});

describe('carryAccessSecretFields：流水线改写 DTO 后的密码意图透传', () => {
  it('脚本没给 password ⇒ 用调用方的原值', () => {
    expect(carryAccessSecretFields({ password: 'pw', title: 'a' }, { title: 'b' })).toEqual({
      title: 'b',
      password: 'pw',
    });
  });

  it('脚本自己给了值 ⇒ **不覆盖**（clearPassword 是脚本的合法意图）', () => {
    expect(
      carryAccessSecretFields({ password: 'pw' }, { password: 'script-pw' }),
    ).toEqual({ password: 'script-pw' });
    expect(carryAccessSecretFields({ clearPassword: true }, { clearPassword: false })).toEqual({
      clearPassword: false,
    });
  });

  it('调用方 DTO 里没有这个键 ⇒ 不会凭空加一个（否则"留空=不修改"就被破坏成"留空=清空"）', () => {
    expect(carryAccessSecretFields({ title: 'a' }, { title: 'b' })).toEqual({ title: 'b' });
    expect('password' in carryAccessSecretFields({ title: 'a' }, { title: 'b' })).toBe(false);
    expect('password' in carryAccessSecretFields({ password: undefined }, { title: 'b' })).toBe(false);
  });

  it('只透传顶层：嵌套对象里的 password 不管（脚本 output 的形状由脚本负责）', () => {
    const out: any = carryAccessSecretFields(
      { nested: { password: 'deep' } } as any,
      { nested: { other: 1 } } as any,
    );
    expect(out.nested).toEqual({ other: 1 });
    expect(JSON.stringify(out)).not.toContain('deep');
  });

  it('不改入参：返回的是新对象', () => {
    const original: any = { password: 'pw' };
    const rewritten: any = { title: 'b' };
    const out = carryAccessSecretFields(original, rewritten);
    expect(out).not.toBe(rewritten);
    expect('password' in rewritten).toBe(false);
  });

  it('坏形状容错：original/rewritten 缺失时原样返回 rewritten', () => {
    expect(carryAccessSecretFields(null, { a: 1 } as any)).toEqual({ a: 1 });
    expect(carryAccessSecretFields(undefined, { a: 1 } as any)).toEqual({ a: 1 });
    expect(carryAccessSecretFields({ password: 'pw' }, null as any)).toBeNull();
  });
});
