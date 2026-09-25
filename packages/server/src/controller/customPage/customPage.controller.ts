import { Controller, Get, Param, Req, Res } from '@nestjs/common';
// 🔴 期 9（服务端错误码框架）：消息的**权威中文**在 `src/utils/serverErrorCodes.ts` 的登记表里，这里只写码。
//    响应体仍是 Nest 的规范形状 + `code`（`message` 逐字不变），admin 有码用码、无码回落 message。
import { codedError } from 'src/utils/serverErrorCodes';
import { ApiTags } from '@nestjs/swagger';
import { Response, Request } from 'express';
import { CustomPageProvider } from 'src/provider/customPage/customPage.provider';
import { resolvePublicCustomPageRequest } from 'src/utils/customPagePath';

/**
 * 302 的目标必须是**同源相对路径**，否则返回 null（调用方按 404 处理）。
 *
 * ⚠️ 澄清一个流传的错误说法：`resolvePublicCustomPageRequest()` 给出的 `location` **不是数据库字段**，
 * 而是 `${pathname}/${search}` —— 由 **`req.url` 派生**（`utils/customPagePath.ts`，作用只是"目录访问
 * 补一个尾斜杠"）。所以它不是"管理员可写的开放重定向"。
 *
 * 但它毕竟来自请求行，而请求行是可以长得奇怪的：**`//host/path` 是协议相对 URL**，浏览器会跳到
 * 别的域；`/\host/path` 在部分浏览器里被当成同一种东西；CR/LF 则是响应头注入的经典形状。
 * 正常路径（`/c/xxx/`）一条都不会被这里挡掉，所以这是一层纯加固：
 * 只放行"恰好一个 `/` 开头、不含反斜杠、不含 CR/LF"的相对路径。
 */
export function assertSameOriginRedirect(location: string): string | null {
  const v = String(location ?? '');
  if (!v.startsWith('/')) return null; // 必须是相对路径
  if (v.startsWith('//')) return null; // 协议相对 URL ⇒ 会跳到别的域
  if (v.includes('\\')) return null; // 部分浏览器把 /\host 当成 //host
  if (/[\r\n\0]/.test(v)) return null; // 响应头注入
  return v;
}

@ApiTags('c')
@Controller('c')
export class PublicCustomPageController {
  constructor(private readonly customPageProvider: CustomPageProvider) {}
  @Get('/:pathname*')
  async getPageContent(
    @Param('pathname') pathname: string,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    const foldername = pathname;
    if (!foldername) {
      res.status(404);
      throw codedError('customPageNotFound');
    }
    const cur = await this.customPageProvider.getCustomPageByPath(`/${foldername}`);
    if (!cur) {
      res.status(404);
      throw codedError('customPageNotFound');
    }
    if (cur.type == 'file' && !cur.html) {
      res.status(404);
      throw codedError('customPageNotFound');
    } else if (cur.type == 'file' && cur.html) {
      res.status(200);
      res.send(cur.html);
      return;
    } else if (cur.type == 'folder') {
      const target = resolvePublicCustomPageRequest(req.url);
      if (target.kind === 'redirect') {
        // 见 assertSameOriginRedirect：目标由 req.url 派生，正常只是补尾斜杠，
        // 但既然来自请求行就在这里再收一次口（协议相对 / 反斜杠 / CRLF 一律当没这个页面）。
        const location = assertSameOriginRedirect(target.location);
        if (!location) {
          res.status(404);
          throw codedError('customPageNotFound');
        }
        res.redirect(302, location);
        return;
      }
      if (target.kind === 'missing') {
        res.status(404);
        throw codedError('customPageNotFound');
      }
      res.sendFile(target.absPath);
      return;
    }
    res.status(404);
    throw codedError('customPageNotFound');
  }
}

@Controller('custom')
export class PublicOldCustomPageRedirectController {
  @Get('/:pathname*')
  async redirect(@Res() res: Response, @Req() req: Request) {
    const newUrl = req.url.replace('/custom/', '/c/');
    res.redirect(301, newUrl);
    return;
  }
}
