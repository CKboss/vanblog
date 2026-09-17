import { BadRequestException, Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CommentProvider } from 'src/provider/comment/comment.provider';
import { SettingProvider } from 'src/provider/setting/setting.provider';
import { CreateCommentDto } from 'src/types/comment.dto';

/**
 * 内置评论的公开接口。
 *
 * ⚠️ 这里的每个入参都会进 Mongo 或被渲染到前台，所以：
 * - 所有字段在 provider 里都做过类型收敛与白名单校验（path 必须 `/` 开头且无 `..`、
 *   nick 去控制字符与尖括号、email 校验格式、site 只允许 http/https、content 长度与字符集受限）；
 * - 返回给前台的对象里**没有** ip / ua / email / reason（见 CommentProvider.toPublic）；
 * - 有蜜罐字段、每 IP 频率与每日上限、同内容去重，以及命中关键词/外链自动转待审。
 */
@ApiTags('comment')
@Controller('/api/public/comments')
export class PublicCommentController {
  constructor(
    private readonly commentProvider: CommentProvider,
    private readonly settingProvider: SettingProvider,
  ) {}

  /** 前台需要的评论配置（不含关键词等规则细节） */
  @Get('/setting')
  async getSetting() {
    return {
      statusCode: 200,
      data: await this.settingProvider.getPublicCommentSetting(),
    };
  }

  /** 批量取评论数，给列表页用（一次最多 50 个路径） */
  @Get('/counts')
  async getCounts(@Query('paths') paths?: string) {
    const list = String(paths ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (!list.length) {
      throw new BadRequestException('缺少 paths 参数');
    }
    return {
      statusCode: 200,
      data: await this.commentProvider.countByPaths(list),
    };
  }

  @Get('/')
  async list(@Query('path') path: string, @Query() query: any) {
    // page 上限 500（第四轮审计 B8）：pageSize ≤ 50 ⇒ 最深 skip ≈ 24,950 条根评论。
    // 前台按 20/页翻（500 页 = 1 万条根评论，远超任何真实文章的规模），
    // 而以前的 10,000 允许匿名构造 skip≈499,950 —— skip 的代价是 O(该路径的匹配文档数)
    // 而不是 O(page)，纯属白烧。500 之后一律当 500 处理（返回空页，与旧行为同形）。
    const page = Number(query?.page) > 0 ? Math.min(Number(query.page), 500) : 1;
    const pageSize = Number(query?.pageSize) > 0 ? Math.min(Number(query.pageSize), 50) : 20;
    const sort = String(query?.sort ?? '') === 'desc' ? 'desc' : 'asc';
    const data = await this.commentProvider.listByPath({
      path: String(path ?? ''),
      page,
      pageSize,
      sort,
    });
    return { statusCode: 200, data };
  }

  @Post('/')
  async create(@Body() body: CreateCommentDto, @Req() req: any) {
    const { comment, pending, reason } = await this.commentProvider.create(body || ({} as any), req);
    return {
      statusCode: 200,
      data: {
        comment,
        pending,
        message: pending ? '评论已提交，审核通过后显示' : '评论成功',
        // reason 只在待审时给一句人话，不暴露具体命中的关键词
        hint: pending && reason ? '内容需要人工审核' : undefined,
      },
    };
  }
}
