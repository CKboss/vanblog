import { describe, expect, it, vi } from 'vitest';

/**
 * 回归钉子：TOC 公式插件的"已加载"通知必须是粘性的。
 *
 * 真实 bug（admin 的 e2e `toc-heading.spec.js` 抓到、单测与生产都没抓到）：
 * `renderTocLabelHtml()` 在首次渲染的 useMemo 里就发起懒加载，而组件在 `useEffect` 里才订阅，
 * 所以只要 import 先 resolve（打包器内联动态 import、或分块被缓存命中），
 * 通知就发给了空集合 ⇒ 标签永远停在 `$A$<$B$` 原文且零报错。
 */
describe('tocMath 的加载通知', () => {
  it('已加载之后再订阅，回调会被立刻调用（粘性），而不是永远等不到通知', async () => {
    // 用真实模块，但把动态 import 的目标打桩成"同步就绑好"，模拟内联/缓存命中的情形
    vi.resetModules();
    const factoryCalls: number[] = [];
    vi.doMock('@bytemd/plugin-math-ssr', () => ({
      default: () => {
        factoryCalls.push(Date.now());
        return { name: 'math-stub' };
      },
    }));
    const mod = await import('../components/MarkdownTocBar/tocMath');

    // 1) 先触发加载（等价于组件首次渲染时 renderTocLabelHtml 的行为）
    const first = mod.renderTocLabelHtml('比较 $A$<$B$');
    // ⚠️ 这条以前断言 `toContain('$A$')`，等于把"插件没加载就按原文返回"钉成了契约。
    // 而那个原文会被消费点当 HTML 注入（`core.tsx:190-191` 的 dangerouslySetInnerHTML），
    // 是公开站源的存储型 XSS（mXSS），详见 __tests__/tocMathXss.spec.ts。
    // 本用例真正要钉的是**通知的粘性**（下面第 2、3 步），不是回退值长什么样：
    // 现在回退值是 null，消费点改渲染纯文本，加载完仍会重渲染成 KaTeX。
    expect(first).toBeNull();
    await mod.ensureTocMathLoaded();
    expect(mod.isTocMathLoaded()).toBe(true);

    // 2) 之后才订阅（等价于 useEffect 晚于首次渲染）—— 粘性实现必须立刻回调
    const cb = vi.fn();
    const off = mod.onTocMathReady(cb);
    expect(cb).toHaveBeenCalledTimes(1);

    // 3) 重渲染时**真的走了插件工厂**（而不是继续返回原文那条分支）。
    //    ⚠️ 这里故意不断言 'katex' 字样：插件是打桩的，产不出真 KaTeX 标记。
    //    "标签里真的出现 .katex" 由 admin 的 e2e（用真插件 + 真浏览器）钉住 ——
    //    单测钉通知语义、e2e 钉渲染结果，两层各管一段，别互相冒充。
    factoryCalls.length = 0;
    mod.renderTocLabelHtml('比较 $A$<$B$');
    expect(factoryCalls.length).toBeGreaterThanOrEqual(1);

    off();
    const cb2 = vi.fn();
    mod.onTocMathReady(cb2);
    expect(cb2).toHaveBeenCalledTimes(1); // 取消订阅不影响后来的订阅者
    vi.doUnmock('@bytemd/plugin-math-ssr');
  });

  it('订阅者抛错不会阻断其它订阅者，也不会破坏已加载状态', async () => {
    vi.resetModules();
    vi.doMock('@bytemd/plugin-math-ssr', () => ({ default: () => ({ name: 'math-stub' }) }));
    const mod = await import('../components/MarkdownTocBar/tocMath');
    await mod.ensureTocMathLoaded();
    const good = vi.fn();
    mod.onTocMathReady(() => {
      throw new Error('boom');
    });
    expect(() => mod.onTocMathReady(good)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(mod.isTocMathLoaded()).toBe(true);
    vi.doUnmock('@bytemd/plugin-math-ssr');
  });
});
