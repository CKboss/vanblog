import { HttpException, NotAcceptableException } from '@nestjs/common';
import {
  SERVER_ERROR_CODES,
  ServerErrorCode,
  codedBody,
  codedError,
  fillServerErrorMessage,
} from './serverErrorCodes';

/**
 * 🔴 期 9（服务端错误码框架）第一批的行为钉子。
 *
 * 它守的是**三条同时成立**的约束（详见 `serverErrorCodes.ts` 的头注释）：
 *  1. `message` 仍是中文、且与迁移前**逐字相同**（日志/排障线索不变，钉住中文字面量的既有测试不用改）；
 *  2. 响应体**只多** `code`（与可选 `params`）—— 🔴 `error: 'Not Acceptable'` 这类 Nest 自己算出来的字段
 *     必须**原样保留**（手写 body 会把它弄丢，而那会让"按 error 字段分支"的调用方静默改变行为）；
 *  3. 异常类不变（`instanceof` 与状态码推导都不受影响）。
 */
describe('服务端错误码（serverErrorCodes）', () => {
  const codes = Object.keys(SERVER_ERROR_CODES) as ServerErrorCode[];

  it('反空转：登记表非空，且每条都有中文 zh 与异常类', () => {
    expect(codes.length).toBeGreaterThanOrEqual(8);
    for (const code of codes) {
      const e = (SERVER_ERROR_CODES as any)[code];
      expect(typeof e.zh).toBe('string');
      expect(e.zh.length).toBeGreaterThan(0);
      expect(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(e.zh)).toBe(true);
      expect(typeof e.Ctor).toBe('function');
    }
  });

  it('🔴 迁移后的响应体 = 迁移前的响应体 + code（逐字段对齐，message 逐字不变）', () => {
    // 迁移前这一处是：throw new NotAcceptableException('分类名重复，无法创建！')
    const before = new NotAcceptableException('分类名重复，无法创建！');
    const after = codedError('categoryDuplicateOnCreate');

    expect(after).toBeInstanceOf(NotAcceptableException);
    expect(after).toBeInstanceOf(HttpException);
    expect(after.getStatus()).toBe(before.getStatus());
    expect(after.getStatus()).toBe(406);

    const beforeBody = before.getResponse() as Record<string, unknown>;
    const afterBody = after.getResponse() as Record<string, unknown>;
    // 🔴 message 必须**逐字**相同（这是"日志与既有测试不用改"的全部依据）
    expect(afterBody.message).toBe('分类名重复，无法创建！');
    expect(afterBody.message).toBe(beforeBody.message);
    // 🔴 Nest 自己算出来的字段一个都不许丢
    expect(afterBody.error).toBe(beforeBody.error);
    expect(afterBody.error).toBe('Not Acceptable');
    expect(afterBody.statusCode).toBe(beforeBody.statusCode);
    // 🔴 唯一的多出来的东西就是 code
    expect(Object.keys(afterBody).sort()).toEqual([...Object.keys(beforeBody), 'code'].sort());
    expect(afterBody.code).toBe('categoryDuplicateOnCreate');
  });

  it('每个登记的码都能造出异常：状态码是数字、message 是中文、body 里的 code 与登记一致', () => {
    for (const code of codes) {
      const ex = codedError(code);
      expect(ex).toBeInstanceOf(HttpException);
      expect(typeof ex.getStatus()).toBe('number');
      const body = ex.getResponse() as Record<string, unknown>;
      expect(body.code).toBe(code);
      expect(typeof body.message).toBe('string');
      expect((body.message as string).length).toBeGreaterThan(0);
      // 🔴 未传 params 时 message 里不许残留占位符（那说明登记表里的 zh 写了 {x} 而调用点没传）
      expect(body.message).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
    }
  });

  it('🔴 未登记的码必须 fail-loud（不能静默造出一条 message=undefined 的响应）', () => {
    expect(() => codedError('thisCodeDoesNotExist' as ServerErrorCode)).toThrow(/unregistered server error code/);
    expect(() => codedBody('thisCodeDoesNotExist' as ServerErrorCode)).toThrow(/unregistered server error code/);
    // 报错里要点名那个码，否则排查时不知道是谁写错了
    expect(() => codedError('thisCodeDoesNotExist' as ServerErrorCode)).toThrow(/thisCodeDoesNotExist/);
  });

  it('fillServerErrorMessage：填已知的、保留未知的、没有 params 时原样返回', () => {
    expect(fillServerErrorMessage('请稍后 {n} 秒再试', { n: 30 })).toBe('请稍后 30 秒再试');
    // 🔴 未提供的占位符**原样留着**：日志里一眼能看出"这个参数没传"，空串会伪装成正常消息
    expect(fillServerErrorMessage('请稍后 {n} 秒再试', {})).toBe('请稍后 {n} 秒再试');
    expect(fillServerErrorMessage('请稍后 {n} 秒再试')).toBe('请稍后 {n} 秒再试');
    // 多个占位符与重复出现
    expect(fillServerErrorMessage('{a} 和 {b}，再来一个 {a}', { a: 1, b: 'x' })).toBe('1 和 x，再来一个 1');
    // 🔴 不许把原型链上的属性当参数（`{constructor}` 这类）
    expect(fillServerErrorMessage('{constructor}', {})).toBe('{constructor}');
  });

  it('codedBody：给 return 体那一族用（形状与 codedError 的 body 同源）', () => {
    const body = codedBody('categoryHasArticles');
    expect(body).toEqual({
      statusCode: 406,
      message: '分类已有文章，无法删除！',
      code: 'categoryHasArticles',
    });
    // 🔴 同一个码，codedBody 与 codedError 的 message/statusCode 必须一致（否则两处口径）
    const viaThrow = codedError('categoryHasArticles').getResponse() as Record<string, unknown>;
    expect(body.message).toBe(viaThrow.message);
    expect(body.statusCode).toBe(viaThrow.statusCode);
  });

  it('🔴 码名必须是合法的 i18n key 段（admin 侧的 key 就是 error.<code>）', () => {
    for (const code of codes) {
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(code.includes('.')).toBe(false);
      expect(code.length).toBeGreaterThan(2);
    }
  });
});
