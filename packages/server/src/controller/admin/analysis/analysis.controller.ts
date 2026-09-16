import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminGuard } from 'src/provider/auth/auth.guard';

import { AnalysisProvider, WelcomeTab } from 'src/provider/analysis/analysis.provider';
import { ApiToken } from 'src/provider/swagger/token';
import { sanitizeDataNum } from 'src/utils/pagination';

/** 三个 num 参数缺省时的值（与 `@Query` 的默认值保持一致） */
const DEFAULT_DATA_NUM = 5;

@ApiTags('analysis')
@ApiToken
@UseGuards(...AdminGuard)
@Controller('/api/admin/analysis')
export class AnalysisController {
  constructor(private readonly analysisProvider: AnalysisProvider) {}

  @Get()
  async getWelcomePageData(
    @Query('tab') tab: WelcomeTab,
    @Query('viewerDataNum') viewerDataNum = 5,
    @Query('overviewDataNum') overviewDataNum = 5,
    @Query('articleTabDataNum') articleTabDataNum = 5,
  ) {
    // ⚠️ 以前是裸的 `parseInt(...)`：
    //  - `?overviewDataNum=abc` → NaN → `getViewerGrid` 的 `for (i = NaN; i >= 0; i--)`
    //    一次都不跑 ⇒ 200 + 一整屏 0，看起来像"站点没访问量"（错误与空结果分不出来）；
    //  - `?overviewDataNum=999999999` → 那个循环先 push 十亿个日期字符串、
    //    再把十亿元素的 `$in` 发给 Mongo ⇒ 一个请求就能把进程堆吃光。
    // 现在统一走 sanitizeDataNum：非法值回落 5，合法值夹到 [0, MAX_DATA_NUM]。
    const data = await this.analysisProvider.getWelcomePageData(
      tab,
      sanitizeDataNum(overviewDataNum, DEFAULT_DATA_NUM),
      sanitizeDataNum(viewerDataNum, DEFAULT_DATA_NUM),
      sanitizeDataNum(articleTabDataNum, DEFAULT_DATA_NUM),
    );
    return {
      statusCode: 200,
      data,
    };
  }
}
