import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { MetaProvider } from 'src/provider/meta/meta.provider';
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
 */
@ApiTags('public')
@Controller()
export class RobotsController {
  constructor(private readonly metaProvider: MetaProvider) {}

  @Get('/robots.txt')
  async robots(@Res() res: Response) {
    let base = '';
    try {
      const siteInfo = await this.metaProvider.getSiteInfo();
      base = washUrl(siteInfo?.baseUrl || '').replace(/\/+$/, '');
      // washUrl('') 会返回 'https://'（它给没有协议的字符串补 https://，而 new URL 抛错后原样返回），
      // 直接用就会写出 `Sitemap: https:///sitemap.xml` 这种垃圾行。
      // 必须确认是一个带 host 的绝对地址，否则宁可只留一条注释。
      if (!/^https?:\/\/[^/\s]/i.test(base)) {
        base = '';
      }
    } catch {
      base = '';
    }
    const lines = [
      '# 由 VanBlog 生成；后台「站点信息」里的站点 URL 决定下面的 Sitemap 地址',
      'User-agent: *',
      'Disallow: /api/',
      'Disallow: /admin/',
      'Disallow: /admin',
      'Disallow: /swagger',
      'Disallow: /swagger-json',
      'Disallow: /static/export/',
      'Disallow: /static/tmp/',
      'Disallow: /static/upload-tmp/',
      'Allow: /static/',
      '',
    ];
    if (base) {
      lines.push(`Sitemap: ${base}/sitemap.xml`);
    } else {
      lines.push('# Sitemap: 未配置站点 URL（后台「站点信息 → 网站 URL」），填好后这里会自动出现');
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    // robots.txt 会被爬虫高频请求，缓存一小时足够（改了站点 URL 最多一小时后生效）
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(lines.join('\n') + '\n');
  }
}
