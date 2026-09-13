import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CommentProvider } from './comment.provider';
import { CommentSetting } from 'src/types/setting.dto';

jest.mock('src/config/index', () => ({ config: { demo: 'false' } }), { virtual: true });

const SETTING: CommentSetting = {
  provider: 'builtin',
  moderation: 'post',
  keywords: ['广告', '加微信'],
  requireEmail: false,
  pendingOnLink: true,
  maxContentLength: 200,
  rateLimitPer10Min: 100,
};

function makeFakeModels(setting: CommentSetting = SETTING) {
  const comments: any[] = [];
  let nextId = 1;

  const commentModel: any = {
    // mongoose 的 query 是 thenable，所以这里直接返回 Promise 就能被 await；
    // 只实现测试用得到的那部分过滤（status / rootId）
    find: (filter?: any) => {
      const apply = () =>
        comments.filter(
          (c) =>
            (!filter?.status || c.status === filter.status) &&
            (filter?.rootId === undefined || (c.rootId || 0) === filter.rootId),
        );
      // 真实的 mongoose query 既能 await 又能 .exec()，这里两种都支持
      const query = (rows: any[]) => {
        const promise = Promise.resolve(rows);
        return Object.assign(promise, { exec: () => promise });
      };
      const rows = apply();
      return {
        // 有的查询是 .sort().exec()（取回复），有的是 .sort().skip().limit().exec()（分页）
        sort: () => {
          const sorted = query(rows);
          return Object.assign(sorted, {
            limit: () => query(rows),
            skip: () => ({ limit: () => query(rows) }),
          });
        },
      };
    },
    findOne: (q: any) => ({ exec: async () => comments.find((c) => c.id === q?.id) || null }),
    create: async (doc: any) => {
      comments.push(doc);
      return doc;
    },
    countDocuments: async () => comments.length,
    aggregate: () => ({ exec: async () => [] }),
    updateOne: async () => ({ modifiedCount: 1 }),
    updateMany: async () => ({ modifiedCount: 1 }),
  };

  const articleModel: any = {
    findOne: () => ({
      exec: async () => ({ id: 42, deleted: false, hidden: false, pathname: 'hello' }),
    }),
  };

  const metaModel: any = {
    findOne: () => ({ exec: async () => ({ siteInfo: { authorEmail: 'me@example.com' } }) }),
  };

  const settingProvider: any = { getCommentSetting: async () => setting };

  const provider = new CommentProvider(commentModel, articleModel, metaModel, settingProvider);
  return { provider, comments, nextId };
}

const req = (ip = '203.0.113.7') =>
  ({ socket: { remoteAddress: ip }, headers: { 'user-agent': 'jest' } } as any);

async function expectReject(promise: Promise<any>, matcher: RegExp) {
  await expect(promise).rejects.toMatchObject({
    message: expect.stringMatching(matcher),
  });
}

