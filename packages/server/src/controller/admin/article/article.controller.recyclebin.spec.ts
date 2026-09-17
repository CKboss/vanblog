import * as fs from 'fs';
import * as path from 'path';
import { NotFoundException } from '@nestjs/common';
import { ArticleController } from './article.controller';
import { DraftController } from '../draft/draft.controller';
import {
  pathPermissionMap,
  permissionRoutes,
  publicRoutes,
} from 'src/types/access/access';

/**
 * P3/P4 的**契约层**钉子：
 *  - 路由声明顺序：`@Get('deleted')` 必须在 `@Get('/:id')` 之前（否则 'deleted' 被当成 :id）；
 *  - restore/purge 的副作用与错误语义（404、ISR、流水线事件）；
 *  - revisions 三件套的响应契约（enabled 标志、恢复前先记 pre-restore 快照、skipRevision）；
 *  - 协作者权限映射：purge 与既有 delete 同档（article:delete）、restore 与 update 同档。
 */

function readSrc(rel: string): string {
  // __dirname = packages/server/src/controller/admin/article → 上 4 级到 packages/server
  return fs.readFileSync(path.resolve(__dirname, '../../../..', rel), 'utf8');
}

/**
 * 找**真正的装饰器行**的行号：整行 trim 后全等才算（文档注释里提到的
 * `` `@Get('/:id')` `` 不会命中，因为它不是独立成行的全等文本）。
 */
function decoratorLine(src: string, decorator: string): number {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === decorator) {
      return i;
    }
  }
  return -1;
}

describe('路由声明顺序（源码级钉子）', () => {
  it("article.controller: @Get('deleted') 在 @Get('/:id') 之前", () => {
    const src = readSrc('src/controller/admin/article/article.controller.ts');
    const deletedIdx = decoratorLine(src, "@Get('deleted')");
    const byIdIdx = decoratorLine(src, "@Get('/:id')");
    expect(deletedIdx).toBeGreaterThan(-1);
    expect(byIdIdx).toBeGreaterThan(-1);
    expect(deletedIdx).toBeLessThan(byIdIdx);
  });

  it("draft.controller: @Get('deleted') 在 @Get('/:id') 之前", () => {
    const src = readSrc('src/controller/admin/draft/draft.controller.ts');
    const deletedIdx = decoratorLine(src, "@Get('deleted')");
    const byIdIdx = decoratorLine(src, "@Get('/:id')");
    expect(deletedIdx).toBeGreaterThan(-1);
    expect(byIdIdx).toBeGreaterThan(-1);
    expect(deletedIdx).toBeLessThan(byIdIdx);
  });
});

describe('协作者权限映射（types/access/access.ts）', () => {
  it('purge 与既有软删同权限档；restore 与 update 同档', () => {
    expect(pathPermissionMap['delete-/api/admin/article/:id/purge']).toBe('article:delete');
    expect(pathPermissionMap['delete-/api/admin/article/:id']).toBe('article:delete');
    expect(pathPermissionMap['put-/api/admin/article/:id/restore']).toBe('article:update');
    expect(pathPermissionMap['put-/api/admin/article/:id/revisions/:revisionId/restore']).toBe(
      'article:update',
    );
    expect(pathPermissionMap['delete-/api/admin/draft/:id/purge']).toBe('draft:delete');
    expect(pathPermissionMap['put-/api/admin/draft/:id/restore']).toBe('draft:update');
    // permissionRoutes 必须真的包含这些键（协作者守卫按它放行）
    for (const key of [
      'delete-/api/admin/article/:id/purge',
      'put-/api/admin/article/:id/restore',
      'put-/api/admin/article/:id/revisions/:revisionId/restore',
      'delete-/api/admin/draft/:id/purge',
      'put-/api/admin/draft/:id/restore',
    ]) {
      expect(permissionRoutes).toContain(key);
    }
  });

  it('只读回收站/历史版本列表对协作者开放（与既有只读列表一致），写接口不开放', () => {
    expect(publicRoutes).toContain('get-/api/admin/article/deleted');
    expect(publicRoutes).toContain('get-/api/admin/draft/deleted');
    expect(publicRoutes).toContain('get-/api/admin/article/:id/revisions');
    expect(publicRoutes).toContain('get-/api/admin/article/:id/revisions/:revisionId');
    expect(publicRoutes).not.toContain('delete-/api/admin/article/:id/purge');
    expect(publicRoutes).not.toContain('put-/api/admin/article/:id/restore');
  });
});

