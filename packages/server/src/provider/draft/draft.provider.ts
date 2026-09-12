import { safeSearchPattern } from 'src/utils/regex';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreateArticleDto } from 'src/types/article.dto';
import {
  CreateDraftDto,
  PublishDraftDto,
  SearchDraftOption,
  UpdateDraftDto,
} from 'src/types/draft.dto';
import { Draft, DraftDocument } from 'src/scheme/draft.schema';
import { ArticleProvider } from '../article/article.provider';
import { parseNumericId } from 'src/utils/numericId';
import { sanitizePagination } from 'src/utils/pagination';
import { sleep } from 'src/utils/sleep';
import {
  prepareRewriteBases,
  rewriteBaseUrlInDocuments,
  RewriteBaseUrlCount,
} from 'src/utils/rewriteBaseUrl';
export type DraftView = 'admin' | 'public' | 'list';
@Injectable()
export class DraftProvider {
  idLock = false;
  constructor(
    @InjectModel('Draft') private draftModel: Model<DraftDocument>,
    private readonly articleProvider: ArticleProvider,
  ) {}
  publicView = {
    title: 1,
    content: 1,
    tags: 1,
    category: 1,
    updatedAt: 1,
    createdAt: 1,
    author: 1,
    id: 1,
    _id: 0,
  };

  adminView = {
    title: 1,
    content: 1,
    tags: 1,
    category: 1,
    updatedAt: 1,
    createdAt: 1,
    author: 1,
    id: 1,
    _id: 0,
  };

  listView = {
    title: 1,
    tags: 1,
    category: 1,
    updatedAt: 1,
    createdAt: 1,
    author: 1,
    id: 1,
    _id: 0,
  };

  getView(view: DraftView) {
    let thisView: any = this.adminView;
    switch (view) {
      case 'admin':
        thisView = this.adminView;
        break;
      case 'list':
        thisView = this.listView;
        break;
      case 'public':
        thisView = this.publicView;
    }
    return thisView;
  }
  async create(createDraftDto: CreateDraftDto): Promise<Draft> {
    const createdData = new this.draftModel(createDraftDto);
    const newId = await this.getNewId();
    createdData.id = newId;
    return createdData.save();
  }
  async importDrafts(drafts: Draft[]) {
    // 题目相同就合并，以导入的优先
    // for (let i = 0; i < drafts.length; i++) {
    //   const newId = await this.getNewId();
    //   drafts[i].id = newId;
    // }
    for (const draft of drafts) {
      const { id, ...createDto } = draft;
      const title = draft.title;
      const oldDraft = await this.findOneByTitle(title);
      if (oldDraft) {
        // 同样必须 await，否则失败会变成 unhandledRejection 把进程带走
        await this.updateById(oldDraft.id, { ...createDto, deleted: false });
      } else {
        await this.create(createDto);
      }
    }
  }

  async rewriteBaseUrl(oldBase?: string, newBase?: string): Promise<RewriteBaseUrlCount> {
    const bases = prepareRewriteBases(oldBase, newBase);
    if (!bases) {
      return { updated: 0, replacements: 0 };
    }
    const drafts = await this.draftModel.find({
      $or: [
        {
          deleted: false,
        },
        {
          deleted: { $exists: false },
        },
      ],
    });
    return rewriteBaseUrlInDocuments(
      drafts || [],
      async (id, content) => {
        await this.draftModel.updateOne({ id }, { content, updatedAt: new Date() });
      },
      bases.oldBase,
      bases.newBase,
    );
  }

