import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { checkTrue } from './checkTrue';
import { isTrue } from './isTrue';

/**
 * 布尔口径的**唯一输入表**。
 *
 * 为什么值得一张表：本仓库曾经并存五套布尔解析，其中 `checkTrue()` 与 `isTrue()` 在
 * `"1"` / `1` / `[1]` 三个输入上**结果相反**（`checkTrue` 用 `s == true` 松散比较：
 * `"1" == true` ⇒ `Number("1") == Number(true)` ⇒ `1 == 1` ⇒ true）。而 `checkTrue` 正是
 * **破坏性整站恢复的确认闸门**用的那个 ⇒ 确认闸门当时是全仓库最松的布尔判定。
 *
 * 这张表把口径钉死：谁改了两个助手中的任何一个，或者又派生了第六套，这里就会红。
 * ⚠️ 表里每一行都是**行为级**断言（真调函数），不是"源码里出现了某个词"。
 */

/** [输入, 期望] —— 期望值就是"严格口径"的定义：只有 boolean true 与字符串 'true' 为真。 */
const TABLE: ReadonlyArray<readonly [unknown, boolean]> = [
  [true, true],
  ['true', true],
  // ⚠️ 大小写敏感是**有意**的：这个函数同时服务破坏性操作的确认闸门，
  //    闸门只应当接受一种拼写（详见 isTrue.ts 的注释）。
  ['TRUE', false],
  ['True', false],
  [1, false],
  ['1', false],
  [[1], false],
  ['yes', false],
  ['on', false],
  ['', false],
  ['  true  ', false],
  [undefined, false],
  [null, false],
  ['false', false],
  [false, false],
  [0, false],
  [{}, false],
  ['true\n', false],
];

describe('布尔口径：isTrue 与 checkTrue 必须逐项符合输入表', () => {
  it.each(TABLE)('isTrue(%p) === %p', (input, expected) => {
    expect(isTrue(input)).toBe(expected);
  });

  it.each(TABLE)('checkTrue(%p) === %p（委托后语义必须与 isTrue 完全一致）', (input, expected) => {
    expect(checkTrue(input)).toBe(expected);
  });

  it('两个助手在整张表上**逐行相同**（防止其中一个被单独改回松散比较）', () => {
    const disagreements = TABLE.filter(([input]) => isTrue(input) !== checkTrue(input)).map(
      ([input]) => input,
    );
    expect({ disagreements }).toEqual({ disagreements: [] });
  });

  it('表本身有效：至少有两行为真、至少十行为假（否则"全 false"也能让上面全绿）', () => {
    // ⚠️ 尺子有效性反证：如果表被写坏成"全是 false"，上面那些 it.each 依然会全绿，
    //    而那样就测不出"true 与 'true' 必须为真"这半边。这条断言把表的形状钉住。
    const trues = TABLE.filter(([, expected]) => expected).length;
    const falses = TABLE.length - trues;
    expect(trues).toBe(2);
    expect(falses).toBeGreaterThanOrEqual(10);
  });

  it('负向对照：把期望值改错时，逐行断言必须能抓到', () => {
    // 证明"尺子"不是恒真：故意用一张错表跑同一个判据，必须有行不匹配。
    const wrongTable: ReadonlyArray<readonly [unknown, boolean]> = [
      ['1', true], // 旧的松散语义
      [1, true],
      [[1], true],
      ['TRUE', true],
    ];
    const mismatched = wrongTable.filter(([input, expected]) => isTrue(input) !== expected);
    expect(mismatched.length).toBe(wrongTable.length);
  });
});

describe('checkTrue 不许再自己实现一套松散比较', () => {
  const SRC = stripCommentsForAnchor(readFileSync(resolve(__dirname, 'checkTrue.ts'), 'utf-8'));

  it('委托给 isTrue，而不是自带判定', () => {
    expect(SRC).toMatch(/export const checkTrue = \(s: unknown\): boolean => isTrue\(s\);/);
  });

  it('源码里不再有 `== true` 这类松散比较（剥注释后断言）', () => {
    expect(SRC).not.toMatch(/==\s*true/);
    expect(SRC).not.toMatch(/==\s*'true'/);
    // 空转反证：同一把尺子在**未剥注释**的原文上必须能命中——注释里必然引用了旧写法，
    // 否则说明这把尺子量不到东西（本仓库已踩 8 次"断言匹配到解释性注释"）。
    const raw = readFileSync(resolve(__dirname, 'checkTrue.ts'), 'utf-8');
    expect(raw).toMatch(/==\s*true/);
  });

  it('isTrue 内部也全部是严格比较', () => {
    const src = stripCommentsForAnchor(readFileSync(resolve(__dirname, 'isTrue.ts'), 'utf-8'));
    expect(src).not.toMatch(/[^=!<>]==[^=]/);
    expect(src).toMatch(/typeof v === 'boolean'/);
    expect(src).toMatch(/v === 'true'/);
  });
});

describe('envBool 的注释不许再把 checkTrue 的口径说错', () => {
  it('注释里明确写了 checkTrue 曾经把 "1" 判成真（那句"只认 true/\'true\'"是错的）', () => {
    const raw = readFileSync(resolve(__dirname, 'envBool.ts'), 'utf-8');
    // ⚠️ 这条**故意**断言在原文（含注释）上：被检查的对象就是注释本身。
    expect(raw).toContain('曾经');
    expect(raw).toMatch(/checkTrue[\s\S]{0,200}松散比较/);
    // 负向对照：那句错话不许原样回来
    expect(raw).not.toContain('`checkTrue()`（只认 `true`/`\'true\'）');
  });

  it('envBool 与 isTrue 的口径**有意不同**，且注释写清了为什么', () => {
    const raw = readFileSync(resolve(__dirname, 'envBool.ts'), 'utf-8');
    expect(raw).toContain('口径不同且是有意不同');
    // env 口径确实更宽（这是它该有的样子，别被"统一口径"顺手改掉）
    expect(raw).toContain("ENV_TRUE_VALUES = ['1', 'true', 'yes', 'on']");
  });
});
