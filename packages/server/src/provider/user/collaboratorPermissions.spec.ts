/**
 * 协作者权限的**存储链路**：字段名、枚举收口、以及与管理员重名的防线。
 *
 * ## 这里原来有一条贯穿四层的字段名错误（不只是"不优雅"，是功能从来没生效）
 *
 *  - 后台表单字段名是 `permissions`（复数，`CollaboratorModal` 的 `name="permissions"`）；
 *  - `types/collaborator.ts` 声明的是 `permission`（单数）；
 *  - `user.provider.ts` 读的是 `collaboratorDto?.permission`（单数）⇒ 永远 `undefined` ⇒ 存 `[]`；
 *  - 而且写库时写的也是 `permission:`，而 `scheme/user.schema.ts` 声明的是 `permissions?: Permission[]`
 *    ⇒ 不在 schema 里的路径被 mongoose 的 strict 模式**静默丢弃**；
 *  - `jwt.strategy.ts` 读的是 `user.permissions`（复数）⇒ 永远 `undefined`；
 *  - `AccessGuard` 于是走 `if (!permissions || permissions.length == 0) return false;`。
 *
 * 净效果：**协作者权限此前根本没有生效过** —— 无论后台勾了什么，协作者只能用 publicRoutes 里那些
 * 只读接口，`'all'` 也一样。这一条同时意味着"协作者 `'all'` = 超管"在过去是**不可达**的
 * （permissions 永远是空），所以 access.guard 的那条修复属于纵深防御 + 为这次修好之后的世界把关；
 * 两者必须**同一批**落地：只修字段名不修 guard，等于第一次把 `'all'` = 超管变成可达。
 *
 * ⚠️ 不需要数据迁移：旧实现写的 `permission` 被 strict 模式丢弃了，库里从来没有这个字段，
 * 也就没有需要清洗的历史数据（`permissions` 一直是 undefined）。
 */
import { UserProvider } from './user.provider';
import { ALL_PERMISSION_VALUES } from 'src/types/access/access';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
const code = stripCommentsForAnchor;

/** 最小可用的 mongoose Query 替身：支持 find/findOne 的 sort/limit/exec 与直接 await 两种用法。 */
class FakeQuery {
  constructor(
    private rows: any[],
    private sink: { calls: Array<{ op: string; filter: any; update?: any }> },
    op: string,
    filter: any,
    private update?: any,
    private single = false,
  ) {
    sink.calls.push({ op, filter, update });
  }
  sort(spec: any) {
    const key = Object.keys(spec || {})[0];
    const dir = key ? spec[key] : 1;
    if (key) {
      this.rows = [...this.rows].sort((a, b) => (a[key] > b[key] ? dir : a[key] < b[key] ? -dir : 0));
    }
    return this;
  }
  limit(n: number) {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  exec() {
    // ⚠️ findOne 必须解析成**单个文档或 null**，不能是数组：
    //    `if (oldData)` 对空数组 `[]` 是 truthy，第一版替身就是这么让
    //    "与既有协作者重名"的分支在没有重名时也触发（把 7 条用例全带红了）。
    //    替身与真实驱动的形状不一致，测出来的就只是替身自己的行为。
    return Promise.resolve(this.single ? this.rows[0] ?? null : this.rows);
  }
  then<R>(onFulfilled: (v: any) => R | PromiseLike<R>, onRejected?: any): PromiseLike<R> {
    return this.exec().then(onFulfilled, onRejected);
  }
}

function buildProvider(docs: any[]) {
  const sink = { calls: [] as Array<{ op: string; filter: any; update?: any }>, created: [] as any[] };
  const store = docs;
  const matches = (filter: any) =>
    store.filter((d) =>
      Object.keys(filter || {}).every((k) => {
        const v = (filter as any)[k];
        // 模拟 mongoose 丢弃 undefined 条件（正是 updateCollaborator 那个坑的成因）
        if (v === undefined) return true;
        return d[k] === v;
      }),
    );
  const userModel: any = {
    find: (filter: any) => new FakeQuery(matches(filter), sink, 'find', filter),
    findOne: (filter: any) => new FakeQuery(matches(filter), sink, 'findOne', filter, undefined, true),
    create: (doc: any) => {
      sink.created.push(doc);
      store.push(doc);
      return Promise.resolve(doc);
    },
    updateOne: (filter: any, update: any) => {
      const hit = matches(filter)[0];
      if (hit) Object.assign(hit, update);
      return new FakeQuery(hit ? [{ acknowledged: true }] : [], sink, 'updateOne', filter, update);
    },
    deleteOne: (filter: any) => new FakeQuery([], sink, 'deleteOne', filter),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), verbose: jest.fn() };
  // ⚠️ 不 new UserProvider()：它的构造器是 @InjectModel，单元测试里拉不起来。
  const p: any = Object.create(UserProvider.prototype);
  p.userModel = userModel;
  p.logger = logger;
  return { p, sink, store, logger, userModel };
}