// ---------------------------------------------------------------------------
// 控制器行为（假 provider）
// ---------------------------------------------------------------------------

function createController(overrides: {
  article?: Record<string, any>;
  revision?: Record<string, any>;
} = {}) {
  const activeAll = jest.fn();
  const dispatchEvent = jest.fn(async () => []);
  const articleProvider: any = {
    getDeleted: jest.fn(async () => ({ articles: [], total: 0 })),
    restoreById: jest.fn(async () => null),
    purgeById: jest.fn(async () => ({ purged: true, id: 5 })),
    findDeletedById: jest.fn(async () => null),
    getById: jest.fn(async () => null),
    updateById: jest.fn(async () => ({ modifiedCount: 1 })),
    ...overrides.article,
  };
  const revisionProvider: any = {
    enabled: jest.fn(() => true),
    listMeta: jest.fn(async () => ({ revisions: [], total: 0 })),
    getOne: jest.fn(async () => null),
    appendSafe: jest.fn(async () => null),
    ...overrides.revision,
  };
  const controller = new ArticleController(
    articleProvider,
    { activeAll } as any,
    { dispatchEvent } as any,
    revisionProvider,
  );
  return { controller, articleProvider, revisionProvider, activeAll, dispatchEvent };
}

describe('ArticleController 回收站', () => {
  it('GET deleted：{statusCode,data:{articles,total}} 信封', async () => {
    const rows = [{ id: 2, title: 'x' }];
    const { controller, articleProvider } = createController({
      article: { getDeleted: jest.fn(async () => ({ articles: rows, total: 1 })) },
    });
    const res: any = await controller.getDeleted(1, 10);
    expect(res).toEqual({ statusCode: 200, data: { articles: rows, total: 1 } });
    expect(articleProvider.getDeleted).toHaveBeenCalledWith(1, 10);
  });

  it('restore：不在回收站 → 404；成功 → ISR 带 postId+previousPathname + afterUpdateArticle 事件', async () => {
    const miss = createController();
    await expect(miss.controller.restore(5)).rejects.toBeInstanceOf(NotFoundException);

    const restored = { id: 5, pathname: 'p5', title: 't' };
    const { controller, activeAll, dispatchEvent } = createController({
      article: { restoreById: jest.fn(async () => restored) },
    });
    const res: any = await controller.restore(5);
    expect(res.statusCode).toBe(200);
    expect(res.data).toBe(restored);
    expect(activeAll).toHaveBeenCalledWith(
      '恢复文章触发增量渲染！',
      undefined,
      { postId: 5, previousPathname: 'p5' },
    );
    expect(dispatchEvent).toHaveBeenCalledWith('afterUpdateArticle', restored);
  });

  it('purge：未软删 → 404（"请先移入回收站"）；成功 → 用软删文档的 pathname 触发 ISR', async () => {
    const miss = createController();
    await expect(miss.controller.purge(5)).rejects.toBeInstanceOf(NotFoundException);

    const { controller, articleProvider, activeAll } = createController({
      article: {
        findDeletedById: jest.fn(async () => ({ id: 5, pathname: 'p5' })),
        purgeById: jest.fn(async () => ({ purged: true, id: 5 })),
      },
    });
    const res: any = await controller.purge(5);
    expect(res).toEqual({ statusCode: 200, data: { purged: true, id: 5 } });
    expect(articleProvider.findDeletedById).toHaveBeenCalledWith(5, 'list');
    expect(activeAll).toHaveBeenCalledWith('彻底删除文章触发增量渲染！', undefined, {
      postId: 5,
      previousPathname: 'p5',
    });
  });
});

