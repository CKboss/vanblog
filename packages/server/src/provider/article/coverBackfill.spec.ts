import { ArticleProvider } from './article.provider';

/** 只造 backfill/revert 用到的那几个 model 方法 */
function makeProvider(articles: any[]) {
  const rows = articles.map((a) => ({ ...a }));
  const updates: Array<{ id: number; patch: any }> = [];
  const articleModel: any = {
    find: (filter: any, projection: any) => ({
      exec: async () =>
        rows.filter((r) => {
          if (filter?.deleted === false && r.deleted) return false;
          if (filter?.id?.$in && !filter.id.$in.includes(r.id)) return false;
          return true;
        }),
    }),
    updateOne: (filter: any, patch: any) => ({
      exec: async () => {
        const row = rows.find((r) => r.id === filter.id);
        if (!row) return { modifiedCount: 0 };
        if (filter.cover?.$ne !== undefined && row.cover === filter.cover.$ne) {
          return { modifiedCount: 0 };
        }
        Object.assign(row, patch);
        updates.push({ id: row.id, patch });
        return { modifiedCount: 1 };
      },
    }),
  };
  const provider = new ArticleProvider(articleModel, {} as any, {} as any, {} as any);
  return { provider, rows, updates };
}

const base = [
  { id: 1, title: '有图没封面', cover: '', content: '![a](/static/img/a.webp)', deleted: false },
  { id: 2, title: '已有封面', cover: '/static/img/old.webp', content: '![a](/static/img/b.webp)', deleted: false },
  { id: 3, title: '纯文字', cover: '', content: '没有图片', deleted: false },
  { id: 4, title: '已删除', cover: '', content: '![a](/static/img/d.webp)', deleted: true },
];

describe('批量回填封面', () => {
  it('dryRun 只统计与预览，不写库', async () => {
    const { provider, rows, updates } = makeProvider(base);
    const res = await provider.backfillCoversFromContent({ dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.scanned).toBe(3); // 已删除的不扫
    expect(res.matched).toBe(1);
    expect(res.changed).toBe(0);
    expect(res.skippedHasCover).toBe(1);
    expect(res.skippedNoImage).toBe(1);
    expect(res.items).toEqual([
      { id: 1, title: '有图没封面', cover: '/static/img/a.webp', previousCover: '' },
    ]);
    expect(updates).toHaveLength(0);
    expect(rows[0].cover).toBe('');
  });

  it('真正执行时写入 cover，并带上 previousCover 以便撤销', async () => {
    const { provider, rows, updates } = makeProvider(base);
    const res = await provider.backfillCoversFromContent({ dryRun: false });
    expect(res.changed).toBe(1);
    expect(rows[0].cover).toBe('/static/img/a.webp');
    expect(updates[0].patch.cover).toBe('/static/img/a.webp');
    expect(updates[0].patch.updatedAt).toBeInstanceOf(Date);
    // 已有封面的不动，纯文字的不动，已删除的不动
    expect(rows[1].cover).toBe('/static/img/old.webp');
    expect(rows[2].cover).toBe('');
    expect(rows[3].cover).toBe('');
  });

  it('幂等：跑第二次什么都不写', async () => {
    const { provider } = makeProvider(base);
    await provider.backfillCoversFromContent({ dryRun: false });
    const second = await provider.backfillCoversFromContent({ dryRun: false });
    expect(second.changed).toBe(0);
    expect(second.skippedHasCover).toBe(2);
  });

  it('onlyMissing=false 时会覆盖已有封面（并把旧值记进 previousCover）', async () => {
    const { provider, rows } = makeProvider(base);
    const res = await provider.backfillCoversFromContent({ dryRun: false, onlyMissing: false });
    expect(res.changed).toBe(2);
    expect(rows[1].cover).toBe('/static/img/b.webp');
    expect(res.items.find((i) => i.id === 2)?.previousCover).toBe('/static/img/old.webp');
  });

  it('可以只处理指定 id（后台预览里取消勾选某几篇时用）', async () => {
    const { provider, rows } = makeProvider(base);
    const res = await provider.backfillCoversFromContent({ dryRun: false, ids: [3] });
    expect(res.scanned).toBe(1);
    expect(res.changed).toBe(0);
    expect(rows[0].cover).toBe('');
  });

  it('撤销：把 cover 写回旧值；用户后来又手改过的不会被覆盖', async () => {
    const { provider, rows } = makeProvider(base);
    await provider.backfillCoversFromContent({ dryRun: false });
    expect(rows[0].cover).toBe('/static/img/a.webp');

    const res = await provider.revertCovers([{ id: 1, cover: '' }]);
    expect(res.reverted).toBe(1);
    expect(rows[0].cover).toBe('');

    // 再撤一次：当前值已经等于目标值 → 不算改动
    const again = await provider.revertCovers([{ id: 1, cover: '' }]);
    expect(again.reverted).toBe(0);
    expect(again.skipped).toBe(1);

    // 非法 id 直接跳过，不抛
    const bad = await provider.revertCovers([{ id: 'x' as any, cover: '' }, null as any]);
    expect(bad.reverted).toBe(0);
    expect(bad.skipped).toBe(2);
  });
});
