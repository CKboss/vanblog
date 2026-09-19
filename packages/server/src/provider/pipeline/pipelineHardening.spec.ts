/**
 * 流水线加固的回归钉子：依赖名收口 + `getPathById` 的运行时校验与容器化。
 *
 * 背景（两条都是**加固**，不是可达漏洞）：
 * 1. `addDeps` 原来的字符集 `^[a-zA-Z0-9@/._^~>-]*$` 是**故意**宽松的 —— scoped 包
 *    `@scope/pkg` 与版本范围 `pkg@^1.2.3` 都要靠 `/ . ^ ~`。代价是 `../../../x` 这种本地路径
 *    也能通过，于是 pnpm 会从容器内任意路径安装而不是 registry。管理员才能触发（而管理员本来
 *    就能通过流水线跑任意代码），所以不是权限跨越，但"能从镜像里任意目录装代码"该收掉。
 * 2. `getPathById(id)` 以前是裸模板串 `${runnerPath}/${id}.js`。TS 的 `id: number` **不做运行时
 *    保证**，而它的值可能来自路由参数、数据库文档或内部调用方（fork / 写盘 / 删除三处）。
 *    HTTP 入口已有 `parsePipelineId`（`^-?\d+$` + `Number.isSafeInteger`）兜着，所以今天不存在
 *    可达的任意写；这层是给"将来新增一个不走那个 helper 的调用方"准备的。
 */
import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inspectDepSpec, resolvePipelineFilePath } from './pipeline.provider';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

const SRC = stripCommentsForAnchor(fs.readFileSync(path.join(__dirname, 'pipeline.provider.ts'), 'utf-8'));

describe('inspectDepSpec：合法的 npm 安装形状必须全部放行', () => {
  const LEGAL = [
    'pkg',
    'lodash.merge',
    'pkg@1.2.3',
    'pkg@^1.2.3',
    'pkg@~1.2',
    'pkg@1.x',
    'pkg@>=1 <2',
    '@scope/pkg',
    '@scope/pkg@1.2.3',
    '@scope/pkg@^1.2.3',
    // 有意保留：GitHub 简写与"runner 目录内的相对路径"都在管理员既有权力范围内
    // （他本来就能通过流水线执行任意代码），拦掉只会弄坏合法工作流。
    'user/repo',
    './local-dep',
  ];
  it.each(LEGAL)('%s 通过', (dep) => {
    expect(inspectDepSpec(dep)).toBeNull();
  });
});

describe('inspectDepSpec：本地路径与工作区协议必须被拒', () => {
  const ILLEGAL: [string, string][] = [
    ['/etc/passwd', '以 / 开头'],
    ['/app/packages/server', '以 / 开头'],
    ['../x', '.. 路径段'],
    ['../../x', '.. 路径段'],
    ['a/../../b', '.. 路径段'],
    ['@scope/../../x', '.. 路径段'],
    ['file:../evil', 'file: 协议'],
    ['pkg@file:/app/evil', 'file: 协议（版本位）'],
    ['link:../x', 'link: 协议'],
    ['workspace:*', 'workspace: 协议'],
    ['pkg@workspace:../x', 'workspace: 协议（版本位）'],
    ['', '空值'],
  ];
  it.each(ILLEGAL)('%s 被拒（%s）', (dep) => {
    expect(typeof inspectDepSpec(dep)).toBe('string');
  });

  it('⚠️ 不误伤 scoped 包：`@file/x` 这种 scope 名里带 file 的仍然放行', () => {
    // 协议判定锚在 `@` 之后紧跟 `file:`，所以 scope 名里出现 file 字样不会命中
    expect(inspectDepSpec('@file/utils')).toBeNull();
    expect(inspectDepSpec('@file/utils@^1.0.0')).toBeNull();
  });

  it('非字符串一律拒（不抛异常）', () => {
    for (const v of [null, undefined, 123, {}, [], Symbol('x') as unknown]) {
      expect(typeof inspectDepSpec(v as unknown as string)).toBe('string');
    }
  });
});

