import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { promises as fs } from 'fs';
import { ThemeProvider, resolveThemeCssPath } from 'src/provider/theme/theme.provider';

/**
 * 前台取"当前该用哪个主题"的公开接口。
 *
 * 前台在 SSG/ISR 阶段调它，拿到 `uiStyle`（写进 `data-ui`）和上传主题的 CSS 地址
 * （挂 <link>）。切换主题后 server 会触发全量渲染，所以访客刷新一下就能看到新皮肤，
 * 不需要重新构建前台。
 */
@ApiTags('public')
@Controller('/api/public')
export class PublicThemeController {
  constructor(private readonly themeProvider: ThemeProvider) {}

  @Get('/theme')
  async theme() {
    const data = await this.themeProvider.getActive();
    return { statusCode: 200, data };
  }

  /**
   * 当前生效主题的 CSS。
   *
   * 为什么走接口而不是直接链 `/static/themes/<id>-<hash>.css`：
   * 前台是**静态生成**的，`<link>` 的 href 在构建/渲染时就写死进 HTML 了。如果 href 里带 hash，
   * 换一次主题就得把所有页面重新渲染一遍才能生效；而这里用一个**稳定地址**，
   * 靠 `ETag` + `Cache-Control: no-cache` 让浏览器每次廉价地协商一次（没变就是 304），
   * 于是"后台切主题 → 访客刷新页面"就能看到新皮肤，不依赖 ISR 有没有跑完。
   * 内置主题（default / apple）没有独立文件，返回 204 —— 它们的样式打包在前台产物里。
   */
  @Get('/theme.css')
  async themeCss(@Res() res: Response) {
    const { theme } = await this.themeProvider.getActive();
    res.setHeader('Cache-Control', 'no-cache');
    if (!theme || !theme.url) {
      res.status(204).end();
      return;
    }
    // ⚠️ 读侧的路径收敛（第四轮审计 B4）：theme.url 来自数据库，而恢复接口
    // （POST /api/admin/init/restore，走原生驱动、不经过 schema）能把任意值种进来。
    // 收敛不通过（`..` 逃逸 / 绝对路径 / themes/ 之外）一律按「没有这个主题文件」处理，
    // 回 204 —— 与「内置主题」完全同形（连 ETag 都不设），不新增可区分的响应。
    const abs = resolveThemeCssPath(theme.url);
    if (!abs) {
      res.status(204).end();
      return;
    }
    const etag = `W/"${theme.hash || 'unknown'}"`;
    res.setHeader('ETag', etag);
    if (res.req?.headers?.['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    try {
      const css = await fs.readFile(abs, 'utf8');
      res.type('text/css; charset=utf-8').send(css);
    } catch {
      // 元数据在、文件没了（被手工删掉之类）：给一个空样式表，别让页面因为 404 报错
      res.status(204).end();
    }
  }
}
