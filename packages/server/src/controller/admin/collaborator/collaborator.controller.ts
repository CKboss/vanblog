import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { config } from 'src/config';

import { AdminGuard } from 'src/provider/auth/auth.guard';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { ApiToken } from 'src/provider/swagger/token';
import { TokenProvider } from 'src/provider/token/token.provider';

import { UserProvider } from 'src/provider/user/user.provider';
import { Collaborator } from 'src/types/collaborator';

@ApiTags('collaborator')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/collaborator/')
export class CollaboratorController {
  constructor(
    private readonly userProvider: UserProvider,
    private readonly metaProvider: MetaProvider,
    private readonly tokenProvider: TokenProvider,
  ) {}
  @Get()
  async getAllCollaborators() {
    const data = await this.userProvider.getAllCollaborators();
    return {
      statusCode: 200,
      data: data || [],
    };
  }
  @Get('/list')
  async getAllCollaboratorsList() {
    // 管理员优先用作者名称吧
    const siteInfo = await this.metaProvider.getSiteInfo();
    const admin = await this.userProvider.getUser(true);
    if (!admin) {
      // 库里没有 id:0 的管理员。以前这里直接读 `admin.name` ⇒ TypeError ⇒ 500。
      // ⚠️ 不能"退而求其次只返回协作者"：这份清单的第一行**就是**管理员，
      //    少了它后台会显示成"这个站没有管理员"，那是比报错更糟的静默错误答案。
      throw new NotFoundException(
        '管理员账号不存在（库里没有 id=0 的用户），无法生成协作者清单。' +
          '这通常意味着数据被恢复成了一份损坏或空的备份：先跑 ./vanblog.sh doctor 看体检，' +
          '必要时用 ./vanblog.sh restore --offline-full <归档> 从一份好归档重建（数据库起不来时也能用）',
      );
    }
    const adminUser = {
      name: admin.name,
      // ⚠️ getSiteInfo() 在 metas 没有 siteInfo 时返回 undefined（它 `return raw`）⇒ 判空
      nickname: siteInfo?.author,
      id: 0,
    };
    const data = await this.userProvider.getAllCollaborators(true);
    return {
      statusCode: 200,
      // 以前这里写的是 `[adminUser, ...data] || [adminUser]`：数组字面量永远为真，
      // `|| [adminUser]` 是不可达的死代码（TS 5 的 TS2872 把它抓了出来）。
      // mongoose 的 find() 永远 resolve 成数组，没有协作者时就是 []，
      // 展开后自然得到 [adminUser] —— 原意图已经被覆盖，删掉死分支即可，行为不变。
      data: [adminUser, ...data],
    };
  }
  @Delete('/:id')
  async deleteCollaboratorById(@Param('id') id: number) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const data = await this.userProvider.deleteCollaborator(id);
    await this.tokenProvider.disableAllCollaborator();
    return {
      statusCode: 200,
      data,
    };
  }
  @Post()
  async createCollaborator(@Body() dto: Collaborator) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const data = await this.userProvider.createCollaborator(dto);
    return {
      statusCode: 200,
      data,
    };
  }
  @Put()
  async updateCollaborator(@Body() dto: Collaborator) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const data = await this.userProvider.updateCollaborator(dto);
    await this.tokenProvider.disableAllCollaborator();
    return {
      statusCode: 200,
      data,
    };
  }
}
