/**
 * 流水线事件 payload 的**密文脱敏**（G5）。
 *
 * 为什么单独钉一组：`beforeUpdateArticle` / `beforeUpdateDraft` 传的是客户端刚提交的 DTO，
 * 里面的 `password` 是用户在后台表单里敲的**明文**。它会流向三个出口，每一个都不该看到它：
 *  ① `PipelineProvider.logger.log(JSON.stringify(...))` —— 服务端日志（接了日志聚合器的
 *     部署里，读者远不止管理员）；
 *  ② `subProcess.send(...)` —— IPC 给用户自己写的流水线脚本；
 *  ③ `LogProvider.runPipeline(..., input)` —— **持久化进 logs 集合**，后台「日志管理」直接展示。
 *
 * 文章/分类访问密码哈希化之后这件事更要命：库里存的已经是 scrypt 哈希，日志反而成了明文
 * **唯一**还活着的地方 —— 一次专门为了消灭明文而做的迁移，最后把明文留在了日志表里。
 *
 * 覆盖：三个出口全部脱敏；`data` 入参**不被改动**（控制器还要拿原 DTO 去写库）；
 * 脚本改写 DTO 后密码意图由控制器侧的 `carryAccessSecretFields` 透传回来
 * （那半边的钉子见 controller/admin/article/article.controller.spec.ts）；
 * 嵌套对象/数组里的 password 也一并摘掉；事后事件（mongoose 文档）同样干净。
 *
 * 负控（已实测）：把 `runCodeByPipelineId` 里的 `safeData` 换回 `data`，
 * 下面三个出口的断言立刻红；把 `redactAccessSecretDeep` 改成原地 delete（而不是拷贝），
 * "不改动入参" 那条立刻红。
 */

// fork 必须 mock：真的 fork 会去 <codeRunner>/<id>.js 起子进程
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, fork: jest.fn() };
});

import { fork } from 'child_process';
import { PipelineProvider } from './pipeline.provider';
import { redactAccessSecretDeep } from 'src/utils/accessPassword';

const PLAIN = 'super-secret-plain-pw';

function createStack(pipelines: any[] = []) {
  const target = pipelines[0] || {
    id: 1,
    name: 'p1',
    eventName: 'beforeUpdateArticle',
    enabled: true,
    deleted: false,
    deps: [],
    script: '',
  };
  const model = {
    findOne: jest.fn(async () => target),
    find: jest.fn(async (query: any) =>
      query?.eventName ? [target] : pipelines.length ? pipelines : [],
    ),
  };
  const runPipeline = jest.fn();
  const provider = new PipelineProvider(model as any, { runPipeline } as any);

  // 捕获日志（成功与失败两条都要看）
  const logs: string[] = [];
  (provider as any).logger = {
    log: (m: any) => logs.push(String(m)),
    error: (m: any) => logs.push(String(m)),
    warn: (m: any) => logs.push(String(m)),
    info: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };

  // 捕获 IPC payload，并让脚本"回一个改写过的 DTO"
  const sent: any[] = [];
  let scriptOutput: any = { status: 'success', output: null, logs: [] };
  (fork as jest.Mock).mockImplementation(() => {
    const handlers: Record<string, (arg: any) => void> = {};
    const sub: any = {
      send: jest.fn((payload: any) => {
        sent.push(payload);
        return true;
      }),
      kill: jest.fn(),
      on: jest.fn((event: string, cb: any) => {
        handlers[event] = cb;
        return sub;
      }),
    };
    // 下一 tick 回消息，模拟脚本执行完
    setTimeout(() => handlers['message']?.(scriptOutput), 0);
    return sub;
  });

  return {
    provider,
    model,
    logs,
    sent,
    runPipeline,
    setScriptOutput: (output: any) => {
      scriptOutput = { status: 'success', output, logs: [] };
    },
  };
}

