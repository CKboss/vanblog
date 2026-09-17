/**
 * 文章访问密码：**写入哈希化 + 响应脱敏 + 明文清洗**（P1/P2/P3 的钉子）。
 *
 * 为什么需要这一组：`utils/crypto.ts` 早就有 `hashAccessPassword()`，但它**一个生产
 * 调用方都没有** —— 写入路径一直存明文。这里逐条钉住现在的契约：
 *
 *  1. create / updateById 存的是 scrypt 哈希，不是明文；
 *  2. 幂等：已经是哈希的值不会被二次哈希（导入/恢复回来的文档就是这种）；
 *  3. 空密码仍然是空字符串，不会变成"空串的哈希"（否则全站文章都被锁死）；
 *  4. update 时**留空 = 不修改**（patch 里根本没有 password 键），
 *     解除加密只能走显式 `clearPassword: true`；两者同时给 ⇒ 400；
 *  5. 写时升级：任何一次保存都会把存量明文顺手换成哈希（从不重启也能收敛）；
 *  6. 管理端列表出口不带 password，只带布尔 hasPassword；
 *  7. 启动 wash 幂等、有界、可中断。
 *
 * 负控（已实测，见交付报告）：把 `resolveAccessPasswordWrite` 换成"直接存明文"、
 * 把 `getByOption` 出口的 `redactAccessSecretList` 删掉、把 wash 的 `isScryptHash`
 * 判断删掉，对应用例分别变红。
 */
import { BadRequestException } from '@nestjs/common';
import { ArticleProvider } from './article.provider';
import { isScryptHash, verifyAccessPassword } from 'src/utils/crypto';

