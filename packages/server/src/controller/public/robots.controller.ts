import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { buildRobotsTxt } from 'src/utils/robotsTxt';
import { washUrl } from 'src/utils/washUrl';

/**
 * 动态生成 robots.txt。
 *
 * 为什么不用 `packages/website/public/robots.txt` 那个静态文件：`Sitemap:` 指令**必须是绝对 URL**，
 * 而静态文件不知道站点域名（每个部署都不一样）。以前就是因为这个，robots.txt 里根本没有
 * Sitemap 行 —— 爬虫只能靠自己猜或者等站长在 Search Console 里手动提交。
 *
 * 顺带把不该被抓的路径补齐：`/api/`、后台 `/admin/`、`/swagger`（整个后台 API 面的文档）、
 * 以及导出归档/临时目录（虽然是鉴权的，但没必要让爬虫去撞）。
 *
 * 🔴 期 12 第一批：站长可以在后台「站点设置 → 高级设置 → robots.txt」**整份替换**这份默认内容
 *    （留空 = 用默认；默认立场是**开放收录**）。
 *    生成与净化逻辑都在 `src/utils/robotsTxt.ts`（**纯函数**，与写入侧 `updateSiteInfo` 共用同一份），
 *    本控制器只负责"取站点信息 → 组装 → 下发"，不再自己拼字符串。
 *    🔴 拼装留在控制器里就意味着**写入侧与读出侧各有一份口径**，而"后台看到的与爬虫拿到的不一样"
 *    是这类字段最难查的漂移（本仓库在 `siteInfo` 的三段页面文案上吃过一次）。
 */
@ApiTags('public')
@Controller()
export class RobotsController {
  constructor(private readonly metaProvider: MetaProvider) {}

  @Get('/robots.txt')
  async robots(@Res() res: Response) {
    let siteInfo: any = null;
    try {
      siteInfo = await this.metaProvider.getSiteInfo();
    } catch {
      // 🔴 读库失败也要 200 + 一份默认内容：robots.txt 返回 500 会让爬虫**拿不到任何规则**，
      //    搜索引擎按"无 robots.txt"处理 ⇒ 连 /api/ 与后台都会去撞一遍（比下发默认内容更糟）。
      siteInfo = null;
    }
    const { body } = buildRobotsTxt(siteInfo, washUrl);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    // robots.txt 会被爬虫高频请求，缓存一小时足够（改了站点 URL 最多一小时后生效）
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(body);
  }
}
