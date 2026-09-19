/**
 * `/c/:pathname*` 的 302 目标收口。
 *
 * ⚠️ 先澄清一个流传的错误说法：那个 `location` **不是数据库字段**，而是
 * `resolvePublicCustomPageRequest()` 从 **`req.url`** 派生的 `${pathname}/${search}`
 * （作用只是"访问目录时补一个尾斜杠"）。所以它不是"管理员可写的开放重定向"。
 * 但它来自请求行，而请求行可以长得奇怪：`//host/path` 是**协议相对 URL**（浏览器会跳到别的域）、
 * `/\host` 在部分浏览器里等价、CR/LF 是响应头注入的经典形状 ⇒ 在 controller 这一层再收一次口。
 */
import * as fs from 'fs';
import * as path from 'path';
import { assertSameOriginRedirect } from './customPage.controller';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

const SRC = stripCommentsForAnchor(
  fs.readFileSync(path.join(__dirname, 'customPage.controller.ts'), 'utf-8'),
);

describe('assertSameOriginRedirect', () => {
  it.each([
    '/c/foo/',
    '/c/foo/?a=1',
    '/c/a/b/c/',
    '/c/%E4%B8%AD%E6%96%87/',
    '/c/foo/#bar',
    '/',
  ])('正常的同源相对路径放行：%s', (loc) => {
    expect(assertSameOriginRedirect(loc)).toBe(loc);
  });

  it.each([
    ['//evil.com/x', '协议相对 URL'],
    ['///evil.com', '多斜杠同理'],
    ['/\\evil.com/x', '反斜杠（部分浏览器当成 //）'],
    ['https://evil.com/', '绝对 URL'],
    ['http://evil.com/', '绝对 URL'],
    ['/c/foo/\r\nSet-Cookie: a=b', 'CRLF（响应头注入）'],
    ['/c/foo/\nX-Injected: 1', 'LF'],
    ['/c/foo/\0', 'NUL'],
    ['evil.com/x', '不以 / 开头'],
    ['', '空串'],
  ])('%s 被拒（%s）', (loc) => {
    expect(assertSameOriginRedirect(loc)).toBeNull();
  });

  it('非字符串输入不抛异常，一律拒', () => {
    for (const v of [null, undefined, 123, {}, []]) {
      expect(assertSameOriginRedirect(v as unknown as string)).toBeNull();
    }
  });
});

describe('源码锚点：controller 必须真的用它', () => {
  it('redirect 分支先过 assertSameOriginRedirect，再 res.redirect（顺序是契约）', () => {
    const at = SRC.indexOf("target.kind === 'redirect'");
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, at + 700);
    const callAt = block.search(/assertSameOriginRedirect\(\s*target\.location\s*\)/);
    const redirectAt = block.search(/res\.redirect\(\s*302\s*,\s*location\s*\)/);
    expect(callAt).toBeGreaterThan(-1);
    expect(redirectAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(redirectAt);
  });

  it('拒绝时是 404，并且不会把原始目标回显给客户端', () => {
    const at = SRC.indexOf("target.kind === 'redirect'");
    const block = SRC.slice(at, at + 700);
    expect(block).toMatch(/res\.status\(404\)/);
    expect(block).toMatch(/if\s*\(\s*!location\s*\)/);
    // 404 的文案与该 controller 其它分支一致，不带用户输入
    expect(block).not.toMatch(/HttpException\([^)]*\$\{location\}/);
  });

  it('反证：旧的"直接 redirect(target.location)"形状不许回来', () => {
    const oldShape = /res\.redirect\(\s*302\s*,\s*target\.location\s*\)/;
    expect(oldShape.test('res.redirect(302, target.location);')).toBe(true); // 尺子有效
    expect(oldShape.test(SRC)).toBe(false);
  });
});
