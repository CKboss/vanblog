import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { HealthController } from './health.controller';
import { WebsiteProvider } from 'src/provider/website/website.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { SettingProvider } from 'src/provider/setting/setting.provider';

/**
 * 🔴 **`website` 字段的依赖注入必须真的能解析** —— 这条守卫补的是"14 条断言全绿却抓不到"的那个缺口。
 *
 * 缺陷（2026-09-22，在真实镜像里活体确证）：本控制器曾用**类型专用导入**引入 `WebsiteProvider`。
 * 类型导入在编译期被完全擦除 ⇒ **不提供任何运行时值给 Nest 的 DI**：Nest 靠发射的
 * `design:paramtypes` 元数据解析构造参数，擦除之后第二个参数退化成 `Function`，
 * Nest 无法把它当 provider token；又因为标了 `@Optional()`，于是**静默注入 `undefined`**
 * ⇒ `websiteState()` 走"拿不到 provider"那一支 ⇒ **`website` 字段恒为 `unknown`、状态码恒 200**。
 * 编译产物实证：`design:paramtypes` 是 `[Connection, Function]`，而 dist 里对
 * `website.provider` 的 require 次数是 **0**。
 *
 * 🔴 **为什么既有的 14 条断言全绿却抓不到**：它们全部是 `new HealthController(conn, websiteStub(true))`
 * —— **手工把 provider 喂进去，完全绕过了 Nest 的 DI**。而替身绕过的那一层，恰好就是唯一会坏的那一层。
 * 这是本仓库"替身钉住作者假设"那一族的第 8 次。
 *
 * 👉 所以本文件的核心手法是：**用真实的 Nest 容器解析出控制器实例**，让注入路径与生产完全一致。
 * `WebsiteProvider` 的构造器只依赖 `MetaProvider` 与 `SettingProvider`，且它**没有**
 * `onModuleInit`/`onModuleDestroy`/`onApplicationBootstrap` ⇒ **`compile()` 不会 spawn 任何子进程**，
 * 所以这条测试没有副作用，可以在 CI 里跑。
 *
 * ⚠️ 注意 `@Optional()` 的语义：token 解析不到时 `compile()` **不会抛错**，只是注入 `undefined`。
 * 所以判据必须落在"**注入到的值是什么**"与"**端点输出是什么**"上，而不是"compile 成功与否"。
 */

jest.mock('src/utils/clusterRole', () => ({
  isPrimaryInstance: jest.fn(() => true),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const clusterRole = require('src/utils/clusterRole') as { isPrimaryInstance: jest.Mock };

/** 连接正常的 mongo 替身：ping 立刻成功。 */
function okConn(): any {
  return {
    readyState: 1,
    db: { admin: () => ({ ping: () => Promise.resolve({ ok: 1 }) }) },
  };
}

function resStub(): any {
  return {
    statusCode: 200,
    status(n: number) {
      this.statusCode = n;
      return this;
    },
  };
}

/** 🔴 只暴露产品真正读的那个字段（`ctx`），不多给也不给错形状。 */
const WEBSITE_STUB = { ctx: { pid: 4242, kill: () => true } };

/**
 * 🔴 **用真实的 Nest 容器解析 `HealthController`** —— 这是本文件与既有 spec 的关键区别：
 * 注入路径与生产一致，所以"token 解析不到"会在这里暴露，而不会被手工替身掩盖。
 */
async function resolveThroughNest(): Promise<{
  controller: HealthController;
  injected: unknown;
}> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: getConnectionToken(), useValue: okConn() },
      // 🔴 `WebsiteProvider` 用**真类**当 token、替身当值：token 必须是真类，
      //    否则就测不出"控制器的元数据指向的是不是真类"这件事。
      { provide: WebsiteProvider, useValue: WEBSITE_STUB },
      { provide: MetaProvider, useValue: {} },
      { provide: SettingProvider, useValue: {} },
    ],
  }).compile();
  const controller = moduleRef.get(HealthController);
  // 读回 Nest 实际注入的那个参数（第二个构造参数）。
  const injected = (controller as any).website;
  return { controller, injected };
}

/** 剥掉注释与字符串，只留下真实代码 —— 判"代码里有没有某个形状"时必须剥，否则会被注释喂饱。 */
// 🔴 块注释的开/终止符用**相邻字符串拼接**构造：这两个字面量如果原样出现在本文件里，
//    "先剥块注释再剥行注释"的那类守卫会把它们当成真的块注释边界，从而吃掉后面的真实代码
//    （本仓库已实测踩过）。
const BLOCK_OPEN = ['/', '*'].join('');
const BLOCK_CLOSE = ['*', '/'].join('');

