import { Injectable } from '@nestjs/common';
import { Article } from 'src/scheme/article.schema';
import { ArticleProvider } from '../article/article.provider';

@Injectable()
export class TagProvider {
  constructor(private readonly articleProvider: ArticleProvider) {}
  /**
   * @param opts.slim 可选的**精简投影**（`listSlim`：少 `hidden`/`lastVisitedTime`/`wordCount`
   *   三个字段，实测公开响应 −19.0%）。⚠️ **默认不精简**，所以不传参数时行为与从前逐字节一致
   *   （公开 API 的形状变化会破坏第三方主题/脚本，见 `public.controller.ts` 的 `@Get('tag')`）。
   *
   * 🔴 **`includeHidden === true` 时强制忽略 slim**，两个理由：
   *   ① 管理端要靠 `hidden` 字段显示"这篇是隐藏的"，而精简投影没有这个字段 ⇒
   *      两者同时给会让后台拿到一批**无法区分可见性**的文章（静默的错答案，比报错更糟）；
   *   ② `updateTagByName()` 与 `deleteOne()` 都走 `includeHidden = true`，它们要按
   *      `article.id` 改 `tags`。今天它们只传 `{tags}` 给 `updateById`（不整份保存），
   *      而 slim 保留了 `id` 与 `tags`，所以即使流过去也不会抹字段；但**将来谁把它改成
   *      "整份文档保存"就会静默抹掉三个字段** ⇒ 这条不变量是防那种漂移的。
   *   ⚠️ 与 `/api/public/category` 的 slim 是**同一条不变量**（`category.provider.ts`），
   *      两边都有行为级守卫钉住，别只改一边。
   */
  async getTagsWithArticle(includeHidden: boolean, opts?: { slim?: boolean }) {
    const slim = opts?.slim === true && !includeHidden;
    const allArticles = await this.articleProvider.getAll(
      slim ? 'listSlim' : 'list',
      includeHidden,
    );
    const data = {};
    allArticles.forEach((a) => {
      a.tags.forEach((t) => {
        if (!Object.keys(data).includes(t)) {
          data[t] = [a];
        } else {
          data[t].push(a);
        }
      });
    });
    return data;
  }
  /**
   * 只要**标签名**（排序后的字符串数组）。
   *
   * 🔴 **为什么这个方法不自己注入 Article model、直接用一个只含 tags 的窄投影查？**
   *    那看起来能省掉绝大部分传输（本方法只需要 `tags` 一个字段，而它现在经
   *    `getTagsWithArticle` → `articleProvider.getAll('list', …)` 把**全站文章 × 16 个字段**
   *    捞回来再丢掉，只留 `Object.keys()`）。原因是：**隐藏文章过滤与定时发布过滤
   *    （`{hidden:false} | {hidden:{$exists:false}}` 与 `utils/publishAt.ts` 的
   *    `visiblePublishFilter()`）都长在 `ArticleProvider.getAll()` 里面**，而 publishAt.ts 的
   *    头注释明写"所有公开读路径共用同一段过滤，**漏一条就是泄露**"。
   *    若 TagProvider 自己拼查询，就等于把这个**安全相关**的判断复制到第二处；
   *    而这里漂移的后果不是报错，是**隐藏文章（以及未到点的定时文章）的标签泄漏到公开标签列表**
   *    —— 静默的信息暴露。⇒ 宁可多传字段，也不复制过滤逻辑。
   *
   * ⚠️ 正确的省法是**给 `ArticleView` 加一个只含 tags 的窄投影**（例如 `'tagsOnly'`），
   *    让本方法走 `getAll('tagsOnly', includeHidden)`：过滤仍然由 `getAll` 独家负责，
   *    只有投影变窄。⚠️ 那需要在 `provider/article/article.provider.ts` 里加约 8 行
   *    （union 成员 + 投影常量 + `getView()` 的 case），并同步升级
   *    `article.provider.slimListView.spec.ts:277` 那条**字面量全 union 正则**
   *    与 `getView` 分派断言、以及 `getView()` 上方"四个 case 覆盖全部成员"的注释。
   *    本轮未做（那个文件由另一路改动独占）。
   *
   * ⚠️ 调用方（5 处，全部只用返回的字符串数组）：`analysis.provider:90`、`sitemap.provider:103`、
   *    `public.controller:396`（`buildPublicMeta`，**全站最热的一次读**）、
   *    `admin/tag/tag.controller:20`、`admin/backup/backup.controller:279`。
   *    返回类型是 `Object.keys(d).sort(...)` ⇒ **结构上只可能是标签名数组**，
   *    所以"换内部投影"对所有调用方都安全，前提是**过滤语义随 `includeHidden` 走**
   *    （已由 `tag.provider.slimListView.spec.ts` 的行为级守卫钉住）。
   */
  //TODO tag 改为缓存模式
  async getAllTags(includeHidden: boolean) {
    const d = await this.getTagsWithArticle(includeHidden);
    return Object.keys(d).sort((a, b) => a.localeCompare(b));
  }

  async getColumnData(topNum: number, includeHidden: boolean) {
    const data = await this.getTagsWithArticle(includeHidden);
    const tags = Object.keys(data);
    if (!tags || tags.length <= 0) {
      return [];
    }
    const res = [];
    const sortedTags = tags.sort((a, b) => {
      return data[b].length - data[a].length;
    });
    let i = 0;
    for (const t of sortedTags) {
      if (i == topNum) {
        break;
      }
      res.push({
        type: t,
        value: data[t].length || 0,
      });
      i = i + 1;
    }

    return res;
  }
  async getArticlesByTag(tagName: string, includeHidden: boolean) {
    const d = await this.getTagsWithArticle(includeHidden);
    return d[tagName] ?? [];
  }
  async updateTagByName(oldName: string, newName: string) {
    const articles: Article[] = await this.getArticlesByTag(oldName, true);
    for (const article of articles) {
      const newTags = [];
      if (article?.tags && article.tags.length > 0) {
        for (const t of article?.tags) {
          if (t != oldName) {
            newTags.push(t);
          } else {
            if (!article.tags.includes(newName)) {
              newTags.push(newName);
            }
          }
        }
      }
      await this.articleProvider.updateById(article.id, {
        tags: newTags,
      });
    }
    return { message: '更新成功！', total: articles.length };
  }
  async deleteOne(name: string) {
    const articles = await this.getArticlesByTag(name, true);
    for (const article of articles) {
      const newTags = [];
      if (article?.tags && article.tags.length > 0) {
        for (const t of article?.tags) {
          if (t != name) {
            newTags.push(t);
          }
        }
      }
      await this.articleProvider.updateById(article.id, {
        tags: newTags,
      });
    }
    return { message: '删除成功！', total: articles.length };
  }
}