describe('resolvePipelineFilePath：只接受安全整数，且结果必须在 runnerPath 内', () => {
  const root = path.join(os.tmpdir(), 'pipeline-runner-spec');

  it('整数与整数字符串都解析成 <root>/<id>.js', () => {
    expect(resolvePipelineFilePath(root, 5)).toBe(path.join(root, '5.js'));
    expect(resolvePipelineFilePath(root, '5')).toBe(path.join(root, '5.js'));
    expect(resolvePipelineFilePath(root, '  7  ')).toBe(path.join(root, '7.js'));
  });

  it('负数与 0 仍然接受（与 controller 的 parsePipelineId 口径一致：^-?\\d+$）', () => {
    expect(resolvePipelineFilePath(root, -1)).toBe(path.join(root, '-1.js'));
    expect(resolvePipelineFilePath(root, 0)).toBe(path.join(root, '0.js'));
  });

  it.each([
    ['../../etc/passwd'],
    ['..%2f..%2fevil'],
    ['1.5'],
    ['NaN'],
    [''],
    ['   '],
    [NaN],
    [Infinity],
    [1.5],
    [2 ** 53],
    [{}],
    [[]],
    [null],
    [undefined],
    [() => 1],
  ])('非法 id %p 抛 BadRequestException（不是静默拼出一个怪路径）', (id) => {
    expect(() => resolvePipelineFilePath(root, id as unknown)).toThrow(BadRequestException);
  });

  it('结果一定落在 runnerPath 内（容器化校验不是装饰）', () => {
    for (const id of [1, 42, -3, '99']) {
      const abs = resolvePipelineFilePath(root, id as unknown);
      const rel = path.relative(path.resolve(root), abs);
      expect(rel.startsWith('..')).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
      expect(abs.endsWith('.js')).toBe(true);
    }
  });

  it('runnerPath 是相对路径时也会被解析成绝对路径（不留"取决于 cwd"的坑）', () => {
    const abs = resolvePipelineFilePath('relative/runner', 3);
    expect(path.isAbsolute(abs)).toBe(true);
    expect(abs.endsWith(path.join('relative', 'runner', '3.js'))).toBe(true);
  });
});

describe('源码锚点：调用形状必须对（只看符号出现是空断言，import 行就能骗过）', () => {
  it('addDeps 在 spawn pnpm 之前真的调用了 inspectDepSpec(dep)', () => {
    const body = SRC.slice(SRC.indexOf('async addDeps('));
    const callAt = body.search(/inspectDepSpec\(\s*dep\s*\)/);
    const spawnAt = body.search(/spawn\(\s*'pnpm'/);
    expect(callAt).toBeGreaterThan(-1);
    expect(spawnAt).toBeGreaterThan(-1);
    // ⚠️ 顺序也是契约：校验必须发生在 spawn 之前，否则就是先装再判
    expect(callAt).toBeLessThan(spawnAt);
  });

  it('getPathById 走 resolvePipelineFilePath，不再自己拼字符串', () => {
    const body = SRC.slice(SRC.indexOf('getPathById('));
    expect(body.slice(0, 200)).toMatch(/resolvePipelineFilePath\(\s*this\.runnerPath\s*,\s*id\s*\)/);
  });

  it('反证：旧的裸拼接形状不许回来', () => {
    // 旧代码是 return `${this.runnerPath}/${id}.js`;
    const oldShape = /return\s*`\$\{this\.runnerPath\}\/\$\{id\}\.js`/;
    // 空转反证：同一把尺子量旧形状必须命中，否则这条断言永远不可能红
    expect(oldShape.test('return `${this.runnerPath}/${id}.js`;')).toBe(true);
    expect(oldShape.test(SRC)).toBe(false);
  });

  it('反证：addDeps 里"跳过不安全"的分支必须存在（否则 inspectDepSpec 就是摆设）', () => {
    const body = SRC.slice(SRC.indexOf('async addDeps('));
    expect(body).toMatch(/const\s+unsafeReason\s*=\s*inspectDepSpec\(dep\)/);
    expect(body).toMatch(/if\s*\(\s*unsafeReason\s*\)/);
    expect(body).toMatch(/continue;/);
  });
});
