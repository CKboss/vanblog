import { Injectable } from '@nestjs/common';
import { ArticleProvider } from '../article/article.provider';
import { ViewerProvider } from '../viewer/viewer.provider';
import { MetaProvider } from '../meta/meta.provider';
import { ArticleTabData, ViewerTabData } from 'src/types/analysis';
import { VisitProvider } from '../visit/visit.provider';
import { TagProvider } from '../tag/tag.provider';
import { CategoryProvider } from '../category/category.provider';
export type WelcomeTab = 'overview' | 'viewer' | 'article';
@Injectable()
export class AnalysisProvider {
  constructor(
    private readonly metaProvider: MetaProvider,
    private readonly articleProvider: ArticleProvider,
    private readonly viewProvider: ViewerProvider,
    private readonly visitProvider: VisitProvider,
    private readonly tagProvider: TagProvider,
    private readonly categoryProvider: CategoryProvider,
  ) {}

  async getOverViewTabData(num: number) {
    // 四个读互不依赖，串行 await 时后台概览页要等"四次往返之和"；
    // 并行之后总耗时 ≈ 最慢的那一个（与 §7.44 给 /api/public/meta 做的是同一件事）。
    // 返回对象的字段与键顺序和原来逐字一致。
    const [wordCount, articleNum, viewer, siteInfo] = await Promise.all([
      this.metaProvider.getTotalWords(),
      this.articleProvider.getTotalNum(true),
      this.viewProvider.getViewerGrid(num),
      this.metaProvider.getSiteInfo(),
    ]);
    return {
      total: { wordCount, articleNum },
      viewer,
      link: {
        baseUrl: siteInfo.baseUrl,
        enableComment: siteInfo.enableComment || 'true',
      },
    };
  }

  async getViewerTabData(num: number): Promise<ViewerTabData> {
    // 六个互不依赖的读，一次并行取回（原来串行 6 次往返）
    const [siteInfo, topViewer, topVisited, recentVisitArticles, lastVisitItem, totals] =
      await Promise.all([
        this.metaProvider.getSiteInfo(),
        this.articleProvider.getTopViewer('list', num),
        this.articleProvider.getTopVisited('list', num),
        this.articleProvider.getRecentVisitedArticles(num, 'list'),
        this.visitProvider.getLastVisitItem(),
        this.metaProvider.getViewer(),
      ]);
    const enableGA = Boolean(siteInfo.gaAnalysisId) && siteInfo.gaAnalysisId != '';
    const enableBaidu = Boolean(siteInfo.baiduAnalysisId) && siteInfo.baiduAnalysisId != '';
    let siteLastVisitedTime = null;
    let siteLastVisitedPathname = '';
    if (lastVisitItem) {
      siteLastVisitedTime = lastVisitItem.lastVisitedTime;
      siteLastVisitedPathname = lastVisitItem.pathname;
    }
    const { viewer: totalViewer, visited: totalVisited } = totals;
    let maxArticleVisited = 0;
    let maxArticleViewer = 0;
    if (topViewer && topViewer.length > 0) {
      maxArticleViewer = topViewer[0].viewer;
    }
    if (topVisited && topVisited.length > 0) {
      maxArticleVisited = topVisited[0].visited;
    }
    return {
      enableGA,
      enableBaidu,
      topViewer,
      topVisited,
      recentVisitArticles,
      siteLastVisitedTime,
      siteLastVisitedPathname,
      totalViewer,
      totalVisited,
      maxArticleVisited,
      maxArticleViewer,
    };
  }

  async getArticleTabData(num: number): Promise<ArticleTabData> {
    // 同样：六个互不依赖的读一次并行取回
    const [articleNum, wordNum, tags, categories, categoryPieData, columnData] =
      await Promise.all([
        this.articleProvider.getTotalNum(true),
        this.metaProvider.getTotalWords(),
        this.tagProvider.getAllTags(true),
        this.categoryProvider.getAllCategories(),
        this.categoryProvider.getPieData(),
        this.tagProvider.getColumnData(num, true),
      ]);
    return {
      articleNum,
      wordNum,
      tagNum: tags?.length || 0,
      categoryNum: categories?.length || 0,
      categoryPieData,
      columnData,
    };
  }

  async getWelcomePageData(
    tab: WelcomeTab,
    overviewDataNum: number,
    viewerDataNum: number,
    articleTabDataNum: number,
  ) {
    // 总字数和总文章数
    if (tab == 'overview') {
      return await this.getOverViewTabData(overviewDataNum);
    }
    if (tab == 'viewer') {
      return await this.getViewerTabData(viewerDataNum);
    }
    if (tab == 'article') {
      return await this.getArticleTabData(articleTabDataNum);
    }
  }
}
