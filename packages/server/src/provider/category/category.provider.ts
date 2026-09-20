import { Injectable, NotAcceptableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ArticleProvider } from '../article/article.provider';
import { DraftProvider } from '../draft/draft.provider';
import { CategoryDocument } from 'src/scheme/category.schema';
import { sleep } from 'src/utils/sleep';
import { UpdateCategoryDto } from 'src/types/category.dto';
import { BackupCategory } from 'src/utils/backupCategories';
import { applyCategoryNameOrder, nextCategoryOrder, sortCategoriesByOrder } from 'src/utils/categoryOrder';
import { assertSafeWriteFilter, isUsableFilterValue } from 'src/utils/queryFilter';
import {
  hashAccessPasswordIdempotentAsync,
  isScryptHash,
  resolveAccessPasswordWriteAsync,
} from 'src/utils/accessPassword';

@Injectable()
export class CategoryProvider {
  idLock = false;
  constructor(
    @InjectModel('Category') private categoryModal: Model<CategoryDocument>,
    private readonly articleProvider: ArticleProvider,
    private readonly draftProvider: DraftProvider,
  ) {}
  async getCategoriesWithArticle(includeHidden: boolean) {
    const allArticles = await this.articleProvider.getAll('list', includeHidden);
    const categories = await this.getAllCategories(false, includeHidden);
    const data = {};
    categories.forEach((c) => {
      data[c] = [];
    });
    allArticles.forEach((a) => {
      data[a.category]?.push(a);
    });
    return data;
  }
  async getPieData() {
    const oldData = await this.getCategoriesWithArticle(true);
    const categories = Object.keys(oldData);
    if (!categories || categories.length < 0) {
      return [];
    }
    const res = [];
    categories.forEach((c) => {
      res.push({
        type: c,
        value: oldData[c].length || 0,
      });
    });
    return res;
  }

  isHiddenCategory(doc: { hidden?: boolean } | null | undefined) {
    return Boolean(doc?.hidden);
  }

  async getPublicCategoryNames() {
    return this.getAllCategories(false, false);
  }

  async getAllCategories(all?: boolean, includeHidden = true) {
    const d = await this.categoryModal.find({});
    if (!d || !d.length) {
      return [];
    }
    const list = includeHidden ? d : d.filter((item) => !this.isHiddenCategory(item));
    const sorted = sortCategoriesByOrder(list);
    if (all) return sorted;
    else return sorted.map((item) => item.name);
  }

  async getArticlesByCategory(name: string, includeHidden: boolean) {
    const d = await this.getCategoriesWithArticle(includeHidden);
    return d[name] ?? [];
  }

  async importCategories(categories: BackupCategory[]) {
    if (!categories || !categories.length) {
      return;
    }
    for (const item of categories) {
      if (!item?.name) {
        continue;
      }
      const existData = await this.categoryModal.findOne({
        name: item.name,
      });
      if (existData) {
        const patch: Partial<BackupCategory> = {};
        if (item.private !== undefined) {
          patch.private = item.private;
        }
        if (item.password !== undefined) {
          // 导入的备份里可能是明文（旧归档），也可能已经是哈希（新归档 / 导出后原样导回）：
          // hashAccessPasswordIdempotentAsync 两种都收敛成"一个哈希"，绝不二次哈希。
          // ⚠️ 异步版：导入是批量循环，同步 scrypt 每次阻塞事件循环约 63 ms。
          patch.password = await hashAccessPasswordIdempotentAsync(item.password);
        }
        if (item.hidden !== undefined) {
          patch.hidden = item.hidden;
        }
        if (item.order !== undefined) {
          patch.order = item.order;
        }
        if (item.type !== undefined) {
          patch.type = item.type;
        }
        if (Object.keys(patch).length) {
          await this.categoryModal.updateOne({ name: item.name }, patch);
        }
        continue;
      }
      let id = item.id;
      if (id != null) {
        const existById = await this.categoryModal.findOne({ id });
        if (existById) {
          id = await this.getNewId();
        }
      } else {
        id = await this.getNewId();
      }
      const existing = await this.categoryModal.find({});
      await this.categoryModal.create({
        id,
        name: item.name,
        type: item.type || 'category',
        private: item.private || false,
        password: await hashAccessPasswordIdempotentAsync(item.password || ''),
        hidden: item.hidden || false,
        order: typeof item.order === 'number' ? item.order : nextCategoryOrder(existing),
      });
    }
  }

  async addOne(name: string) {
    const existData = await this.categoryModal.findOne({
      name,
    });
    if (existData) {
      throw new NotAcceptableException('分类名重复，无法创建！');
    } else {
      const existing = await this.categoryModal.find({});
      await this.categoryModal.create({
        id: await this.getNewId(),
        name,
        type: 'category',
        private: false,
        hidden: false,
        order: nextCategoryOrder(existing),
      });
    }
  }

  async getNewId() {
    while (this.idLock) {
      await sleep(10);
    }
    this.idLock = true;
    try {
    const maxObj = await this.categoryModal.find({}).sort({ id: -1 }).limit(1);
    let res = 1;
    if (maxObj.length) {
      res = maxObj[0].id + 1;
    }
      return res;
    } finally {
      // 一次查询失败就会让 idLock 永远为 true，之后所有新建请求都在 while 里空转，
      // 只能重启进程才能恢复 —— 所以必须放在 finally 里释放
      this.idLock = false;
    }
  }

