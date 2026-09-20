/**
 * 访问密码写入路径的**异步化**钉子（createArticle / updateById / updateCategoryByName）。
 *
 * ## 为什么需要这一组
 *
 * 这三处以前调的是同步的 `resolveAccessPasswordWrite`，而它内部走 scrypt：**单次阻塞事件循环
 * 约 63 ms**（本机实测）。它们是"鉴权后可达"的写入路径，所以曾经被判定为"不构成匿名 DoS 放大链"
 * 而登记进 `utils/cryptoUsageDrift.spec.ts` 的豁免清单。那个理由在"极端网络攻击环境"的威胁模型下
 * 不成立 —— **低权限协作者账号应当按"攻击者已经拿到"来设计**：一个有写权限的账号反复保存加密
 * 文章，就能持续独占事件循环、拖慢整个 worker（连带把 health 探测拖超时 ⇒ 容器判 unhealthy ⇒
 * `restart: always` 重启风暴，而重启并不能缓解，因为攻击继续）。三处现已全部迁移到
 * `resolveAccessPasswordWriteAsync`，豁免清单已清空。
 *
 * ## 漏 `await` 的后果（这才是最阴的地方）
 *
 * 漏写 `await` **不会报错**：`passwordWrite` 变成一个 Promise，`passwordWrite.password` 是
 * `undefined` ⇒ 代码走进"留空 = 不修改密码"分支 ⇒ **用户刚设的密码被静默丢弃**（文章/分类
 * 变成不加密，或保持旧密码），而且没有任何日志。所以这里同时钉两层：
 *  - **行为级**：真调 provider，断言落库的是 scrypt 哈希且能用原密码解开；
 *  - **形状级**：断言三处调用都带 `await`、且两个文件里不再出现裸的同步调用。
 *
 * ⚠️ 形状级断言只在**剥注释之后**做（`src/test-utils/anchorCode`）—— 本文件的注释里就写着
 *    `resolveAccessPasswordWrite` 这个同步名字，不剥注释就会自己把自己判红（本仓库已踩 8 次）。
 */
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { CategoryProvider } from './category.provider';
import { isScryptHash, verifyAccessPassword } from 'src/utils/crypto';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

const SRC_ROOT = resolvePath(__dirname, '../..');
const readSrc = (rel: string) => readFileSync(resolvePath(SRC_ROOT, rel), 'utf8');

const ARTICLE_REL = 'provider/article/article.provider.ts';
const CATEGORY_REL = 'provider/category/category.provider.ts';

/** 与 category.provider.spec.ts 同款的最小内存 model（只保留本文件用得到的方法）。 */
function createMemoryCategoryModel(initial: any[] = []) {
  const docs = initial.map((item) => ({ ...item }));
  const findMatching = (query: any) => {
    if (query?.name) return docs.find((item) => item.name === query.name) || null;
    if (query?.id != null) return docs.find((item) => item.id === query.id) || null;
    return null;
  };
  return {
    docs,
    findOne: jest.fn(async (query: any) => findMatching(query)),
    updateOne: jest.fn(async (query: any, patch: any) => {
      const target = findMatching(query);
      if (target) Object.assign(target, patch);
    }),
  };
}

describe('updateCategoryByName：访问密码写入是异步的，且真的落库成哈希', () => {
  it('设新密码 ⇒ 落库的是 scrypt 哈希，且能用原密码解开', async () => {
    const model = createMemoryCategoryModel([{ id: 1, name: '随笔', type: 'category', password: '' }]);
    const provider = new CategoryProvider(model as any, {} as any, {} as any);

    // ⚠️ 值必须 ≥4 个字符：本轮给访问密码加了硬下限（MIN_ACCESS_PASSWORD_LENGTH），
    //    而这条用例测的是"漏 await"，不是长度 —— 用 'pw' 会因为长度先抛 400，
    //    于是"漏 await 的探针"永远探不到东西（断言会因为另一种原因失败/通过）。
    await provider.updateCategoryByName('随笔', { password: 'pw12' } as any);

    // ⚠️ 这条就是"漏 await"的探针：漏了的话 passwordWrite.password 是 undefined，
    //    patch 会被清空并提前 return，**连 updateOne 都不会调**，库里仍是空串。
    expect(isScryptHash(model.docs[0].password)).toBe(true);
    expect(verifyAccessPassword(model.docs[0].password, 'pw12')).toBe(true);
    expect(model.updateOne).toHaveBeenCalledTimes(1);
  });

  it('留空 = 不修改：patch 里不该出现 password 键（语义没被异步化改变）', async () => {
    const model = createMemoryCategoryModel([
      { id: 1, name: '随笔', type: 'category', password: '' },
    ]);
    const provider = new CategoryProvider(model as any, {} as any, {} as any);

    // 只改排序：password 缺键 ⇒ "不修改"；库里原本是空串，也不该被顺手写成哈希
    await provider.updateCategoryByName('随笔', { order: 3 } as any);

    const patch = model.updateOne.mock.calls[0][1];
    expect(Object.prototype.hasOwnProperty.call(patch, 'password')).toBe(false);
    expect(patch.order).toBe(3);
  });

  it('clearPassword: true ⇒ 解除加密（存空串），且该字段不会漏进库', async () => {
    const model = createMemoryCategoryModel([{ id: 1, name: '随笔', type: 'category', password: '' }]);
    const provider = new CategoryProvider(model as any, {} as any, {} as any);

    await provider.updateCategoryByName('随笔', { clearPassword: true } as any);

    const patch = model.updateOne.mock.calls[0][1];
    expect(patch.password).toBe('');
    expect(Object.prototype.hasOwnProperty.call(patch, 'clearPassword')).toBe(false);
  });
});