describe('PipelineProvider：事件 payload 不带访问密码', () => {
  beforeEach(() => {
    (fork as jest.Mock).mockClear();
  });

  it('三个出口（日志 / IPC / logs 集合）都拿不到明文，且入参 data 不被改动', async () => {
    const stack = createStack();
    const dto: any = {
      title: '文章标题',
      content: '正文',
      private: true,
      password: PLAIN,
    };
    const snapshot = JSON.parse(JSON.stringify(dto));

    const result = await stack.provider.runCodeByPipelineId(1, dto);
    expect(result.status).toBe('success');

    // ① 服务端日志：开始/成功两条都不得含明文
    expect(stack.logs.length).toBeGreaterThan(0);
    for (const line of stack.logs) {
      expect(line).not.toContain(PLAIN);
    }
    expect(stack.logs.join('\n')).toContain('文章标题'); // 其它字段照常记（没把日志一刀切掉）
    // 脱敏后 payload 里带的是布尔，脚本仍能判断"这次请求带没带密码"
    expect(stack.logs.join('\n')).toContain('"hasPassword": true');
    expect(stack.logs.join('\n')).not.toContain('"password"');

    // ② IPC 给脚本的 payload
    expect(stack.sent).toHaveLength(1);
    expect(JSON.stringify(stack.sent[0])).not.toContain(PLAIN);
    expect(stack.sent[0].password).toBeUndefined();
    expect(stack.sent[0].hasPassword).toBe(true);
    expect(stack.sent[0].title).toBe('文章标题');

    // ③ 持久化进 logs 集合的 input
    expect(stack.runPipeline).toHaveBeenCalledTimes(1);
    const persistedInput = stack.runPipeline.mock.calls[0][1];
    expect(JSON.stringify(persistedInput)).not.toContain(PLAIN);
    expect(persistedInput.hasPassword).toBe(true);

    // ⚠️ 入参绝不能被改：控制器后面还要拿这个 DTO 去 updateById()
    expect(dto).toStrictEqual(snapshot);
    expect(dto.password).toBe(PLAIN);
  });

  it('clearPassword 也一并摘掉（它同样是"用户在动密码"这件事的证据）', async () => {
    const stack = createStack();
    await stack.provider.runCodeByPipelineId(1, { title: 'x', clearPassword: true });
    expect(stack.sent[0].clearPassword).toBeUndefined();
    expect(JSON.stringify(stack.sent[0])).not.toContain('clearPassword');
  });

  it('空密码 ⇒ hasPassword: false（脚本能区分"没设密码"与"这次在改密码"）', async () => {
    const stack = createStack();
    await stack.provider.runCodeByPipelineId(1, { title: 'x', password: '' });
    expect(stack.sent[0].hasPassword).toBe(false);
    expect(stack.sent[0].password).toBeUndefined();
  });

  it('dispatchEvent("beforeUpdateArticle") 全链路同样干净（含 enabled 过滤）', async () => {
    const stack = createStack();
    await stack.provider.dispatchEvent('beforeUpdateArticle' as any, {
      title: 't',
      password: PLAIN,
    });
    expect(stack.sent).toHaveLength(1);
    expect(JSON.stringify(stack.sent)).not.toContain(PLAIN);
    expect(stack.logs.join('\n')).not.toContain(PLAIN);
    expect(JSON.stringify(stack.runPipeline.mock.calls)).not.toContain(PLAIN);
  });

  it('事后事件传 mongoose 文档时也干净（toJSON transform + 这里的脱敏，双保险）', async () => {
    const stack = createStack();
    const docLike: any = {
      title: '已存文档',
      password: 'scrypt$16384$8$1$aa==$bb==',
      toJSON() {
        return { title: this.title, hasPassword: true };
      },
    };
    await stack.provider.dispatchEvent('afterUpdateArticle' as any, docLike);
    expect(JSON.stringify(stack.sent[0])).not.toContain('scrypt$');
    expect(stack.sent[0].hasPassword).toBe(true);
    expect(stack.logs.join('\n')).not.toContain('scrypt$');
  });

  it('失败路径（脚本进程起不来）也不把明文写进日志与 logs 集合', async () => {
    const stack = createStack();
    (fork as jest.Mock).mockImplementationOnce(() => {
      const handlers: Record<string, (arg: any) => void> = {};
      const sub: any = {
        send: jest.fn(() => true),
        kill: jest.fn(),
        on: jest.fn((event: string, cb: any) => {
          handlers[event] = cb;
          return sub;
        }),
      };
      setTimeout(() => handlers['error']?.(new Error('脚本没了')), 0);
      return sub;
    });
    await expect(
      stack.provider.runCodeByPipelineId(1, { title: 'x', password: PLAIN }),
    ).rejects.toBeTruthy();
    expect(stack.logs.join('\n')).not.toContain(PLAIN);
    const persistedInput = stack.runPipeline.mock.calls[0][1];
    expect(JSON.stringify(persistedInput)).not.toContain(PLAIN);
  });

  it('嵌套形状（数组里的文章对象）也会被摘掉，且深拷贝不改原对象', () => {
    const nested: any = {
      articles: [
        { id: 1, password: PLAIN },
        { id: 2, password: '' },
      ],
      meta: { owner: { password: PLAIN } },
    };
    const out: any = redactAccessSecretDeep(nested);
    expect(JSON.stringify(out)).not.toContain(PLAIN);
    expect(out.articles[0].hasPassword).toBe(true);
    expect(out.articles[1].hasPassword).toBe(false);
    expect(out.meta.owner.hasPassword).toBe(true);
    // 原对象不动
    expect(nested.articles[0].password).toBe(PLAIN);
    expect(nested.meta.owner.password).toBe(PLAIN);
  });

  it('循环引用不会把进程栈打爆（截断而不是无限递归）', () => {
    const cyclic: any = { title: 'x', password: PLAIN };
    cyclic.self = cyclic;
    const out: any = redactAccessSecretDeep(cyclic);
    expect(JSON.stringify(out)).not.toContain(PLAIN);
    expect(out.title).toBe('x');
  });

  it('认不出的形状原样返回（宁可不脱敏，也别把事件本身打崩）', () => {
    expect(redactAccessSecretDeep(undefined)).toBeUndefined();
    expect(redactAccessSecretDeep(null)).toBeNull();
    expect(redactAccessSecretDeep('str')).toBe('str');
    expect(redactAccessSecretDeep(42)).toBe(42);
  });
});
