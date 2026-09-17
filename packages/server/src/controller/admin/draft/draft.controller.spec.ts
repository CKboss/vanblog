/**
 * 「发布草稿」这条路上的访问密码透传（G5 的另一半）。
 *
 * `POST /api/admin/draft/publish?id=` 收的是 `PublishDraftDto`，它**有** `password`
 * （发布 = 新建文章，弹窗里可以直接设加密）。事件 payload 已经脱敏，脚本回不出密码，
 * 而控制器是 `publishDto = lastOutput` 整体替换的 —— 不透传就会静默丢掉用户填的密码。
 *
 * ⚠️ 三个透传点里只有这一个在 DraftController：`beforeUpdateDraft` 的两处
 * （POST /api/admin/draft、PUT /api/admin/draft/:id）传的是 Create/UpdateDraftDto，
 * 草稿 schema 根本没有 password 字段，没什么可透传的，所以**不加**（避免无意义的噪音）。
 */
import { DraftController } from './draft.controller';

function createStack(beforeOutput: any) {
  const draftProvider = {
    publish: jest.fn().mockResolvedValue({ id: 55, title: '发布出来的文章' }),
  };
  const isrProvider = { activeAll: jest.fn() };
  const pipelineProvider = {
    dispatchEvent: jest.fn(async (event: string) =>
      event === 'beforeUpdateArticle' && beforeOutput !== undefined
        ? [{ status: 'success', output: beforeOutput, logs: [] }]
        : [],
    ),
  };
  const controller = new DraftController(
    draftProvider as any,
    isrProvider as any,
    pipelineProvider as any,
  );
  return { controller, draftProvider, pipelineProvider };
}

describe('DraftController.publish：流水线改写 DTO 后仍保住密码意图', () => {
  it('脚本 output 没有 password ⇒ 用调用方填的那个（不会发一篇"忘了加密"的文章）', async () => {
    const stack = createStack({ title: '脚本改过的标题' });
    await stack.controller.publish(1 as any, {
      private: true,
      password: 'draft-pw',
      hidden: false,
    } as any);
    const dto = stack.draftProvider.publish.mock.calls[0][1];
    expect(dto.title).toBe('脚本改过的标题'); // 脚本改写仍然生效
    expect(dto.password).toBe('draft-pw'); // 密码意图透传回来
    // ⚠️ 只透传顶层的 password / clearPassword：其余字段一律以脚本 output 为准
    // （整体替换是既有语义，这次不动它），脚本没回 private 就没有 private。
    expect('private' in dto).toBe(false);
  });

  it('没有流水线 ⇒ DTO 原样交给 draftProvider.publish', async () => {
    const stack = createStack(undefined);
    await stack.controller.publish(1 as any, { password: 'draft-pw' } as any);
    expect(stack.draftProvider.publish.mock.calls[0][1].password).toBe('draft-pw');
  });

  it('脚本给了 clearPassword、调用方没填密码 ⇒ 清除照做（不覆盖脚本的意图）', async () => {
    const stack = createStack({ clearPassword: true });
    await stack.controller.publish(1 as any, { title: 't' } as any);
    const dto = stack.draftProvider.publish.mock.calls[0][1];
    expect(dto.clearPassword).toBe(true);
    expect('password' in dto).toBe(false);
  });
});
