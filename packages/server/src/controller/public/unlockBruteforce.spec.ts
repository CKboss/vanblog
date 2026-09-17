import * as fs from 'fs';
import * as path from 'path';

/**
 * 加密文章解锁接口的限流 key 必须按**归一化后的 id** 计数。
 *
 * 漏洞（活体证明过）：路由参数是原始字符串，而下游用 `parseNumericId`(= `Number(id)`) 解析，
 * 同一个整数有无穷多种写法 ⇒ 每种写法都是一个全新的 20 次/10 分钟预算。
 * 实测把 `7` 打到 429 之后，`07`/`007`/`7.0`/`0x7`/`7e0`/`0b111`/`0o7`/`%207`/`0000000007`
 * 各自都能再试 20 次，且用 `0000000000007` + 正确密码能拿到完整正文。
 */
describe('加密文章解锁的限流 key', () => {
  const repoRoot = path.resolve(__dirname, '../../../../..');
  const src = fs
    .readFileSync(path.join(repoRoot, 'packages/server/src/controller/public/public.controller.ts'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

  it('key 由 tryParseNumericId 归一化，而不是直接拼原始参数', () => {
    expect(src).toContain("import { tryParseNumericId } from 'src/utils/numericId'");
    expect(src).toMatch(/const numericId = tryParseNumericId\(rawId\);/);
    expect(src).toMatch(/numericId !== null \? `#\$\{numericId\}` : `p:\$\{rawId\.slice\(0, 80\)\}`/);
    // 反证：旧的写法（把原始参数直接切 80 字塞进 key）不许回来
    expect(src).not.toContain('unlock-${pickSocketIp(req)}-${String(id).slice(0, 80)}');
  });

  it('归一化真的把那些写法收敛到同一个 key（用生产同一个函数验）', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { tryParseNumericId } = require('../../utils/numericId');
    const spellings = ['7', '07', '007', '7.0', '0x7', '7e0', '0b111', '0o7', '0000000007', ' 7', '7 '];
    const keys = new Set(spellings.map((s) => `#${tryParseNumericId(s)}`));
    expect([...keys]).toEqual(['#7']); // 全部收敛成同一个 key ⇒ 共享同一份 20 次预算
  });

  it('别名（非数字 id）仍然按字符串计，且长度被截断', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { tryParseNumericId } = require('../../utils/numericId');
    expect(tryParseNumericId('my-post-slug')).toBeNull();
    const long = 'x'.repeat(500);
    expect(`p:${long.slice(0, 80)}`).toHaveLength(82); // 不会被超长参数撑爆 key 表
  });
});