  async deleteOne(name: string) {
    // ⚠️ 校验放在**最前面**，不要依赖下面那次文章检查来兜底。
    // `deleteOne({ name: undefined })` 会被 Mongoose 丢掉那个条件 ⇒ 退化成 `deleteOne({})` ⇒
    // 删掉集合里自然顺序的**第一个分类**。目前 HTTP 入口是 `@Delete('/:name')`（路径参数必填），
    // 所以 undefined 到不了这里；但"安全依赖于路由形状"是脆的（换一个调用方、或改成 query 参数就破了），
    // 而 `getArticlesByCategory(undefined)` 只在**库里还有文章**时才会因为"分类已有文章"抛错 ——
    // 空库（或文章全删光）时它会一路走到删除。与本仓库已修的同族缺陷（checkToken、
    // updateCollaborator、customPage 的 update/delete）是同一个形状，所以按同一条规矩显式校验。
    if (!isUsableFilterValue(name)) {
      throw new NotAcceptableException('删除分类必须带分类名（name 不能为空）。');
    }
    // 先检查一下有没有这个分类的文章
    const d = await this.getArticlesByCategory(name, true);
    if (d && d.length) {
      throw new NotAcceptableException('分类已有文章，无法删除！');
    }
    const filter: Record<string, unknown> = { name };
    assertSafeWriteFilter(filter, 'CategoryProvider.deleteOne');
    await this.categoryModal.deleteOne(filter);
  }

  async reorderCategories(names: string[]) {
    if (!Array.isArray(names) || !names.length) {
      throw new NotAcceptableException('无有效排序信息！');
    }
    const docs = await this.categoryModal.find({});
    if (!docs || !docs.length) {
      throw new NotAcceptableException('无分类可排序！');
    }
    const updates = applyCategoryNameOrder(docs, names);
    if (!updates.length) {
      throw new NotAcceptableException('无有效排序信息！');
    }
    for (const item of updates) {
      await this.categoryModal.updateOne({ name: item.name }, { order: item.order });
    }
    return updates;
  }

  async updateCategoryByName(name: string, dto: UpdateCategoryDto) {
    if (Object.keys(dto).length == 0) {
      throw new NotAcceptableException('无有效信息，无法修改！');
    }
    if (dto.order !== undefined && (typeof dto.order !== 'number' || !Number.isFinite(dto.order))) {
      throw new NotAcceptableException('排序值无效！');
    }
    // 访问密码（P1/P5）：与文章完全同一套规则（utils/accessPassword.ts）——
    // 留空/缺键 = **不修改**，`clearPassword: true` = 解除加密，填了新值 = 存 scrypt 哈希。
    // 分类密码是"该分类下所有文章"的解锁钥匙，明文存库的代价比单篇文章更大。
    // ⚠️ 异步变体 + await（同步 scrypt 每次阻塞事件循环约 63 ms；漏 await 会让
    //    `passwordWrite.password` 变成 undefined ⇒ 静默走"不修改密码"分支）。
    const passwordWrite = await resolveAccessPasswordWriteAsync(dto, 'update');
    const patch: any = { ...dto };
    delete patch.clearPassword;
    if (passwordWrite.password === undefined) {
      delete patch.password;
    } else {
      patch.password = passwordWrite.password;
    }
    // 顺手升级（P2）：这次没碰密码，但库里存的还是历史明文 —— 趁这次写一起换成哈希，
    // 这样一台从不重启的站点也能收敛。读失败只 WARN，绝不把改名/改排序本身带崩。
    if (passwordWrite.password === undefined) {
      try {
        const stored: any = await this.categoryModal.findOne({ name }, { password: 1 });
        const legacy = stored?.password;
        if (legacy !== undefined && legacy !== null && legacy !== '' && !isScryptHash(String(legacy))) {
          patch.password = await hashAccessPasswordIdempotentAsync(legacy);
        }
      } catch {
        // 忽略：启动 wash 会兜底
      }
    }
    if (dto.name && name != dto.name) {
      const existData = await this.categoryModal.findOne({
        name: dto.name,
      });
      if (existData) {
        throw new NotAcceptableException('分类名重复，无法修改！');
      }
      // Articles and drafts store the category as a name string, so rename
      // must rewrite every reference. updateMany avoids depending on list
      // views / numeric ids, and also covers hidden or soft-deleted docs.
      await this.articleProvider.updateCategoryName(name, dto.name);
      await this.draftProvider.updateCategoryName(name, dto.name);
    }
    // 只剩一个空 patch（比如请求里 password 是空串 = "不修改"，别的键都没有）：
    // mongoose 的 updateOne 不接受"没有任何原子操作符"的更新文档，会直接抛错。
    // 语义上这就是"没东西要改"，安静返回即可（改名那种带副作用的分支不可能走到这里）。
    if (Object.keys(patch).length === 0) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 } as any;
    }
    await this.categoryModal.updateOne(
      {
        name: name,
      },
      {
        ...patch,
      },
    );
  }
}
