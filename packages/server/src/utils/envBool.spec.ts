import { envBool, parseBoolLike } from './envBool';

/**
 * env 里的布尔值：口径必须唯一。
 *
 * 为什么单独钉：仓库里同时存在 `=== 'true'`、`Boolean(env.X)`（写 `false` 反而是**开**）
 * 与 `checkTrue()` 三种口径。备份/恢复这几个开关是"写错了会删东西"的那一类，
 * 所以真/假/回落三张表都要写死在这里。
 */
describe('envBool', () => {
  it('缺失与空串 = fallback（默认行为不变）', () => {
    expect(envBool('X', true, {})).toBe(true);
    expect(envBool('X', false, {})).toBe(false);
    expect(envBool('X', true, { X: '' })).toBe(true);
    expect(envBool('X', false, { X: '   ' })).toBe(false);
  });

  it('真值表：1/true/yes/on（大小写与空白无关）', () => {
    for (const value of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', ' on ']) {
      expect(envBool('X', false, { X: value })).toBe(true);
    }
  });

  it('假值表：0/false/no/off —— 尤其 `false` 与 `0` 必须是关', () => {
    for (const value of ['0', 'false', 'FALSE', 'no', 'off', ' Off ']) {
      expect(envBool('X', true, { X: value })).toBe(false);
    }
  });

  it('认不出的值回落默认，绝不猜', () => {
    expect(envBool('X', true, { X: 'enabled' })).toBe(true);
    expect(envBool('X', false, { X: 'enabled' })).toBe(false);
    expect(envBool('X', true, { X: '2' })).toBe(true);
  });

  it('parseBoolLike 同口径，且直接吃布尔值（把开关传进纯函数时用）', () => {
    expect(parseBoolLike(undefined, true)).toBe(true);
    expect(parseBoolLike(null, false)).toBe(false);
    expect(parseBoolLike(true, false)).toBe(true);
    expect(parseBoolLike(false, true)).toBe(false);
    expect(parseBoolLike('off', true)).toBe(false);
    expect(parseBoolLike('on', false)).toBe(true);
    expect(parseBoolLike('maybe', true)).toBe(true);
  });
});
