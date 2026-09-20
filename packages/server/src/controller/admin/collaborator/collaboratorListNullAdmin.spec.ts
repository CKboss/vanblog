import { NotFoundException } from '@nestjs/common';
import { CollaboratorController } from './collaborator.controller';

/**
 * `GET /api/admin/collaborator/list` 在"库里没有 id:0 管理员"时必须给 **404**，不是 500。
 *
 * 以前这里直接 `admin.name`，而 `getUser(true)` 是 `findOne({ id: 0 }, {…})` ⇒ 没有该文档时
 * 为 null ⇒ TypeError ⇒ 500。
 *
 * ⚠️ 关键取舍：**不能**"退而求其次只返回协作者"。这份清单的第一行**就是**管理员
 * （`data: [adminUser, ...collaborators]`），少了它后台会显示成"这个站没有管理员"——
 * 那是一个比报错更糟的**静默错误答案**：站长会以为账号没了，而不是数据坏了。
 */
function makeController(admin: any, siteInfo: any, collaborators: any[] = []) {
  const getUser = jest.fn(async () => admin);
  const getSiteInfo = jest.fn(async () => siteInfo);
  const getAllCollaborators = jest.fn(async () => collaborators);
  const controller = new CollaboratorController(
    { getUser, getAllCollaborators } as any,
    { getSiteInfo } as any,
    {} as any,
  );
  return { controller, getUser, getSiteInfo, getAllCollaborators };
}

describe('协作者清单：管理员缺失时的降级', () => {
  it('没有 id:0 的管理员 ⇒ 抛 404（不是 TypeError/500）', async () => {
    const { controller } = makeController(null, { author: '作者' });
    await expect(controller.getAllCollaboratorsList()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 的消息给出可照做的排障路径（doctor / restore --offline-full）', async () => {
    const { controller } = makeController(null, { author: '作者' });
    await expect(controller.getAllCollaboratorsList()).rejects.toThrow(
      /管理员账号不存在[\s\S]*doctor[\s\S]*offline-full/,
    );
  });

  it('⚠️ 不许退化成"只返回协作者"：管理员缺失时必须抛，而不是返回 200', async () => {
    const { controller, getAllCollaborators } = makeController(null, { author: '作者' }, [
      { id: 3, name: 'c1' },
    ]);
    await expect(controller.getAllCollaboratorsList()).rejects.toBeInstanceOf(NotFoundException);
    // 反证：如果实现改成"跳过管理员行"，上面那条会绿但这条会红——
    // 因为那种实现通常会先取协作者再判断，或者干脆不判断。
    expect(getAllCollaborators).not.toHaveBeenCalled();
  });

  it('siteInfo 缺失时**不崩**，管理员行的 nickname 为 undefined（既有语义：作者名可能没设）', async () => {
    const { controller } = makeController({ name: 'admin', nickname: 'N' }, undefined);
    const result = await controller.getAllCollaboratorsList();
    expect(result.statusCode).toBe(200);
    expect(result.data[0]).toEqual({ name: 'admin', nickname: undefined, id: 0 });
  });

  it('正常情况：管理员在第一行，协作者按原样跟在后面', async () => {
    const { controller } = makeController({ name: 'admin', nickname: 'N' }, { author: '作者名' }, [
      { id: 3, name: 'c1' },
      { id: 4, name: 'c2' },
    ]);
    const result = await controller.getAllCollaboratorsList();
    expect(result.data).toHaveLength(3);
    expect(result.data[0]).toEqual({ name: 'admin', nickname: '作者名', id: 0 });
  });

  it('没有协作者时仍然返回管理员一行（不是空数组）', async () => {
    const { controller } = makeController({ name: 'admin', nickname: 'N' }, { author: 'A' }, []);
    const result = await controller.getAllCollaboratorsList();
    expect(result.data).toEqual([{ name: 'admin', nickname: 'A', id: 0 }]);
  });
});