const ADMIN = { id: 0, name: 'boss', type: 'admin', password: 'x', salt: 's' };

describe('协作者权限写进库的字段名必须是 schema 里的 permissions（复数）', () => {
  it('create：UI 发的复数 permissions 能被读到，并以复数字段落库', async () => {
    const { p, sink } = buildProvider([{ ...ADMIN }]);
    await p.createCollaborator({
      name: 'writer',
      nickname: 'W',
      password: 'pw123456',
      permissions: ['article:create', 'draft:update'],
    } as any);
    const created = sink.created[0];
    expect(created).toBeTruthy();
    expect(created.permissions).toEqual(['article:create', 'draft:update']);
    // ⚠️ 反证：单数字段不许再出现在写库文档里（写单数会被 strict 模式丢弃 ⇒ 权限静默丢失）
    expect(Object.keys(created)).not.toContain('permission');
  });

  it('create：DTO 用单数 permission 也认（types/collaborator.ts 声明的是单数）', async () => {
    const { p, sink } = buildProvider([{ ...ADMIN }]);
    await p.createCollaborator({
      name: 'writer2',
      nickname: 'W',
      password: 'pw123456',
      permission: ['img:delete'],
    } as any);
    expect(sink.created[0].permissions).toEqual(['img:delete']);
  });

  it('update：同样以复数字段落库', async () => {
    const { p, store } = buildProvider([
      { ...ADMIN },
      { id: 1, name: 'writer', type: 'collaborator', password: 'x', salt: 's', permissions: [] },
    ]);
    await p.updateCollaborator({
      name: 'writer',
      nickname: 'W2',
      password: 'pw123456',
      permissions: ['all'],
    } as any);
    expect(store[1].permissions).toEqual(['all']);
    expect(Object.keys(store[1])).not.toContain('permission');
  });

  it('源码级钉子：写库文档里是 permissions:，不是 permission:', () => {
    const src = code(read('./user.provider.ts'));
    expect(src).toMatch(/^\s*permissions,$/m);
    expect(src).not.toMatch(/^\s*permission: pickPermissions/m);
  });
});

describe('pickPermissions 按枚举收口（未知值丢弃 + WARN，不 400）', () => {
  it('未知字符串被丢弃并 WARN，合法值保留', async () => {
    const { p, sink, logger } = buildProvider([{ ...ADMIN }]);
    await p.createCollaborator({
      name: 'mixed',
      nickname: 'M',
      password: 'pw123456',
      permissions: ['article:create', 'backup:download', 'pipeline:run', 42, 'all'],
    } as any);
    expect(sink.created[0].permissions).toEqual(['article:create', 'all']);
    expect(logger.warn).toHaveBeenCalled();
    const msg = String(logger.warn.mock.calls[0][0]);
    expect(msg).toContain('backup:download');
    expect(msg).toContain('pipeline:run');
    expect(msg).toContain('ALL_PERMISSION_VALUES');
  });

  it('重复值去重；全是未知值时得到空数组（不是把未知值原样存进去）', async () => {
    const { p, sink } = buildProvider([{ ...ADMIN }]);
    await p.createCollaborator({
      name: 'dup',
      nickname: 'D',
      password: 'pw123456',
      permissions: ['all', 'all', 'nope'],
    } as any);
    expect(sink.created[0].permissions).toEqual(['all']);
  });

  it('permission 不是数组时得到空数组（既有行为不回退）', async () => {
    const { p, sink } = buildProvider([{ ...ADMIN }]);
    await p.createCollaborator({ name: 'none', nickname: 'N', password: 'pw123456' } as any);
    expect(sink.created[0].permissions).toEqual([]);
  });

  it('枚举集合本身来自 pathPermissionMap，不是手写的第二份真相', () => {
    expect(ALL_PERMISSION_VALUES).toContain('article:create');
    expect(ALL_PERMISSION_VALUES).toContain('file:delete');
    expect(ALL_PERMISSION_VALUES).toContain('all');
    expect(ALL_PERMISSION_VALUES).not.toContain('backup:download');
  });
});

