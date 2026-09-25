import { Injectable } from '@nestjs/common';
// 🔴 期 9（服务端错误码框架）：消息的**权威中文**在 `src/utils/serverErrorCodes.ts` 的登记表里，这里只写码。
//    响应体仍是 Nest 的规范形状 + `code`（`message` 逐字不变），admin 有码用码、无码回落 message。
import { codedError } from 'src/utils/serverErrorCodes';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { assertSafeWriteFilter, isUsableFilterValue } from 'src/utils/queryFilter';
// 显式标注删除方法的返回类型：mongoose 内部用的是它自己那份 mongodb 驱动
// （.pnpm/mongodb@5.9.2），TS 5.9 在声明文件里无法可移植地引用那个深层路径（TS2742）。
// 用本包直接依赖的 mongodb 的 DeleteResult 标注 —— 两者结构完全相同，行为不变。
import type { DeleteResult } from 'mongodb';
import { CustomPage, CustomPageDocument } from 'src/scheme/customPage.schema';

@Injectable()
export class CustomPageProvider {
  constructor(
    @InjectModel('CustomPage')
    private customPageModal: Model<CustomPageDocument>,
  ) {}
  async createCustomPage(dto: CustomPage) {
    // ⚠️ 先校验 path 再查重。原因与 updateCustomPage 同源：`findOne({ path: undefined })` 会被
    //    Mongoose 丢掉那个条件、退化成 `findOne({})` ⇒ 匹配到集合里**任意一页**，于是"新建一个
    //    没填路径的页面"会得到一句莫名其妙的「已有此路由的自定义页面」（403），而真正的问题是
    //    请求里根本没有路径。后果比 update/delete 轻（它是**失败关闭**的：不会写坏数据，只是报错
    //    报错了地方），但同样属于"条件静默消失"这一族，一并修掉。
    if (!isUsableFilterValue(dto.path)) {
      throw codedError('customPageCreateNeedsPath');
    }
    const old = await this.customPageModal.findOne({ path: dto.path });
    if (old) {
      throw codedError('customPagePathDuplicate');
    }
    return await this.customPageModal.create(dto);
  }
  async updateCustomPage(dto: CustomPage) {
    const id = (dto as CustomPage & { _id?: unknown })._id;
    // 🔴 标识符校验必须在**任何**数据库操作之前。
    //
    // 缺陷（本仓库同族第四例）：body 既不带 `_id` 也不带 `path` 时，下面那行
    // `id ? { _id: id } : { path: dto.path }` 会得到 `{ path: undefined }`，而 Mongoose 会
    // **静默丢掉值为 undefined 的条件** ⇒ filter 退化成 `{}` ⇒ `updateOne({}, update)` 改写
    // 集合里自然顺序的**第一个**自定义页面，而 `update` 里装着请求方给的 html/name/type/path。
    // 自定义页面是**公开渲染的原始 HTML**，所以这是"一个不带任何标识符的请求静默篡改公开站点内容"。
    // 触发者需要已鉴权且有 customPage 写权限；⚠️ 但 `/api/admin/customPage` 不在
    // `SUPER_ADMIN_ONLY_ROUTE_PREFIXES` 里，而自定义页面明确属于「所有权限」协作者**仍可**的一类
    // ⇒ 在"低权限协作者按已攻陷设计"的威胁模型下这是可达的。
    //
    // 可达形状不是理论上的：后台 `pages/Code/index.tsx` 的 `currObj` 初值是 `{}`，取数据失败
    // （例如页面已被删）后按 Ctrl+S 就会发出 `{ html }` —— 修复前那会静默改掉另一页，修复后是
    // 一条能照做的 400。
    const hasId = isUsableFilterValue(id);
    const hasPath = isUsableFilterValue(dto.path);
    if (!hasId && !hasPath) {
      throw codedError('customPageUpdateNeedsTarget');
    }
    const update: Partial<CustomPage> = { updatedAt: new Date() };
    if (dto.name != null) {
      update.name = dto.name;
    }
    if (dto.path != null) {
      update.path = dto.path;
    }
    if (dto.type != null) {
      update.type = dto.type;
    }
    if (dto.html != null) {
      update.html = dto.html;
    }

    if (hasId && hasPath) {
      const conflict = await this.customPageModal.findOne({ path: dto.path });
      if (conflict && String(conflict._id) !== String(id)) {
        throw codedError('customPagePathDuplicate');
      }
    }

    // 修改信息 may change path; look up by _id so the write still hits the row.
    // HTML-only saves from the editor also send _id. Path is a fallback.
    // ⚠️ 显式两分支 + 落库前的 assertSafeWriteFilter：后者是防"将来有人加第三个分支时忘记校验"，
    //    它保证无论如何都不会拿着空条件或含 undefined 的条件去写库（那种情况抛 500，因为那是代码缺陷）。
    const filter: Record<string, unknown> = hasId ? { _id: id } : { path: dto.path };
    assertSafeWriteFilter(filter, 'CustomPageProvider.updateCustomPage');
    return await this.customPageModal.updateOne(filter, update);
  }
  async getCustomPageByPath(path: string) {
    // 读侧**失败关闭**：path 不可用时直接返回 null（对外表现是 404），而不是让
    // `findOne({ path: undefined })` 退化成 `findOne({})` 返回**任意一页**。
    // ⚠️ 这一条不只是"读错数据"：`customPage.controller.ts` 的 DELETE 会先调它，
    //    并在返回的是 folder 类型时**连带删掉磁盘上的整个目录**（`staticProvider.deleteCustomPage`）。
    //    所以这里返回任意一页 = 可能删掉一个无辜页面的目录。
    // 选择返回 null 而不是抛 400：这个方法也被公开渲染路径（`/c/*`）调用，那里"查不到"就是 404，
    // 抛异常会把一个正常的"页面不存在"变成 500/400 噪音。
    if (!isUsableFilterValue(path)) {
      return null;
    }
    return await this.customPageModal.findOne({ path });
  }
  async getAll() {
    return await this.customPageModal.find({}, { html: 0 });
  }
  async deleteByPath(path: string): Promise<DeleteResult> {
    // 🔴 同族第四例，而且是**破坏性**的那一个：`DELETE /api/admin/customPage`（不带 `path` query）
    //    会让 `deleteOne({ path: undefined })` 退化成 `deleteOne({})` ⇒ 删掉集合里自然顺序的
    //    第一个自定义页面。静态分析最初只点出了 updateCustomPage 一处写侧，这一处是复核时发现的。
    if (!isUsableFilterValue(path)) {
      throw codedError('customPageDeleteNeedsPath');
    }
    const filter: Record<string, unknown> = { path };
    assertSafeWriteFilter(filter, 'CustomPageProvider.deleteByPath');
    return await this.customPageModal.deleteOne(filter);
  }
}