describe('CommentProvider：输入校验与反注入', () => {
  it('path 必须是本站路径，拒绝对象注入、.. 与空值', async () => {
    const { provider } = makeFakeModels();
    await expectReject(
      provider.create({ path: { $ne: null } as any, nick: 'x', content: 'y' }, req()),
      /不合法/,
    );
    await expectReject(
      provider.create({ path: '/../../../etc/passwd', nick: 'x', content: 'y' }, req()),
      /不合法/,
    );
    await expectReject(provider.create({ path: '', nick: 'x', content: 'y' }, req()), /不合法/);
    await expectReject(
      provider.create({ path: 'http://evil.example/post/1', nick: 'x', content: 'y' }, req()),
      /不合法/,
    );
  });

  it('文章不存在时拒绝（防止往编造路径灌库）', async () => {
    const { provider } = makeFakeModels();
    (provider as any).articleModel = { findOne: () => ({ exec: async () => null }) };
    await expectReject(
      provider.create({ path: '/post/nope', nick: 'x', content: 'y' }, req()),
      /文章不存在/,
    );
  });

  it('隐藏文章不开放评论', async () => {
    const { provider } = makeFakeModels();
    (provider as any).articleModel = {
      findOne: () => ({ exec: async () => ({ id: 7, deleted: false, hidden: true }) }),
    };
    await expect(
      provider.create({ path: '/post/7', nick: 'x', content: 'y' }, req()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('昵称里的尖括号与控制字符被剥掉', async () => {
    const { provider, comments } = makeFakeModels();
    await provider.create(
      { path: '/post/1', nick: '<script>alert(1)</script>\u0000', content: '正常内容' },
      req(),
    );
    expect(comments[0].nick).not.toContain('<');
    expect(comments[0].nick).not.toContain('>');
    expect(comments[0].nick).not.toContain('\u0000');
  });

  it('主页地址只允许 http/https，javascript: 与 data: 一律拒绝', async () => {
    const { provider } = makeFakeModels();
    await expectReject(
      provider.create(
        { path: '/post/1', nick: 'x', site: 'javascript:alert(1)', content: 'y' },
        req(),
      ),
      /只支持 http\/https/,
    );
    await expectReject(
      provider.create(
        { path: '/post/1', nick: 'x', site: 'data:text/html,<script>1</script>', content: 'y' },
        req(),
      ),
      /只支持 http\/https/,
    );
    const ok = makeFakeModels();
    await ok.provider.create(
      { path: '/post/1', nick: 'x', site: 'example.com/me', content: 'y' },
      req('203.0.113.200'),
    );
    expect(ok.comments[0].site).toMatch(/^https:\/\/example\.com\/me/);
    // 大小写混写的 scheme 也要挡住
    await expectReject(
      ok.provider.create(
        { path: '/post/1', nick: 'x', site: 'JaVaScRiPt:alert(1)', content: 'y' },
        req('203.0.113.201'),
      ),
      /只支持 http\/https/,
    );
  });

  it('邮箱传对象会被拒绝，格式非法也会被拒绝', async () => {
    const { provider } = makeFakeModels();
    await expectReject(
      provider.create({ path: '/post/1', nick: 'x', email: { $gt: '' } as any, content: 'y' }, req()),
      /邮箱格式不正确/,
    );
    await expectReject(
      provider.create({ path: '/post/1', nick: 'x', email: 'not-an-email', content: 'y' }, req()),
      /邮箱格式不正确/,
    );
  });

  it('requireEmail 打开时邮箱必填', async () => {
    const { provider } = makeFakeModels({ ...SETTING, requireEmail: true });
    await expectReject(
      provider.create({ path: '/post/1', nick: 'x', content: 'y' }, req()),
      /要求填写邮箱/,
    );
  });

  it('内容为空、超长、带控制字符都会被拒绝；双向控制符被删掉', async () => {
    const { provider, comments } = makeFakeModels();
    await expectReject(
      provider.create({ path: '/post/1', nick: 'x', content: '   ' }, req()),
      /不能为空/,
    );
    await expectReject(
      provider.create({ path: '/post/1', nick: 'x', content: 'a'.repeat(201) }, req()),
      /不能超过/,
    );
    await expectReject(
      provider.create({ path: '/post/1', nick: 'x', content: 'bad\u0007bell' }, req()),
      /非法字符/,
    );
    await provider.create(
      { path: '/post/1', nick: 'x', content: 'a\u202e反向了b' },
      req('203.0.113.99'),
    );
    const saved = comments[comments.length - 1].content;
    expect(saved).not.toContain('\u202e');
    expect(saved).toBe('a反向了b');
  });

  it('回复不存在的评论、跨文章回复都被拒绝', async () => {
    const { provider } = makeFakeModels();
    await expectReject(
      provider.create({ path: '/post/1', nick: 'x', content: 'y', parentId: 999 }, req()),
      /不存在/,
    );
  });
});

describe('CommentProvider：审核策略与反垃圾', () => {
  it('蜜罐被填 → 存成 spam 但对外只说「待审」', async () => {
    const { provider, comments } = makeFakeModels();
    const res = await provider.create(
      { path: '/post/1', nick: 'bot', content: '买量', hp: 'http://spam.example' },
      req('198.51.100.1'),
    );
    expect(res.pending).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(comments[0].status).toBe('spam');
  });

  it('命中关键词 / 含外链 → pending；普通内容 → approved', async () => {
    const { provider, comments } = makeFakeModels();
    await provider.create({ path: '/post/1', nick: 'a', content: '加微信详聊' }, req('198.51.100.2'));
    await provider.create(
      { path: '/post/1', nick: 'b', content: '看 https://spam.example' },
      req('198.51.100.3'),
    );
    await provider.create({ path: '/post/1', nick: 'c', content: '写得真好' }, req('198.51.100.4'));
    expect(comments.map((c) => c.status)).toEqual(['pending', 'pending', 'approved']);
    expect(comments[0].reason).toContain('关键词');
    expect(comments[1].reason).toContain('外链');
  });

  it('moderation=pre 一律待审，none 一律通过', async () => {
    const pre = makeFakeModels({ ...SETTING, moderation: 'pre' });
    await pre.provider.create({ path: '/post/1', nick: 'a', content: '普通内容' }, req('198.51.100.5'));
    expect(pre.comments[0].status).toBe('pending');

    const none = makeFakeModels({ ...SETTING, moderation: 'none' });
    await none.provider.create(
      { path: '/post/1', nick: 'a', content: '带 https://x.example 也放行' },
      req('198.51.100.6'),
    );
    expect(none.comments[0].status).toBe('approved');
  });

  it('博主邮箱直通（不经过关键词与外链规则）', async () => {
    const { provider, comments } = makeFakeModels();
    await provider.create(
      { path: '/post/1', nick: '博主', email: 'ME@example.com', content: '广告 https://x.example' },
      req('198.51.100.7'),
    );
    expect(comments[0].status).toBe('approved');
    expect(comments[0].isAuthor).toBe(true);
  });

  it('同 IP 超过每 10 分钟上限被限流', async () => {
    const { provider } = makeFakeModels({ ...SETTING, rateLimitPer10Min: 2 });
    const ip = '198.51.100.77';
    await provider.create({ path: '/post/1', nick: 'a', content: '第一条内容' }, req(ip));
    await provider.create({ path: '/post/1', nick: 'a', content: '第二条内容' }, req(ip));
    await expectReject(
      provider.create({ path: '/post/1', nick: 'a', content: '第三条内容' }, req(ip)),
      /评论太频繁/,
    );
  });

  it('同 IP 5 分钟内重复内容被拒', async () => {
    const { provider } = makeFakeModels();
    const ip = '198.51.100.88';
    await provider.create({ path: '/post/1', nick: 'a', content: '一样的内容' }, req(ip));
    await expectReject(
      provider.create({ path: '/post/1', nick: 'a', content: '一样的内容' }, req(ip)),
      /一样的评论/,
    );
  });

  it('评论系统不是内置时，公开接口拒绝写入', async () => {
    const { provider } = makeFakeModels({ ...SETTING, provider: 'waline' });
    await expect(
      provider.create({ path: '/post/1', nick: 'a', content: 'y' }, req()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('没有设置行时回落到 waline（老站点升级不会被切走）', async () => {
    const provider = new CommentProvider({} as any, {} as any, {} as any, {
      getCommentSetting: async () => ({ ...SETTING, provider: 'waline' }),
    } as any);
    await expect(
      provider.create({ path: '/post/1', nick: 'a', content: 'y' }, req()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('CommentProvider：对外字段与查询', () => {
  it('公开对象里没有 email / ip / ua / reason', () => {
    const { provider } = makeFakeModels();
    const pub = provider.toPublic({
      id: 1,
      path: '/post/1',
      nick: '张三',
      email: 'a@b.com',
      ip: '10.0.0.1',
      ua: 'curl',
      reason: '命中关键词',
      content: 'hi',
      status: 'approved',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const json = JSON.stringify(pub);
    expect(json).not.toContain('a@b.com');
    expect(json).not.toContain('10.0.0.1');
    expect(json).not.toContain('curl');
    expect(json).not.toContain('命中关键词');
    expect(pub).toMatchObject({ id: 1, nick: '张三', content: 'hi' });
  });

  it('批量计数最多 50 个路径，且忽略非法路径', async () => {
    const { provider } = makeFakeModels();
    const paths = Array.from({ length: 80 }, (_, i) => `/post/${i}`);
    const res = await provider.countByPaths([...paths, 'not-a-path', '', 'ftp://x']);
    expect(Object.keys(res).length).toBeLessThanOrEqual(50);
    expect(res['not-a-path']).toBeUndefined();
  });

  it('公开列表只返回 approved，并且分页参数被夹在合理范围', async () => {
    const { provider, comments } = makeFakeModels();
    comments.push(
      { id: 1, path: '/post/1', rootId: 0, status: 'approved', nick: 'a', content: 'x', createdAt: new Date() },
      { id: 2, path: '/post/1', rootId: 0, status: 'pending', nick: 'b', content: 'y', createdAt: new Date() },
    );
    const res = await provider.listByPath({ path: '/post/1', page: 1, pageSize: 9999 });
    expect(res.pageSize).toBe(50);
    expect(res.data.every((c) => c.status === 'approved')).toBe(true);
  });

  it('id 生成用 try/finally 释放锁（一次失败不会永久卡死）', async () => {
    const { provider } = makeFakeModels();
    (provider as any).commentModel = {
      find: () => ({
        sort: () => ({ limit: () => Promise.reject(new Error('db down')) }),
      }),
    };
    await expect(provider.getNewId()).rejects.toThrow('db down');
    expect((provider as any).idLock).toBe(false);
  });
});