describe('ArticleController 历史版本', () => {
  it('list：响应带 enabled 标志（区分"功能关闭"与"还没有历史版本"）', async () => {
    const on = createController({
      revision: {
        enabled: jest.fn(() => true),
        listMeta: jest.fn(async () => ({ revisions: [{ _id: 'r1' }], total: 1 })),
      },
    });
    expect(await on.controller.listRevisions(5, 1, 20)).toEqual({
      statusCode: 200,
      data: { revisions: [{ _id: 'r1' }], total: 1, enabled: true },
    });
    const off = createController({ revision: { enabled: jest.fn(() => false) } });
    const res: any = await off.controller.listRevisions(5, 1, 20);
    expect(res.data.enabled).toBe(false);
  });

  it('getRevision：不属于这篇文章/不存在 → 404；命中 → 含 content 的契约字段', async () => {
    const miss = createController();
    await expect(miss.controller.getRevision(5, 'aaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const hit = createController({
      revision: {
        getOne: jest.fn(async () => ({
          toObject: () => ({
            _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            articleId: 5,
            savedAt: '2026-09-17T00:00:00Z',
            title: '旧题',
            content: '旧文',
            wordCount: 2,
            sizeBytes: 6,
            reason: 'update',
          }),
        })),
      },
    });
    const res: any = await hit.controller.getRevision(5, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(res.data).toEqual({
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      articleId: 5,
      savedAt: '2026-09-17T00:00:00Z',
      title: '旧题',
      content: '旧文',
      wordCount: 2,
      sizeBytes: 6,
      reason: 'update',
    });
  });

  it('restoreRevision：先记 pre-restore 快照，再 skipRevision 写回，最后触发 ISR', async () => {
    const calls: string[] = [];
    const revision: any = {
      getOne: jest.fn(async () => ({ _id: 'rid', title: '旧题', content: '旧文' })),
      appendSafe: jest.fn(async (...args: any[]) => {
        calls.push('snapshot');
        expect(args[3]).toBe('pre-restore');
        expect(args[1]).toEqual({ title: '当前题', content: '当前文' }); // 快照=恢复前状态
        return { _id: 'snap' };
      }),
    };
    const article: any = {
      getById: jest.fn(async () => ({ id: 5, title: '当前题', content: '当前文', pathname: 'p5' })),
      updateById: jest.fn(async (...args: any[]) => {
        calls.push('update');
        expect(args[1]).toEqual({ title: '旧题', content: '旧文' });
        expect(args[3]).toEqual({ skipRevision: true }); // 别让 updateById 再记一条重复快照
        return { modifiedCount: 1 };
      }),
    };
    const { controller, activeAll } = createController({ article, revision });
    const res: any = await controller.restoreRevision(5, 'rid');
    expect(calls).toEqual(['snapshot', 'update']); // 顺序：快照必须在写回之前
    expect(res).toEqual({
      statusCode: 200,
      data: { restored: true, articleId: 5, revisionId: 'rid', snapshotRevisionId: 'snap' },
    });
    expect(activeAll).toHaveBeenCalled();
    expect(activeAll.mock.calls[0][2]).toMatchObject({ postId: 5, previousPathname: 'p5' });
  });

  it('restoreRevision：文章不存在或版本不存在 → 404，什么都不写', async () => {
    const c1 = createController(); // getOne → null
    await expect(c1.controller.restoreRevision(5, 'rid')).rejects.toBeInstanceOf(NotFoundException);
    const c2 = createController({
      revision: { getOne: jest.fn(async () => ({ _id: 'rid', title: 't', content: 'c' })) },
      article: { getById: jest.fn(async () => null) },
    });
    await expect(c2.controller.restoreRevision(5, 'rid')).rejects.toBeInstanceOf(NotFoundException);
    expect(c2.articleProvider.updateById).not.toHaveBeenCalled();
    expect(c2.revisionProvider.appendSafe).not.toHaveBeenCalled();
  });
});

describe('DraftController 回收站（契约与文章一致）', () => {
  it('restore 404 / purge 404 与成功信封', async () => {
    const draftProvider: any = {
      restoreById: jest.fn(async () => null),
      findDeletedById: jest.fn(async () => null),
      purgeById: jest.fn(async () => ({ purged: true, id: 3 })),
      getDeleted: jest.fn(async () => ({ drafts: [], total: 0 })),
    };
    const controller = new DraftController(
      draftProvider,
      {} as any,
      { dispatchEvent: jest.fn(async () => []) } as any,
    );
    await expect(controller.restore(3)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.purge(3)).rejects.toBeInstanceOf(NotFoundException);
    draftProvider.restoreById.mockResolvedValueOnce({ id: 3, title: 'd' });
    expect((await controller.restore(3) as any).statusCode).toBe(200);
    draftProvider.findDeletedById.mockResolvedValueOnce({ id: 3 });
    expect(await controller.purge(3)).toEqual({
      statusCode: 200,
      data: { purged: true, id: 3 },
    });
    expect(await controller.getDeleted(1, 10)).toEqual({
      statusCode: 200,
      data: { drafts: [], total: 0 },
    });
  });
});
