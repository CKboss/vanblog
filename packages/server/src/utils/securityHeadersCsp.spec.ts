/**
 * `securityHeadersMiddleware` 的 CSP 三条指令。
 *
 * ⚠️ 只加了**零风险**的三条（`frame-ancestors 'self'` / `object-src 'none'` / `base-uri 'none'`）：
 * 完整的 `script-src` 需要先给内联样式与站长自定义脚本发 nonce，本轮没做。
 * ⚠️ 覆盖面也别夸大：这个中间件在 `main.ts` 里只挂在 pre-Nest 前缀上
 * （`/static/`、`/rss/`、`/sitemap/`、`/swagger`），前台（独立 Next 进程）与后台都不经过它。
 */
import * as fs from 'fs';
import * as path from 'path';
import { securityHeadersMiddleware } from './rateLimit';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

const SRC = stripCommentsForAnchor(fs.readFileSync(path.join(__dirname, 'rateLimit.ts'), 'utf-8'));

function fakeRes(initial: Record<string, string | number | string[]> = {}) {
  const lower = (k: string) => k.toLowerCase();
  const headers: Record<string, string | number | string[]> = {};
  for (const [k, v] of Object.entries(initial)) headers[lower(k)] = v; // ⚠️ 键必须小写化，
  // 否则 getHeader('Content-Security-Policy') 查不到初始值，"已存在就不覆盖"那条测的就是假对象
  return {
    headers,
    getHeader(k: string) {
      return headers[lower(k)];
    },
    setHeader(k: string, v: string | number | string[]) {
      headers[lower(k)] = v;
    },
  };
}

describe('securityHeadersMiddleware 的 CSP', () => {
  it('设上了那三条、且只有那三条（没有顺手加 script-src/style-src）', () => {
    const res = fakeRes();
    let nextCalled = false;
    securityHeadersMiddleware({} as any, res as any, () => {
      nextCalled = true;
    });
    expect(res.headers['content-security-policy']).toBe(
      "frame-ancestors 'self'; object-src 'none'; base-uri 'none'",
    );
    expect(String(res.headers['content-security-policy'])).not.toMatch(/script-src|style-src|default-src/);
    expect(nextCalled).toBe(true);
  });

  it('其余四个既有响应头一个都没丢', () => {
    const res = fakeRes();
    securityHeadersMiddleware({} as any, res as any, () => {});
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    // SAMEORIGIN 而不是 DENY：后台会把**同源**的 waline /ui 放进 iframe
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(String(res.headers['permissions-policy'])).toContain('geolocation=()');
  });

  it('已经有 CSP 时不覆盖（下游/反代可能设了更严的）', () => {
    const res = fakeRes({ 'Content-Security-Policy': "default-src 'none'" });
    securityHeadersMiddleware({} as any, res as any, () => {});
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
  });

  it('setHeader 抛异常时仍然调用 next（头部失败不该影响请求）', () => {
    const res = fakeRes();
    (res as any).setHeader = () => {
      throw new Error('boom');
    };
    let nextCalled = false;
    securityHeadersMiddleware({} as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('frame-ancestors 与既有 X-Frame-Options 语义一致（都是"只允许同源嵌我"）', () => {
    const res = fakeRes();
    securityHeadersMiddleware({} as any, res as any, () => {});
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});

describe('源码锚点', () => {
  const body = SRC.slice(SRC.indexOf('export function securityHeadersMiddleware'));

  it('三条指令都在这个函数体内（不是别处顺手设的）', () => {
    expect(body).toMatch(/setHeader\(\s*'Content-Security-Policy'/);
    expect(body).toContain("frame-ancestors 'self'");
    expect(body).toContain("object-src 'none'");
    expect(body).toContain("base-uri 'none'");
  });

  it('CSP 也是"已存在就不覆盖"的形状', () => {
    expect(body).toMatch(/if\s*\(\s*!res\.getHeader\('Content-Security-Policy'\)\s*\)/);
  });

  it('反证：没有偷偷加上会弄坏站点的 script-src / style-src', () => {
    const re = /Content-Security-Policy'?\s*,\s*["'][^"']*(script-src|style-src|default-src)/;
    expect(re.test("res.setHeader('Content-Security-Policy', \"script-src 'self'\")")).toBe(true); // 尺子有效
    expect(re.test(body)).toBe(false);
  });
});