describe('与管理员重名：创建与改名两侧都堵住', () => {
  it('create：与管理员同名 ⇒ 拒绝，且没有写库', async () => {
    const { p, sink } = buildProvider([{ ...ADMIN }]);
    await expect(
      p.createCollaborator({ name: 'boss', nickname: 'B', password: 'pw123456', permissions: ['all'] } as any),
    ).rejects.toThrow(/与管理员账号相同/);
    expect(sink.created).toHaveLength(0);
  });

  it('create：与既有协作者同名 ⇒ 仍然按原样拒绝', async () => {
    const { p, sink } = buildProvider([
      { ...ADMIN },
      { id: 1, name: 'writer', type: 'collaborator', password: 'x', salt: 's' },
    ]);
    await expect(
      p.createCollaborator({ name: 'writer', nickname: 'W', password: 'pw123456' } as any),
    ).rejects.toThrow(/不可重复创建/);
    expect(sink.created).toHaveLength(0);
  });

  it('updateUser：把管理员改成某个协作者的名字 ⇒ 拒绝（恢复接口也会走这条路）', async () => {
    const { p, store } = buildProvider([
      { ...ADMIN },
      { id: 1, name: 'writer', type: 'collaborator', password: 'x', salt: 's' },
    ]);
    await expect(p.updateUser({ name: 'writer', password: 'newpw123' } as any)).rejects.toThrow(
      /已被一个协作者占用/,
    );
    expect(store[0].name).toBe('boss');
  });

  it('updateUser：不重名时照常改名改密码', async () => {
    const { p, store } = buildProvider([{ ...ADMIN }]);
    await p.updateUser({ name: 'newboss', password: 'newpw123' } as any);
    expect(store[0].name).toBe('newboss');
    expect(store[0].password).not.toBe('x');
  });
});

describe('validateUser：同名时确定性命中，并大声报出数据问题', () => {
  it('管理员与协作者同名时固定命中 id 最小的那条（管理员 id:0 优先）', async () => {
    const { p, logger } = buildProvider([
      { id: 5, name: 'twin', type: 'collaborator', password: 'c', salt: 's' },
      { ...ADMIN, id: 0, name: 'twin' },
    ]);
    // 密码错 ⇒ 返回 null，但我们要看的是"查了哪条"，所以断言 WARN 与查询形状
    await p.validateUser('twin', 'wrong-password');
    expect(logger.error).toHaveBeenCalled();
    expect(String(logger.error.mock.calls[0][0])).toContain('twin');
    expect(String(logger.error.mock.calls[0][0])).toContain('0, 5');
  });

  it('源码级钉子：登录查询带排序（没有排序时"返回哪条"取决于自然顺序）', () => {
    const src = code(read('./user.provider.ts'));
    expect(src).toMatch(/find\(\{ name \}\)\.sort\(\{ id: 1 \}\)\.limit\(2\)/);
    expect(src).not.toMatch(/const user = await this\.userModel\.findOne\(\{ name \}\);/);
  });

  it('⚠️ 反证的反证：上面那条"不存在"的正则跑在旧形状上必须命中', () => {
    expect('const user = await this.userModel.findOne({ name });').toMatch(
      /const user = await this\.userModel\.findOne\(\{ name \}\);/,
    );
  });

  it('入参类型/空值防线保持不变（NoSQL 操作符注入靠它挡）', async () => {
    const { p } = buildProvider([{ ...ADMIN }]);
    await expect(p.validateUser({ $ne: null } as any, 'x')).resolves.toBeNull();
    await expect(p.validateUser('boss', { $gt: '' } as any)).resolves.toBeNull();
    await expect(p.validateUser('', 'x')).resolves.toBeNull();
  });
});

describe('updateCollaborator：不带用户名不许"随便挑一个协作者改"', () => {
  it('name 缺失 ⇒ 400，且没有发生任何写操作', async () => {
    const { p, sink, store } = buildProvider([
      { ...ADMIN },
      { id: 1, name: 'writer', type: 'collaborator', password: 'x', salt: 's' },
    ]);
    await expect(p.updateCollaborator({ password: 'pw123456' } as any)).rejects.toThrow(/用户名不合法/);
    expect(store[1].password).toBe('x');
    expect(sink.calls.filter((c) => c.op === 'updateOne')).toHaveLength(0);
  });

  it('源码级钉子：不再直接解构 name 去查（undefined 条件会被 mongoose 丢掉）', () => {
    const src = code(read('./user.provider.ts'));
    expect(src).not.toMatch(/const \{ name \} = collaboratorDto;/);
    expect(src).toMatch(/const name = assertCollaboratorName\(collaboratorDto\?\.name\);/);
  });
});