  async getByOption(option: SearchDraftOption): Promise<{ drafts: Draft[]; total: number }> {
    const query: any = {};
    const $and: any = [
      {
        $or: [
          {
            deleted: false,
          },
          {
            deleted: { $exists: false },
          },
        ],
      },
    ];
    const and = [];
    const sort: any = { createdAt: -1 };
    if (option.sortCreatedAt) {
      if (option.sortCreatedAt == 'asc') {
        sort.createdAt = 1;
      }
    }
    if (option.tags) {
      const tags = option.tags.split(',');
      const or: any = [];
      tags.forEach((t) => {
        or.push({
          tags: { $regex: safeSearchPattern(t), $options: 'i' },
        });
      });
      and.push({ $or: or });
    }
    if (option.category) {
      and.push({
        category: { $regex: safeSearchPattern(option.category), $options: 'i' },
      });
    }
    if (option.title) {
      and.push({
        title: { $regex: safeSearchPattern(option.title), $options: 'i' },
      });
    }
    if (option.startTime || option.endTime) {
      const obj: any = {};
      if (option.startTime) {
        obj['$gte'] = new Date(option.startTime);
      }
      if (option.endTime) {
        obj['$lte'] = new Date(option.endTime);
      }
      $and.push({ createdAt: obj });
    }

    if (and.length) {
      $and.push({ $and: and });
    }

    query.$and = $and;
    const view = option.toListView ? this.listView : this.adminView;

    const paging = sanitizePagination(option.page, option.pageSize);
    const drafts = await this.draftModel
      .find(query, view)
      .sort(sort)
      .skip(paging.skip)
      .limit(paging.pageSize)
      .exec();
    const total = await this.draftModel.count(query).exec();

    return {
      drafts,
      total,
    };
  }
  async publish(id: number, options: PublishDraftDto) {
    const draft = await this.getById(id);
    // 双击「发布」时第二次请求拿到的是 null（第一次已把草稿软删），
    // 以前会在 draft.title 上抛 TypeError → 500，用户只看到「Internal server error」
    if (!draft) {
      throw new BadRequestException('草稿不存在或已经发布过了');
    }
    // 没有 <!-- more --> 也允许发布：前台会自动截取正文前 200 字作为摘要
    // （packages/website/utils/articleExcerpt.ts 的 DEFAULT_OVERVIEW_CHARS）。
    const createArticleDto: CreateArticleDto = {
      title: draft.title,
      content: draft.content,
      tags: draft.tags,
      category: draft.category,
      author: draft.author,
    };
    for (const [k, v] of Object.entries(options || {})) {
      createArticleDto[k] = v;
    }
    const res = await this.articleProvider.create(createArticleDto);
    await this.deleteById(id);
    return res;
  }

  async getAll(): Promise<Draft[]> {
    return this.draftModel.find({ deleted: false }).exec();
  }

  async getById(id: number | string): Promise<Draft> {
    const numericId = parseNumericId(id);
    return this.draftModel.findOne({ id: numericId, deleted: false }).exec();
  }
  async findById(id: number | string): Promise<Draft> {
    const numericId = parseNumericId(id);
    return this.draftModel.findOne({ id: numericId }).exec();
  }
  async findOneByTitle(title: string): Promise<Draft> {
    return this.draftModel.findOne({ title }).exec();
  }

  async searchByString(str: string): Promise<Draft[]> {
    // 原来写的是 `*${str}*`：以 `*` 开头的正则本身就是非法的（"nothing to repeat"），
    // 一调就 500；而且用户输入没转义。改成转义后的字面量「包含」匹配。
    const pattern = safeSearchPattern(str);
    if (!pattern) {
      return [];
    }
    return this.draftModel
      .find({
        $or: [
          { content: { $regex: pattern, $options: 'i' } },
          { title: { $regex: pattern, $options: 'i' } },
        ],
      })
      .exec();
  }

  async findAll(): Promise<Draft[]> {
    return this.draftModel.find().exec();
  }
  async deleteById(id: number | string) {
    const numericId = parseNumericId(id);
    return this.draftModel.updateOne({ id: numericId }, { deleted: true }).exec();
  }

  async updateCategoryName(oldName: string, newName: string) {
    if (!oldName || !newName || oldName === newName) {
      return { modifiedCount: 0 };
    }
    return this.draftModel.updateMany({ category: oldName }, { category: newName });
  }

  async updateById(id: number | string, updateDraftDto: UpdateDraftDto) {
    const numericId = parseNumericId(id);
    return this.draftModel.updateOne(
      { id: numericId },
      { ...updateDraftDto, updatedAt: new Date() },
    );
  }

  async getNewId() {
    while (this.idLock) {
      await sleep(10);
    }
    this.idLock = true;
    const maxObj = await this.draftModel.find({}).sort({ id: -1 }).limit(1);
    let res = 1;
    if (maxObj.length) {
      res = maxObj[0].id + 1;
    }
    this.idLock = false;
    return res;
  }
}
