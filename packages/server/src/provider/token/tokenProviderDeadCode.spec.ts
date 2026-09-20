import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * `disableAPIToken(token)` 与 `disableAPITokenByName(name)` 已被删除 —— 这条守卫防止它们回来。
 *
 * 为什么"零调用方的死代码"值得一条守卫：它们的形状是
 * `updateOne({ token }, { disabled: true })` / `updateOne({ name }, …)`，**没有 undefined 校验**。
 * Mongoose 会**丢弃值为 `undefined` 的查询条件**，于是 `disableAPIToken(undefined)` 退化成
 * `updateOne({}, { disabled: true })` = **吊销任意一条 token**。
 *
 * 这与本仓库已经出过事的两个缺陷完全同族：
 *  - `checkToken` 在 header 缺失时退化成"匹配任意未吊销记录"（已修）；
 *  - `updateCollaborator` 在 name 缺失时退化成"改掉任意一个协作者"（已修）；
 *  - 更早还有 `token != keyInCache` 的 `"[object Object]" != {}` ⇒ 未认证管理员接管（已修）。
 * 死代码不会被测试覆盖、也不会在评审里被想起，但它等着某个人接上去。
 */

const TOKEN_PROVIDER = readFileSync(
  resolve(__dirname, 'token.provider.ts'),
  'utf8',
);
const CODE = stripCommentsForAnchor(TOKEN_PROVIDER);

describe('按值吊销的两个死方法不许回来', () => {
  it('剥注释后源码里不存在这两个方法的定义或调用', () => {
    expect(CODE).not.toMatch(/disableAPIToken\s*\(/);
    expect(CODE).not.toMatch(/disableAPITokenByName\s*\(/);
  });

  it('空转反证：旧形状必须能被上面那条判据抓到（否则守卫是装饰）', () => {
    const oldShape = `
      async disableAPIToken(token: string) {
        return await this.tokenModel.updateOne({ token }, { disabled: true });
      }
      async disableAPITokenByName(name: string) {
        return await this.tokenModel.updateOne({ name }, { disabled: true });
      }
    `;
    expect(stripCommentsForAnchor(oldShape)).toMatch(/disableAPIToken\s*\(/);
    expect(stripCommentsForAnchor(oldShape)).toMatch(/disableAPITokenByName\s*\(/);
    // 而解释"为什么删掉"的注释**不能**触发上面那条断言 —— 那正是本仓库踩过 8 次的坑
    expect(CODE).not.toMatch(/disableAPIToken\s*\(/);
    expect(TOKEN_PROVIDER).toContain('disableAPIToken'); // 注释里确实提到了它（所以必须剥注释）
  });

  it('按 _id 吊销仍然在（那是唯一在用的入口，删错了会弄坏后台 Token 管理）', () => {
    expect(CODE).toMatch(/async\s+disableAPITokenById\s*\(/);
    // 且它的条件带 `_id`，不是可被 undefined 掏空的形状
    expect(CODE).toMatch(/updateOne\(\s*\{\s*_id:\s*id\s*\}/);
  });

  it('同族的 `checkToken` 前置校验仍在（undefined 条件不能被 Mongoose 丢掉）', () => {
    expect(CODE).toMatch(/typeof\s+token\s*!==\s*'string'/);
    // 校验必须在 findOne **之前**
    const idxCheck = CODE.indexOf("typeof token !== 'string'");
    const idxQuery = CODE.indexOf('findOne({ token, disabled: false })');
    expect(idxCheck).toBeGreaterThan(-1);
    expect(idxQuery).toBeGreaterThan(-1);
    expect(idxCheck).toBeLessThan(idxQuery);
  });

  it('`disableAll` 的吊销范围仍然覆盖 API Token（userId=666666 落在 $ne:0 里）', () => {
    // 改口令 / 走恢复流程依赖这个行为：旧的长期凭证必须一起失效
    expect(CODE).toMatch(/updateMany\(\s*\{\s*disabled:\s*false\s*\}\s*,\s*\{\s*disabled:\s*true\s*\}/);
  });
});