function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (two === BLOCK_OPEN) {
      // ⚠️ 终止符用拼接构造，避免本文件里出现那个字面量（块注释终止符写进源码会吃掉后面的真实代码）。
      const end = src.indexOf(BLOCK_CLOSE, i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const SRC_PATH = join(__dirname, 'health.controller.ts');

describe('health 的 website 字段：Nest 依赖注入必须真的能解析（不能靠手工替身绕过）', () => {
  beforeEach(() => {
    clusterRole.isPrimaryInstance.mockReturnValue(true);
    delete process.env.VANBLOG_DISABLE_WEBSITE;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-22T00:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.VANBLOG_DISABLE_WEBSITE;
    clusterRole.isPrimaryInstance.mockReturnValue(true);
  });

  it('🔴 真实 Nest 容器解析出的控制器，注入到的 provider 不是 undefined', async () => {
    const { injected } = await resolveThroughNest();
    // ⚠️ `@Optional()` 下 token 解析不到不会抛错，只会注入 undefined ⇒ 必须直接断言注入值。
    expect(injected).toBeDefined();
    expect(injected).toBe(WEBSITE_STUB);
  });

  it('🔴 经真实 DI 解析的控制器，前台在跑时 website=up（而不是 unknown）', async () => {
    const { controller } = await resolveThroughNest();
    const out: any = await controller.health({} as any, resStub());
    // 这一条是缺陷的**行为级**判据：类型专用导入时它会得到 unknown。
    expect(out.data.website).toBe('up');
    expect(out.data.status).toBe('ok');
    expect(out.statusCode ?? 200).not.toBe(503);
  });

  it('🔴 发射的 design:paramtypes 第二项是 WebsiteProvider 本身，而不是 Function/Object', () => {
    const types = Reflect.getMetadata('design:paramtypes', HealthController);
    // 反空转：元数据必须真的被发射出来，否则下面所有断言都恒真。
    expect(Array.isArray(types)).toBe(true);
    expect(types.length).toBe(2);
    expect(types[1]).toBe(WebsiteProvider);
    // 🔴 三个"坏形状"逐个排除：擦除后退化成 Function、宽化成 Object、或干脆缺失。
    expect(types[1]).not.toBe(Function);
    expect(types[1]).not.toBe(Object);
    expect(typeof types[1]).toBe('function');
    expect((types[1] as any).name).toBe('WebsiteProvider');
  });

  it('🔴 反证：省略第二个参数（= 注入失败时 Nest 的实际行为）会得到 unknown，所以旧那条 up 断言恒真', async () => {
    // 这条钉住"缺陷为什么能隐形"：注入失败是**静默**的，端点仍然 200、只是字段变 unknown。
    // 而既有 spec 用 `new HealthController(conn, websiteStub(true))` 手工喂替身 ⇒ 永远看不到这个状态。
    const c = new HealthController(okConn());
    const out: any = await c.health({} as any, resStub());
    expect(out.data.website).toBe('unknown');
    // 🔴 关键：注入失败时**状态码仍然是 200** ⇒ 容器 HEALTHCHECK 与 k8s 探针都看不出异常。
    expect(out.statusCode).toBe(200);
  });

  it('🔴 源码级：对 WebsiteProvider 的导入必须是值导入，不能是类型专用导入', () => {
    const raw = readFileSync(SRC_PATH, 'utf8');
    const code = stripCommentsAndStrings(raw);
    // 反空转：这个文件确实导入并使用了 WebsiteProvider。
    expect(code.split('WebsiteProvider').length - 1).toBeGreaterThan(1);
    // 🔴 坏形状用**相邻字符串拼接**构造，避免本文件自己含有那个字面量而被自己喂饱
    //    （守卫自己的源码也在它的语料里）。
    const badImport = 'import' + ' type { WebsiteProvider }';
    const goodImport = 'import { WebsiteProvider }';
    expect(code.includes(badImport)).toBe(false);
    expect(code.split(goodImport).length - 1).toBe(1);
  });

  it('🔴 尺子有效性：上一条断言对坏形状会红、对好形状不红（否则它可能恒真）', () => {
    const badImport = 'import' + ' type { WebsiteProvider }';
    const goodImport = 'import { WebsiteProvider }';
    const synth = (imp: string) =>
      stripCommentsAndStrings(`${imp} from 'src/provider/website/website.provider';\nexport class X { constructor(private readonly w?: WebsiteProvider) {} }\n`);
    const bad = synth(badImport);
    const good = synth(goodImport);
    // 坏形状必须被认出来
    expect(bad.includes(badImport)).toBe(true);
    expect(bad.split(goodImport).length - 1).toBe(0);
    // 好形状必须不被误报
    expect(good.includes(badImport)).toBe(false);
    expect(good.split(goodImport).length - 1).toBe(1);
    // 并且两者可区分（否则上面两条都是空的绿）
    expect(bad).not.toBe(good);
  });

  it('注释与字符串里出现同样字样不算命中（剥离器真的在工作）', () => {
    const badImport = 'import' + ' type { WebsiteProvider }';
    const stripped = stripCommentsAndStrings(
      `// ${badImport} 只是注释里提一下\nconst s = "${badImport}";\nimport { WebsiteProvider } from 'x';\n`,
    );
    expect(stripped.includes(badImport)).toBe(false);
    expect(stripped.split('import { WebsiteProvider }').length - 1).toBe(1);
  });
});