describe('三处写入路径的调用形状（防止有人改回同步版 / 漏掉 await）', () => {
  const article = stripCommentsForAnchor(readSrc(ARTICLE_REL));
  const category = stripCommentsForAnchor(readSrc(CATEGORY_REL));

  it('article.provider 的两处都是 `await resolveAccessPasswordWriteAsync(`', () => {
    // 断言**调用形状**而不是"符号出现"：符号出现是空断言（import 行就能让它过）
    const hits = article.match(/await\s+resolveAccessPasswordWriteAsync\s*\(/g) ?? [];
    expect(hits).toHaveLength(2);
    expect(article).toContain("resolveAccessPasswordWriteAsync(createArticleDto, 'create')");
    expect(article).toContain("resolveAccessPasswordWriteAsync(updateArticleDto, 'update')");
  });

  it('category.provider 的那处是 `await resolveAccessPasswordWriteAsync(`', () => {
    const hits = category.match(/await\s+resolveAccessPasswordWriteAsync\s*\(/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(category).toContain("resolveAccessPasswordWriteAsync(dto, 'update')");
  });

  it('两个文件里都不再有裸的同步调用（剥注释后判定）', () => {
    // ⚠️ 负向断言必须剥注释：本文件与那两个源文件的注释里都写着同步版的名字
    const bare = /(?<![\w.$])resolveAccessPasswordWrite\s*\(/g;
    expect(article.match(bare) ?? []).toEqual([]);
    expect(category.match(bare) ?? []).toEqual([]);
    // import 也必须换成异步版（否则同步版仍可能被再次引入）
    expect(article).toContain('resolveAccessPasswordWriteAsync,');
    expect(category).toContain('resolveAccessPasswordWriteAsync,');
    expect(article).not.toMatch(/(?<!Async)\bresolveAccessPasswordWrite,/);
    expect(category).not.toMatch(/(?<!Async)\bresolveAccessPasswordWrite,/);
  });

  it('空转反证：上面那把尺子量在**旧形状**上必须命中（否则守卫是空的）', () => {
    const bare = /(?<![\w.$])resolveAccessPasswordWrite\s*\(/g;
    const oldShapes = [
      "const passwordWrite = resolveAccessPasswordWrite(createArticleDto, 'create');",
      "const passwordWrite = resolveAccessPasswordWrite(updateArticleDto, 'update');",
      "const passwordWrite = resolveAccessPasswordWrite(dto, 'update');",
    ];
    for (const shape of oldShapes) {
      expect(stripCommentsForAnchor(shape).match(bare) ?? []).toHaveLength(1);
    }
    // 而异步形状不该被这把尺子命中（否则上面的"不再有裸调用"会因为改名而假红）
    expect(
      stripCommentsForAnchor(
        "const passwordWrite = await resolveAccessPasswordWriteAsync(dto, 'update');",
      ).match(bare) ?? [],
    ).toEqual([]);
  });

  it('豁免清单已经清空：漂移守卫不再允许任何同步 scrypt 调用点', () => {
    // 这条与 utils/cryptoUsageDrift.spec.ts 的清单互为镜像：那边清空了，这边钉住"确实是空的"，
    // 免得有人为了方便又往清单里加一条（加一条就等于允许一处 63 ms 的事件循环阻塞回来）。
    const drift = readSrc('utils/cryptoUsageDrift.spec.ts');
    const m = drift.match(
      /const KNOWN_REMAINING_SYNC_CALLS[^=]*=\s*(\[[\s\S]*?\]);/,
    );
    expect(m).not.toBeNull();
    // 清单必须是空数组字面量（允许注释与空白）
    expect((m as RegExpMatchArray)[1].replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '')).toBe('[]');
  });
});
