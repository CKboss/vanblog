/**
 * 钉住 `spawnArchiveDecompressor` 的返回类型是 `ChildProcessWithoutNullStreams`。
 *
 * ## 为什么这是源码级断言而不是行为级（如实说明）
 * 这一处修的是**类型层面的信息丢失**，不是运行时缺陷：
 * `spawn` 有多个重载，`ReturnType<typeof spawn>` 取的是**最后一个（最泛的）**重载 ⇒ `ChildProcess`，
 * 其 `stdout`/`stderr`/`stdin` 都是 `Readable | null`。而该函数两处 `spawn(...)` **都不传 options**
 * ⇒ 实际命中 `SpawnOptionsWithoutStdio` 重载，返回 `ChildProcessWithoutNullStreams`（三个流都非空）。
 * 所以运行时**从来不会**是 null，行为级测试无法区分"收紧前"与"收紧后"。
 * 🔴 可观测的证据是 strictNullChecks 的命中数（本文件那 6 处 TS18047 全部消失，全仓 41 → 32），
 *   复跑命令见汇报；这里钉的是"注解不许漂回去"。
 *
 * ## 为什么不能改成在 6 个调用点撒 `?.`
 * `decErr += chunk.toString()` 是**解密失败诊断的唯一来源**（本文件多处注释强调"解密失败优先报"）。
 * 静默跳过它会把"口令错了 / 归档被截断"变成"解压器莫名退出"，在灾难恢复现场是最坏的结果。
 *
 * ⚠️ 断言"某文本不存在"前先剥注释（本仓库已踩 10 次"匹配到解释性注释"）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripCommentsForAnchor } from '../test-utils/anchorCode';

const SRC = stripCommentsForAnchor(
  fs.readFileSync(path.join(__dirname, 'fullBackup.ts'), 'utf8'),
);
const RAW = fs.readFileSync(path.join(__dirname, 'fullBackup.ts'), 'utf8');

describe('spawnArchiveDecompressor 的返回类型注解', () => {
  it('用 ChildProcessWithoutNullStreams（三个流非空 ⇒ 6 处解引用不再是可空）', () => {
    expect(SRC).toContain('child: ChildProcessWithoutNullStreams;');
  });

  it('🔴 不再用 ReturnType<typeof spawn>（那会丢失非空收窄）', () => {
    expect(SRC).not.toContain('ReturnType<typeof spawn>');
  });

  it('该类型确实从 child_process 导入（而不是碰巧同名）', () => {
    expect(SRC).toMatch(/import \{[^}]*ChildProcessWithoutNullStreams[^}]*\} from 'child_process';/);
  });

  it('⚠️ 剥注释器真的在工作：未剥注释的原文里**能**找到那个被禁的形状', () => {
    // 我的解释性注释里引用了 `ReturnType<typeof spawn>` 来说明"以前是什么"。
    // 如果剥注释失效，上一条 not.toContain 就会假红 —— 这条把两者的关系钉住。
    expect(RAW).toContain('ReturnType<typeof spawn>');
    expect(SRC).not.toContain('ReturnType<typeof spawn>');
  });

  it('尺子有效性反证：把注解改回去，上面两条必须同时失效', () => {
    // 模拟"漂移回旧注解"的源码，证明这两把尺子都量得到（不是恒真）。
    const drifted = SRC.replace(
      'child: ChildProcessWithoutNullStreams;',
      'child: ReturnType<typeof spawn>;',
    );
    expect(drifted).not.toContain('child: ChildProcessWithoutNullStreams;');
    expect(drifted).toContain('ReturnType<typeof spawn>');
    // ⚠️ 并且证明替换真的发生了（否则 drifted === SRC，两条断言都是空转）
    expect(drifted).not.toEqual(SRC);
  });

  it('两处 spawn 都不传 options（这是"非空流"这个不变量的前提）', () => {
    // 如果将来有人给 spawn 加 stdio 选项，ChildProcessWithoutNullStreams 就不再成立，
    // 而 TS 会在 return 处报错；这条把前提也钉住，让报错时能看懂原因。
    const spawnCalls = SRC.match(/spawn\(spec\.decompress\[0\][^;]*\)/g) || [];
    expect(spawnCalls.length).toBe(2);
    for (const call of spawnCalls) {
      expect(call).not.toMatch(/stdio/);
      expect(call).not.toMatch(/ChildProcess\b/);
    }
  });
});
