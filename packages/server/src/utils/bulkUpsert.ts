/**
 * 把「导入一批文档」从"每条两次往返"变成"每批一次往返"的公共构造器。
 *
 * 背景：`VisitProvider.import` / `ViewerProvider.import` 是整站 JSON 导入
 * （`POST /api/admin/backup/import`）里最慢的一步，写法都是
 *
 *     for (const each of data) {
 *       const old = await model.findOne(<唯一键>);
 *       if (old) await model.updateOne({ _id: old._id }, each);
 *       else await new model(each).save();
 *     }
 *
 * 本机那份生产备份里 `visits` 有 **8,770 条**，也就是一万七千多次**串行**往返
 * （每次 ~0.2–1ms，实测整段 6–20 秒，全程占着一个请求）。
 *
 * 这里构造 `bulkWrite` 的 `updateOne + upsert` 操作数组，语义与老写法逐条对齐：
 *  - 命中已有文档 ⇒ 用备份里的字段覆盖（老的 `updateOne({_id}, each)` 就是覆盖式更新，
 *    所以 `createdAt` 也照样进 `$set`，**不**放进 `$setOnInsert`）；
 *  - 没有 ⇒ 插入，并且沿用备份里的 `_id`（如果有的话；整站导入那条路已经
 *    先过 `utils/removeId.ts` 把 `_id`/`__v` 去掉了，那种情况下由 Mongo 生成）；
 *  - 唯一键字段只出现在 filter 与 `$setOnInsert` 里（同时进 `$set` 会和
 *    `$setOnInsert` 撞出 "would create a conflict" 错误）；
 *  - schema 的默认值（`createdAt`）在 upsert 插入时**不会**被 mongoose 自动补上，
 *    所以备份里缺这个字段时显式塞进 `$setOnInsert`。
 *
 * ⚠️ 调用方要用 `{ ordered: true }`：备份里可能存在同一唯一键的重复行
 * （`visits` 那个"并发首访产生重复行"的老 bug 就是这样攒出来的），
 * 有序执行时第一条插入、第二条命中刚插入的那条并覆盖 —— 与老的串行写法一致；
 * 无序执行则可能两条都走插入、撞唯一索引报 E11000。
 */
export interface UpsertDoc {
  [key: string]: unknown;
}

export function buildUpsertOps(docs: UpsertDoc[], uniqueKeys: string[]): Array<{
  updateOne: {
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
    upsert: boolean;
  };
}> {
  const ops: Array<{
    updateOne: {
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
      upsert: boolean;
    };
  }> = [];
  for (const doc of docs || []) {
    if (!doc || typeof doc !== 'object') {
      continue;
    }
    const filter: Record<string, unknown> = {};
    for (const key of uniqueKeys) {
      filter[key] = (doc as Record<string, unknown>)[key];
    }

    const setOnInsert: Record<string, unknown> = { ...filter };
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
      if (key === '__v') {
        continue; // mongoose 自己管的版本号，写进去只会造成噪音
      }
      if (key === '_id') {
        // 插入时沿用备份里的 _id；更新时绝不能碰它（_id 是不可变字段，
        // 老写法在"同唯一键但 _id 不同"时会直接抛错让整次导入失败）
        if (value !== undefined && value !== null) {
          setOnInsert._id = value;
        }
        continue;
      }
      if (uniqueKeys.includes(key)) {
        continue; // 已经在 filter 与 $setOnInsert 里
      }
      set[key] = value;
    }
    if (set.createdAt === undefined) {
      delete set.createdAt;
      setOnInsert.createdAt = new Date();
    }

    const update: Record<string, unknown> = { $setOnInsert: setOnInsert };
    if (Object.keys(set).length) {
      update.$set = set;
    }
    ops.push({ updateOne: { filter, update, upsert: true } });
  }
  return ops;
}

/** 一批多少条：太大单条命令会超过 BSON 上限，太小又拿不到批量的好处 */
export const IMPORT_CHUNK_SIZE = 500;

export function chunkArray<T>(items: T[], size: number = IMPORT_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  const step = size > 0 ? size : IMPORT_CHUNK_SIZE;
  for (let i = 0; i < (items || []).length; i += step) {
    out.push(items.slice(i, i + step));
  }
  return out;
}