/** 极简查询匹配器：够本文件用到的 $and/$or/$exists/$ne/$nin/$in 就行 */
function matchQuery(doc: any, query: any): boolean {
  if (!query || typeof query !== 'object') {
    return true;
  }
  for (const [key, cond] of Object.entries(query)) {
    if (key === '$and') {
      if (!(cond as any[]).every((c) => matchQuery(doc, c))) return false;
      continue;
    }
    if (key === '$or') {
      if (!(cond as any[]).some((c) => matchQuery(doc, c))) return false;
      continue;
    }
    const value = doc?.[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const ops = cond as any;
      let ok = true;
      if ('$exists' in ops) ok = ok && Boolean(ops.$exists) === (value !== undefined);
      if (ok && '$ne' in ops) ok = ok && value !== ops.$ne;
      if (ok && '$nin' in ops) ok = ok && !(ops.$nin as any[]).includes(value);
      if (ok && '$in' in ops) ok = ok && (ops.$in as any[]).includes(value);
      if (ok && '$lte' in ops) ok = ok && value <= ops.$lte;
      if (ok && '$gte' in ops) ok = ok && value >= ops.$gte;
      if (!ok) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function project(doc: any, projection: any) {
  if (!projection || typeof projection !== 'object') {
    return { ...doc };
  }
  const keys = Object.keys(projection).filter((k) => projection[k]);
  const out: any = {};
  // mongoose 默认带 _id，除非投影里显式写了 _id: 0
  if (projection._id !== 0 && doc._id !== undefined) out._id = doc._id;
  for (const k of keys) {
    if (k in doc) out[k] = doc[k];
  }
  return out;
}

function createMemoryArticleModel(initial: any[] = []) {
  const docs = initial.map((d, i) => ({ _id: d._id ?? `oid${i + 1}`, ...d }));
  const captured: Array<{ method: string; args: any }> = [];
  const chainFrom = (rows: any[]) => {
    const chain: any = {
      sort: () => chain,
      skip: () => chain,
      limit: (n: number) => (n > 0 ? chainFrom(rows.slice(0, n)) : chain),
      maxTimeMS: () => chain,
      lean: () => chain,
      exec: async () => rows,
      countDocuments: async () => rows.length,
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  };
  const model: any = function FakeModel(dto: any) {
    Object.assign(this, dto);
    this.save = async () => {
      const created = { _id: `oid${docs.length + 1}`, ...this };
      delete created.save;
      docs.push(created);
      return created;
    };
  };
  model.docs = docs;
  model.captured = captured;
  model.find = (query: any, projection?: any) => {
    captured.push({ method: 'find', args: { query, projection } });
    return chainFrom(docs.filter((d) => matchQuery(d, query)).map((d) => project(d, projection)));
  };
  model.findOne = (query: any, projection?: any) => {
    captured.push({ method: 'findOne', args: { query, projection } });
    const hit = docs.find((d) => matchQuery(d, query));
    return { exec: async () => (hit ? project(hit, projection) : null) };
  };
  model.countDocuments = (query: any) => {
    captured.push({ method: 'countDocuments', args: { query } });
    return { exec: async () => docs.filter((d) => matchQuery(d, query)).length };
  };
  model.updateOne = (query: any, patch: any) => {
    captured.push({ method: 'updateOne', args: { query, patch } });
    const hit = docs.find((d) => matchQuery(d, query));
    if (hit) Object.assign(hit, patch);
    return { exec: async () => ({ matchedCount: hit ? 1 : 0, modifiedCount: hit ? 1 : 0 }) };
  };
  model.aggregate = () => ({ allowDiskUse: () => ({ exec: async () => [] }) });
  return model;
}

function createProvider(model: any) {
  return new ArticleProvider(
    model,
    { find: () => ({ exec: async () => [] }) } as any,
    { updateTotalWords: () => undefined, getSiteInfo: async () => ({}) } as any,
    {} as any,
  );
}

/** 取最近一次 updateOne 的 patch */
function lastPatch(model: any) {
  const calls = model.captured.filter((c: any) => c.method === 'updateOne');
  return calls[calls.length - 1]?.args?.patch;
}

describe('文章访问密码：写入即哈希（P1）', () => {
  it('create：明文入参落成 scrypt 哈希，且原密码仍能校验通过', async () => {
    const model = createMemoryArticleModel();
    const provider = createProvider(model);
    const created: any = await provider.create({
      title: '加密文',
      category: '随笔',
      private: true,
      password: 'top-secret',
    } as any);

    expect(isScryptHash(created.password)).toBe(true);
    expect(created.password).not.toContain('top-secret');
    expect(verifyAccessPassword(created.password, 'top-secret')).toBe(true);
    expect(verifyAccessPassword(created.password, 'wrong')).toBe(false);
    // 同一明文两次哈希结果不同（随机盐），但都能校验 —— 说明存的不是一张查找表
    const other: any = await provider.create({
      title: '第二篇',
      category: '随笔',
      private: true,
      password: 'top-secret',
    } as any);
    expect(other.password).not.toBe(created.password);
    expect(verifyAccessPassword(other.password, 'top-secret')).toBe(true);
  });

  it('create：留空 / 缺键 ⇒ 存空串，绝不会变成"空串的哈希"', async () => {
    const model = createMemoryArticleModel();
    const provider = createProvider(model);
    const blank: any = await provider.create({ title: 'a', category: 'c', password: '' } as any);
    const missing: any = await provider.create({ title: 'b', category: 'c' } as any);
    expect(blank.password).toBe('');
    expect(missing.password ?? '').toBe('');
    expect(isScryptHash(blank.password)).toBe(false);
  });

  it('create：已经是 scrypt 的值**原样入库**（幂等，不二次哈希）', async () => {
    const model = createMemoryArticleModel();
    const provider = createProvider(model);
    const hash =
      'scrypt$16384$8$1$Zm9vZm9vZm9vZm9vZm9vZm8=$v1DwS4fsk82l/b3F0HhNoh51m4SPGJpPnrzK32SCfvc0Q+nVd0iP/pQi6AgYrLhhnHOSXlUPiZ+Xdu9XvyYBdg==';
    const created: any = await provider.create({
      title: '导入回来的',
      category: 'c',
      password: hash,
    } as any);
    expect(created.password).toBe(hash);
  });

  it('create：clearPassword 与 schema 字段之外的键都不进库', async () => {
    const model = createMemoryArticleModel();
    const provider = createProvider(model);
    const created: any = await provider.create({
      title: 'x',
      category: 'c',
      clearPassword: true,
    } as any);
    expect(created.password).toBe('');
    expect('clearPassword' in created).toBe(false);
  });
});

describe('文章访问密码：更新的三态契约（P1）', () => {
  const seed = () =>
    createMemoryArticleModel([
      { id: 1, title: 't', category: 'c', password: '', deleted: false },
    ]);

  it('填了新密码 ⇒ patch 里是 scrypt 哈希（明文绝不出现在写库语句里）', async () => {
    const model = seed();
    const provider = createProvider(model);
    await provider.updateById(1, { password: 'new-pw' } as any);
    const patch = lastPatch(model);
    expect(isScryptHash(patch.password)).toBe(true);
    expect(JSON.stringify(model.captured)).not.toContain('new-pw');
    expect(verifyAccessPassword(patch.password, 'new-pw')).toBe(true);
  });

  it('留空 / 缺键 ⇒ patch 里**没有 password 这个键**（= 不修改，不是清空）', async () => {
    for (const dto of [{ password: '' }, { password: '   ' }, {}]) {
      const model = createMemoryArticleModel([
        { id: 1, title: 't', category: 'c', password: 'scrypt$16384$8$1$aa==$bb==', deleted: false },
      ]);
      const provider = createProvider(model);
      await provider.updateById(1, dto as any);
      const patch = lastPatch(model);
      expect(Object.prototype.hasOwnProperty.call(patch, 'password')).toBe(false);
      // 原值一个字都没动
      expect(model.docs[0].password).toBe('scrypt$16384$8$1$aa==$bb==');
    }
  });

  it('clearPassword: true ⇒ patch.password === ""（显式解除加密）', async () => {
    const model = createMemoryArticleModel([
      { id: 1, title: 't', category: 'c', password: 'scrypt$16384$8$1$aa==$bb==', deleted: false },
    ]);
    const provider = createProvider(model);
    await provider.updateById(1, { clearPassword: true } as any);
    expect(lastPatch(model).password).toBe('');
    expect(model.docs[0].password).toBe('');
    // clearPassword 本身不进库
    expect('clearPassword' in model.docs[0]).toBe(false);
  });

  it('字符串 "true" 也算显式清除（查询串/表单两种形状都能用）', async () => {
    const model = seed();
    const provider = createProvider(model);
    await provider.updateById(1, { clearPassword: 'true' } as any);
    expect(lastPatch(model).password).toBe('');
  });

  it('同时"设新密码 + 清除" ⇒ 400，且**一个字都没写**', async () => {
    const model = seed();
    const provider = createProvider(model);
    await expect(
      provider.updateById(1, { password: 'abc', clearPassword: true } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(model.captured.some((c: any) => c.method === 'updateOne')).toBe(false);
  });

  it('password 不是字符串 ⇒ 400（不接受把数字/对象 String() 成密码）', async () => {
    const model = seed();
    const provider = createProvider(model);
    await expect(provider.updateById(1, { password: 12345 } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('clearPassword 的其它真值（1 / "yes"）当没传 —— 宁可没清掉也不要意外清掉', async () => {
    for (const flag of [1, 'yes', 'TRUE']) {
      const model = createMemoryArticleModel([
        { id: 1, title: 't', category: 'c', password: 'scrypt$16384$8$1$aa==$bb==', deleted: false },
      ]);
      const provider = createProvider(model);
      await provider.updateById(1, { clearPassword: flag } as any);
      expect(Object.prototype.hasOwnProperty.call(lastPatch(model), 'password')).toBe(false);
      expect(model.docs[0].password).toBe('scrypt$16384$8$1$aa==$bb==');
    }
  });
});

describe('文章访问密码：写时升级存量明文（P2）', () => {
  it('任何一次保存都会把历史明文换成哈希，且原密码仍能解锁', async () => {
    const model = createMemoryArticleModel([
      { id: 1, title: 't', category: 'c', password: 'legacy-plain', deleted: false },
    ]);
    const provider = createProvider(model);
    // 这次保存只改标题，压根没碰密码字段
    await provider.updateById(1, { title: '新标题' } as any);
    const patch = lastPatch(model);
    expect(isScryptHash(patch.password)).toBe(true);
    expect(verifyAccessPassword(patch.password, 'legacy-plain')).toBe(true);
    expect(isScryptHash(model.docs[0].password)).toBe(true);
  });

  it('存量已经是哈希 ⇒ 不重写 password 键（幂等，绝不二次哈希）', async () => {
    const hash = 'scrypt$16384$8$1$aa==$bb==';
    const model = createMemoryArticleModel([
      { id: 1, title: 't', category: 'c', password: hash, deleted: false },
    ]);
    const provider = createProvider(model);
    await provider.updateById(1, { title: '新标题' } as any);
    expect(Object.prototype.hasOwnProperty.call(lastPatch(model), 'password')).toBe(false);
    expect(model.docs[0].password).toBe(hash);
  });

  it('存量密码为空 ⇒ 不写 password（不会把"没加密"变成"加密成空串的哈希"）', async () => {
    const model = createMemoryArticleModel([
      { id: 1, title: 't', category: 'c', password: '', deleted: false },
    ]);
    const provider = createProvider(model);
    await provider.updateById(1, { title: '新标题' } as any);
    expect(Object.prototype.hasOwnProperty.call(lastPatch(model), 'password')).toBe(false);
  });

  it('读取存量密码失败只 WARN，不把保存本身带崩', async () => {
    const model = createMemoryArticleModel([
      { id: 1, title: 't', category: 'c', password: 'legacy-plain', deleted: false },
    ]);
    const provider = createProvider(model);
    // 第一次 findOne（升级用的那次）抛错
    const realFindOne = model.findOne;
    let calls = 0;
    model.findOne = (query: any, projection: any) => {
      calls += 1;
      if (projection && projection.password) {
        return { exec: async () => { throw new Error('db 抖动'); } };
      }
      return realFindOne(query, projection);
    };
    const res = await provider.updateById(1, { title: '新标题' } as any);
    expect(res).toBeTruthy();
    expect(calls).toBeGreaterThan(0);
    // 保存照常发生，密码保持明文（下次启动 wash 兜底）
    expect(lastPatch(model).title).toBe('新标题');
    expect(model.docs[0].password).toBe('legacy-plain');
  });
});

describe('文章访问密码：管理端列表出口脱敏（P3）', () => {
  const seedPrivateArticle = () =>
    createMemoryArticleModel([
      {
        id: 7,
        title: '加密文',
        content: 'SECRET-BODY',
        category: 'c',
        tags: [],
        hidden: false,
        deleted: false,
        private: true,
        password: 'scrypt$16384$8$1$aa==$bb==',
        publishAt: null,
        wordCount: 11,
      },
    ]);

  it('admin 视图（投影带 password）⇒ 出口没有 password，只有 hasPassword: true', async () => {
    const model = seedPrivateArticle();
    const provider = createProvider(model);
    const data: any = await provider.getByOption({ page: 1, pageSize: 10 } as any, false);
    expect(data.articles).toHaveLength(1);
    const json = JSON.stringify(data.articles);
    expect(json).not.toContain('scrypt$');
    expect(json).not.toContain('"password"');
    expect(data.articles[0].hasPassword).toBe(true);
  });

  it('admin + withExcerpt（会被展开成普通对象，绕过 schema transform）同样脱敏', async () => {
    const model = seedPrivateArticle();
    const provider = createProvider(model);
    const data: any = await provider.getByOption(
      { page: 1, pageSize: 10, withExcerpt: true } as any,
      false,
    );
    const json = JSON.stringify(data.articles);
    expect(json).not.toContain('scrypt$');
    expect(json).not.toContain('"password"');
    expect(data.articles[0].hasPassword).toBe(true);
  });

  it('admin + toListView ⇒ 列表行也带 hasPassword（后台弹窗直接拿行当初始值），但没有密文', async () => {
    const model = seedPrivateArticle();
    const provider = createProvider(model);
    const data: any = await provider.getByOption(
      { page: 1, pageSize: 10, toListView: true } as any,
      false,
    );
    const json = JSON.stringify(data.articles);
    expect(json).not.toContain('"password"');
    expect(json).not.toContain('scrypt$');
    // 管理端列表投影是 adminListView（= listView + password），出口把值换成布尔：
    // 「文章列表 → 修改信息」弹窗拿的就是这一行，得知道"设没设过"才能写对提示文案。
    expect(data.articles[0].hasPassword).toBe(true);
    // 列表投影仍然不带正文
    expect(json).not.toContain('SECRET-BODY');
  });

  it('public + toListView ⇒ 形状与今天一致：既没有 password，也不会多出 hasPassword', async () => {
    const model = createMemoryArticleModel([
      {
        id: 9,
        title: '公开文',
        content: 'BODY',
        category: 'c',
        tags: [],
        hidden: false,
        deleted: false,
        private: true,
        password: 'scrypt$16384$8$1$aa==$bb==',
        publishAt: null,
        wordCount: 4,
      },
    ]);
    const provider = createProvider(model);
    // pageSize: -1（UNLIMITED）走 find 路径：公开分页那条走 aggregate，
    // 本文件的假 model 不实现聚合管道，测不到投影
    const data: any = await provider.getByOption(
      { page: 1, pageSize: -1, toListView: true } as any,
      true,
    );
    const json = JSON.stringify(data.articles);
    expect(json).not.toContain('"password"');
    expect(json).not.toContain('scrypt$');
    // 公开面用 listView（没 select password）⇒ 无从判断，所以**不下结论**（缺键，而不是
    // 一个骗人的 false）。前台 __NEXT_DATA__ 里多一个键都是白送体积。
    expect('hasPassword' in data.articles[0]).toBe(false);
  });

  it('没设密码的文章 ⇒ hasPassword: false（UI 靠它决定 placeholder 文案）', async () => {
    const model = createMemoryArticleModel([
      { id: 8, title: '公开文', content: 'body', category: 'c', tags: [], hidden: false, deleted: false, private: false, password: '', publishAt: null, wordCount: 4 },
    ]);
    const provider = createProvider(model);
    const data: any = await provider.getByOption({ page: 1, pageSize: 10 } as any, false);
    expect(data.articles[0].hasPassword).toBe(false);
  });
});

describe('文章访问密码：启动 wash（P2）', () => {
  const seedMixed = () =>
    createMemoryArticleModel([
      { _id: 'a1', id: 1, title: '明文', password: 'plain-1' },
      { _id: 'a2', id: 2, title: '明文空格式', password: 'plain-2' },
      { _id: 'a3', id: 3, title: '已是哈希', password: 'scrypt$16384$8$1$aa==$bb==' },
      { _id: 'a4', id: 4, title: '没密码', password: '' },
      { _id: 'a5', id: 5, title: '没这个键' },
    ]);

  it('只洗"非空且不是 scrypt"的，计数有界，原密码仍能校验', async () => {
    const model = seedMixed();
    const provider = createProvider(model);
    const result = await provider.washAccessPasswords();

    expect(result.articles).toBe(2);
    expect(result.washed).toBe(2);
    expect(result.alreadyHashed).toBe(1);
    expect(isScryptHash(model.docs[0].password)).toBe(true);
    expect(verifyAccessPassword(model.docs[0].password, 'plain-1')).toBe(true);
    expect(verifyAccessPassword(model.docs[1].password, 'plain-2')).toBe(true);
    // 不该动的一个字都没动
    expect(model.docs[2].password).toBe('scrypt$16384$8$1$aa==$bb==');
    expect(model.docs[3].password).toBe('');
    expect('password' in model.docs[4]).toBe(false);
  });

  it('幂等：第二次跑 washed = 0，库里的哈希没有被二次哈希', async () => {
    const model = seedMixed();
    const provider = createProvider(model);
    await provider.washAccessPasswords();
    const afterFirst = model.docs.map((d: any) => d.password);
    const second = await provider.washAccessPasswords();
    expect(second.washed).toBe(0);
    expect(second.articles).toBe(0);
    expect(second.alreadyHashed).toBe(3);
    expect(model.docs.map((d: any) => d.password)).toEqual(afterFirst);
  });

  it('可中断：洗到一半抛错，已洗的仍然能解锁，没洗的保持明文（也仍然能解锁）', async () => {
    const model = seedMixed();
    const provider = createProvider(model);
    const realUpdateOne = model.updateOne;
    let n = 0;
    model.updateOne = (query: any, patch: any) => {
      n += 1;
      if (n === 2) {
        return { exec: async () => { throw new Error('进程被 kill 之前的最后一次写'); } };
      }
      return realUpdateOne(query, patch);
    };
    await expect(provider.washAccessPasswords()).rejects.toThrow();
    // 第一条已经是哈希并且能用原密码解开
    expect(isScryptHash(model.docs[0].password)).toBe(true);
    expect(verifyAccessPassword(model.docs[0].password, 'plain-1')).toBe(true);
    // 第二条还是明文 —— verifyAccessPassword 两种都认，所以照样能解锁
    expect(model.docs[1].password).toBe('plain-2');
    expect(verifyAccessPassword(model.docs[1].password, 'plain-2')).toBe(true);
  });
});

describe('文章访问密码：解锁口对两种存储格式都认（向后兼容）', () => {
  const baseArticle = (password: string) => ({
    id: 42,
    title: '加密文',
    content: 'BODY',
    category: 'c',
    hidden: false,
    deleted: false,
    private: true,
    password,
    publishAt: null,
  });

  function providerFor(article: any) {
    const model = createMemoryArticleModel([article]);
    const provider = new ArticleProvider(
      model,
      { findOne: () => ({ exec: async () => null }) } as any,
      { updateTotalWords: () => undefined, getSiteInfo: async () => ({}) } as any,
      {} as any,
    );
    return provider;
  }

  it('历史明文：正确密码解锁，错误密码拒绝', async () => {
    const provider = providerFor(baseArticle('legacy-plain'));
    const ok: any = await provider.getByIdWithPassword(42, 'legacy-plain');
    expect(ok?.content).toBe('BODY');
    expect(ok?.password).toBeUndefined();
    expect(await provider.getByIdWithPassword(42, 'nope')).toBeNull();
  });

  it('scrypt 哈希：正确密码解锁，错误密码拒绝（迁移前后行为一致）', async () => {
    const provider = providerFor(baseArticle('scrypt$16384$8$1$aa==$bb=='));
    // 哈希是假的，所以任何密码都解不开 —— 这里要证明的是"不会因为格式不认识而 500"
    expect(await provider.getByIdWithPassword(42, 'whatever')).toBeNull();

    const real = createMemoryArticleModel([
      baseArticle(
        // 真哈希：用 create 走一遍写入路径拿到
        await (async () => {
          const m = createMemoryArticleModel();
          const p = createProvider(m);
          const c: any = await p.create({
            title: 'x',
            category: 'c',
            private: true,
            password: 'real-pw',
          } as any);
          return c.password;
        })(),
      ),
    ]);
    const provider2 = new ArticleProvider(
      real,
      { findOne: () => ({ exec: async () => null }) } as any,
      { updateTotalWords: () => undefined, getSiteInfo: async () => ({}) } as any,
      {} as any,
    );
    const ok: any = await provider2.getByIdWithPassword(42, 'real-pw');
    expect(ok?.content).toBe('BODY');
    expect(ok?.password).toBeUndefined();
    expect(await provider2.getByIdWithPassword(42, 'wrong-pw')).toBeNull();
  });
});

describe('两条额外的钉子（parent 点名要的）', () => {
  it('updateById 收到**完全没有 password 键**的 DTO ⇒ updateOne 的 patch 里绝不出现 password，存量哈希一个字节都不动', async () => {
    const storedHash = 'scrypt$16384$8$1$aa==$bb==';
    const model = createMemoryArticleModel([
      { id: 1, title: 't', content: 'c', category: 'c', password: storedHash, deleted: false },
    ]);
    const provider = createProvider(model);

    await provider.updateById(1, { title: '只改标题' } as any);

    // 逐条检查所有 updateOne 调用：任何一条都不许带 password
    const updateCalls = model.captured.filter((c: any) => c.method === 'updateOne');
    expect(updateCalls.length).toBeGreaterThan(0);
    for (const call of updateCalls) {
      expect(Object.prototype.hasOwnProperty.call(call.args.patch, 'password')).toBe(false);
    }
    // 库里那个哈希没有被覆盖/清空/二次哈希
    expect(model.docs[0].password).toBe(storedHash);
  });

  it('空语料：一条待洗文档都没有时 wash 是免费的（scanned=0 / washed=0，耗时可忽略）', async () => {
    const model = createMemoryArticleModel([
      { _id: 'x1', id: 1, title: '没密码', password: '' },
      { _id: 'x2', id: 2, title: '没这个键' },
      { _id: 'x3', id: 3, title: '已是哈希', password: 'scrypt$16384$8$1$aa==$bb==' },
    ]);
    const provider = createProvider(model);
    const started = Date.now();
    const result = await provider.washAccessPasswords();
    const elapsed = Date.now() - started;

    // scanned 只统计"非空密码"的候选，所以空密码/无键的那两条压根不进候选集
    expect(result.scanned).toBe(1);
    expect(result.washed).toBe(0);
    expect(result.articles).toBe(0);
    expect(result.categories).toBe(0);
    expect(result.alreadyHashed).toBe(1);
    // 一次 scrypt 都不跑 ⇒ 必须是毫秒级（这条钉子的意义：空语料的站点启动不为 wash 付钱）
    expect(elapsed).toBeLessThan(200);
    expect(model.docs.map((d: any) => d.password)).toEqual([
      '',
      undefined,
      'scrypt$16384$8$1$aa==$bb==',
    ]);
  });

  it('真·空库：一个文档都没有时 wash 直接返回全 0', async () => {
    const model = createMemoryArticleModel([]);
    const provider = createProvider(model);
    const result = await provider.washAccessPasswords();
    expect(result).toMatchObject({ scanned: 0, washed: 0, alreadyHashed: 0, articles: 0, categories: 0 });
  });
});
