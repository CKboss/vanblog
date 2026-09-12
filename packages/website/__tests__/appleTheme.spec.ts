import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const css = read('styles/apple.css');

/** 去掉注释与 @media 包裹，拿到所有顶层选择器 */
function selectorsOf(source: string): string[] {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const walk = (text: string) => {
    // 展开 @media / @supports 块
    const atRe = /@(media|supports)[^{]*\{([\s\S]*?)\n\}/g;
    let m: RegExpExecArray | null;
    let lastIndex = 0;
    while ((m = atRe.exec(text))) {
      collectRules(text.slice(lastIndex, m.index));
      walk(m[2]);
      lastIndex = m.index + m[0].length;
    }
    collectRules(text.slice(lastIndex));
  };
  const collectRules = (text: string) => {
    const ruleRe = /([^{}]+)\{[^{}]*\}/g;
    let r: RegExpExecArray | null;
    while ((r = ruleRe.exec(text))) {
      for (const part of r[1].split(',')) {
        const sel = part.trim();
        if (sel && !sel.startsWith('@')) {
          out.push(sel);
        }
      }
    }
  };
  walk(noComments);
  return out;
}

describe('Apple 皮肤：设计令牌', () => {
  it('亮色令牌是 Apple 官网那套色值', () => {
    expect(css).toMatch(/\[data-ui="apple"\]\s*\{/);
    expect(css).toContain('--ap-canvas: #ffffff');
    expect(css).toContain('--ap-text: #1d1d1f');
    expect(css).toContain('--ap-text-2: #6e6e73');
    expect(css).toContain('--ap-hairline: #d2d2d7');
    expect(css).toContain('--ap-accent: #0071e3');
    expect(css).toContain('--ap-surface-3: #f5f5f7');
    expect(css).toContain('--ap-radius-card: 18px');
    expect(css).toContain('--ap-radius-pill: 980px');
    expect(css).toContain('--ap-content: 980px');
    expect(css).toContain('--ap-read: 780px');
    expect(css).toContain('cubic-bezier(0.4, 0, 0.2, 1)');
  });

  it('暗色令牌整体反转（黑画布 + #2997ff 强调色）', () => {
    expect(css).toMatch(/html\.dark \[data-ui="apple"\]\s*\{/);
    const dark = css.slice(css.indexOf('html.dark [data-ui="apple"] {'));
    expect(dark.slice(0, 900)).toContain('--ap-canvas: #000000');
    expect(dark.slice(0, 900)).toContain('--ap-surface: #1d1d1f');
    expect(dark.slice(0, 900)).toContain('--ap-accent: #2997ff');
    expect(dark.slice(0, 900)).toContain('--ap-hairline: #424245');
  });

  it('SF Pro 字体栈 + 17px 正文（Apple 的标志性正文字号）', () => {
    expect(css).toContain('-apple-system');
    expect(css).toContain('"SF Pro Text"');
    expect(css).toContain('PingFang SC');
    expect(css).toMatch(/font-size: 17px/);
    expect(css).toContain('line-height: 1.6');
  });
});

describe('Apple 皮肤：不会漏到默认风格上', () => {
  it('每条规则都带 [data-ui="apple"] 作用域', () => {
    const leaked = selectorsOf(css).filter(
      (sel) => !sel.includes('[data-ui="apple"]'),
    );
    expect(leaked).toEqual([]);
  });

  it('globals.css 引入了皮肤，且皮肤不 @import 别的文件', () => {
    expect(read('styles/globals.css')).toContain('@import "./apple.css"');
    expect(css).not.toContain('@import');
  });
});

describe('Apple 皮肤：关键排版', () => {
  it('导航栏是毛玻璃 + 发丝线，去掉原来的阴影', () => {
    expect(css).toMatch(/#nav\s*\{[^}]*backdrop-filter: saturate\(180%\) blur\(20px\)/);
    expect(css).toMatch(/#nav\s*\{[^}]*box-shadow: none !important/);
    expect(css).toContain('--ap-nav-bg: rgba(255, 255, 255, 0.72)');
    expect(css).toContain('height: 52px !important');
  });

  it('列表条目之间用发丝线分隔，卡片本身不再有阴影', () => {
    expect(css).toContain('.post-card-wrapper + .post-card-wrapper');
    expect(css).toMatch(
      /\.post-card-wrapper \+ \.post-card-wrapper\s*\{\s*border-top: 1px solid var\(--ap-hairline\)/,
    );
    expect(css).toMatch(/#post-card\.post-card\s*\{[^}]*background: transparent !important/);
    expect(css).toMatch(/#post-card\.post-card\s*\{[^}]*box-shadow: none !important/);
  });

  it('标题左对齐 28px/600，hover 变强调色，占位列隐藏', () => {
    expect(css).toMatch(/\.post-card-title\s*\{[^}]*display: flex !important/);
    expect(css).toContain('.post-card-title > span[aria-hidden="true"]');
    expect(css).toContain('font-size: 28px !important');
    expect(css).toMatch(/\.post-card-title a:hover > div\s*\{[^}]*--ap-accent/);
  });

  it('摘要 17px 且列表页最多 4 行，文章页不截断', () => {
    expect(css).toContain('-webkit-line-clamp: 4');
    expect(css).toMatch(
      /\.vanblog-article-page \.markdown-body\s*\{[^}]*-webkit-line-clamp: unset !important/,
    );
  });

  it('「阅读全文」变成蓝色文字链接 + 尖角括号', () => {
    expect(css).toMatch(/div\.flex\.justify-center\.mt-4 > a > div::after\s*\{\s*content: "›"/);
    expect(css).toMatch(/div\.flex\.justify-center\.mt-4\s*\{[^}]*justify-content: flex-start/);
  });

  it('作者卡片挪到页首当简介条（:has 判断，侧栏 order:-1）', () => {
    expect(css).toContain('.vanblog-body:has(#author-card)');
    expect(css).toMatch(/\.vanblog-body:has\(#author-card\)\s*\{[^}]*flex-direction: column/);
    expect(css).toMatch(
      /\.vanblog-body:has\(#author-card\) \.vanblog-sider\s*\{[^}]*order: -1/,
    );
    expect(css).toMatch(/#author-card\s*\{[^}]*position: static !important/);
    expect(css).toMatch(/#author-card > div\s*\{[^}]*flex-direction: row !important/);
  });

  it('文章页 780px 阅读栏，标题 40px，元信息下有发丝线', () => {
    expect(css).toMatch(/\.vanblog-article-page\s*\{[^}]*max-width: var\(--ap-read\)/);
    expect(css).toContain('font-size: 40px !important');
    expect(css).toMatch(
      /\.vanblog-article-page \.post-card-sub-title\s*\{[^}]*border-bottom: 1px solid var\(--ap-hairline\)/,
    );
  });

  it('Markdown 排版：字重区分标题、callout 引用、圆角代码块、发丝线表格', () => {
    expect(css).toMatch(/\.markdown-body h2\s*\{[^}]*font-size: 28px !important/);
    expect(css).toMatch(/\.markdown-body h3\s*\{[^}]*font-size: 22px !important/);
    expect(css).toMatch(
      /\.markdown-body blockquote\s*\{[^}]*border-left: 2px solid var\(--ap-hairline\)/,
    );
    expect(css).toMatch(/\.markdown-body pre\s*\{[^}]*border-radius: var\(--ap-radius-img\)/);
    expect(css).toMatch(/\.markdown-body th\s*\{[^}]*--ap-surface-3/);
    expect(css).toContain('.markdown-body a');
  });

  it('TOC 右栏、时间线、分类 chip、分页胶囊、友链卡片、页脚都有对应规则', () => {
    expect(css).toContain('.vanblog-sider:has(#toc-card)');
    expect(css).toContain('.vanblog-timeline h2');
    expect(css).toContain('.vanblog-timeline-item');
    expect(css).toContain('.vanblog-category-list');
    expect(css).toContain('.vanblog-link-card');
    expect(css).toMatch(/ul li > div\[style\]\s*\{[^}]*border-radius: var\(--ap-radius-pill\)/);
    expect(css).toMatch(/footer\s*\{[^}]*border-top: 1px solid var\(--ap-hairline\)/);
  });

  it('移动端收一档字号，并隐藏 TOC 栏', () => {
    expect(css).toContain('@media (max-width: 767px)');
    const mobile = css.slice(css.indexOf('@media (max-width: 767px)'));
    expect(mobile).toContain('font-size: 22px !important');
    expect(mobile).toMatch(/\.vanblog-sider:has\(#toc-card\)\s*\{[^}]*display: none/);
  });
});

describe('Apple 皮肤：不许出现「框」', () => {
  /** 所有带 solid 的 border 声明（含单边） */
  const solidBorders = () =>
    (css.match(/border(-top|-bottom|-left|-right)?:\s*[^;{}]*solid[^;{}]*/g) || []).map(
      (item) => item.trim(),
    );

  it('没有任何四面包围的描边（Apple 靠留白和发丝线，不靠线框）', () => {
    const boxes = solidBorders().filter((decl) => decl.startsWith('border:'));
    // 只允许两种：抹平用的 `border: 0`，以及滚动条滑块那种 `border: 3px solid transparent`
    // （transparent + background-clip: content-box 是把滑块收窄的技巧，肉眼看不到边）
    expect(
      boxes.filter((decl) => !/border:\s*0/.test(decl) && !/transparent/.test(decl)),
    ).toEqual([]);
  });

  it('保留的单边线一律是发丝线，且只用在分隔处', () => {
    const edges = solidBorders().filter(
      (decl) => !decl.startsWith('border:') || /transparent/.test(decl),
    );
    expect(edges.length).toBeGreaterThan(0);
    for (const decl of edges) {
      // 单边线只准用发丝线变量（或滚动条那种 transparent 技巧）
      expect(/var\(--ap-hairline|transparent/.test(decl)).toBe(true);
    }
  });

  it('通用卡片去框去底，只有友链/正文内嵌块用浅灰填充', () => {
    expect(css).toMatch(
      /\.card-shadow,\s*\n\[data-ui="apple"\] \.card-shadow-dark\s*\{[^}]*border: 0 !important/,
    );
    expect(css).toMatch(/\.card-shadow,[\s\S]{0,200}?background: transparent !important/);
    expect(css).toMatch(/\.vanblog-link-card,[\s\S]{0,200}?--ap-surface-3/);
    expect(css).toMatch(/\.vanblog-article-page \.card-shadow,[\s\S]{0,200}?--ap-surface-3/);
  });

  it('文章卡本身不带框（这条曾经是直角框的来源）', () => {
    expect(css).toMatch(/#post-card\.post-card\s*\{[^}]*border: 0 !important/);
    expect(css).not.toMatch(/#post-card\.post-card\s*\{[^}]*border-radius: 0/);
  });

  it('导航内部不留横线，只有整条导航底部一道发丝线', () => {
    expect(css).toMatch(/#nav \[class\*="border"\]\s*\{\s*border-color: transparent !important/);
    expect(css).toMatch(/#nav\s*\{[^}]*border-bottom: 1px solid var\(--ap-hairline-soft\)/);
  });

  it('表格/代码块/自定义容器/分页/输入框都不描边', () => {
    expect(css).toMatch(/\.markdown-body table\s*\{[^}]*border: 0;/);
    expect(css).toMatch(/\.markdown-body pre\s*\{[^}]*border: 0 !important/);
    expect(css).toMatch(/custom-container"\]\s*\{[^}]*border: 0 !important/);
    expect(css).toMatch(/ul li > div\[style\]\s*\{[^}]*border: 0 !important/);
    expect(css).toMatch(/\.post-card input\s*\{[^}]*border: 0 !important/);
  });
});

describe('Apple 皮肤：标题操作区不能抢戏', () => {
  it('「编辑」压成 13px 次要灰、常规字重，hover 才变强调色', () => {
    expect(css).toMatch(
      /\.post-card-title-actions a,[\s\S]{0,300}?color: var\(--ap-text-3\) !important/,
    );
    expect(css).toMatch(/\.post-card-title-actions a,[\s\S]{0,300}?font-size: 13px !important/);
    expect(css).toMatch(/\.post-card-title-actions a,[\s\S]{0,300}?font-weight: 400 !important/);
    expect(css).toMatch(/\.post-card-title-actions a:hover,[\s\S]{0,200}?--ap-accent/);
  });

  it('复制图标按钮同样压淡、图标缩到 14px', () => {
    expect(css).toMatch(/\.post-card-title-actions button\s*\{[^}]*--ap-text-3/);
    expect(css).toMatch(/\.post-card-title-actions svg\s*\{[^}]*width: 14px/);
  });
});

describe('Apple 皮肤：搜索浮层（Ctrl+K）', () => {
  it('面板有表面和投影，不会被 .card-shadow 的透明规则吃掉', () => {
    expect(css).toMatch(
      /\.card-shadow\.vanblog-search-panel[\s\S]{0,300}?background: var\(--ap-surface\) !important/,
    );
    expect(css).toMatch(
      /\.card-shadow\.vanblog-search-panel[\s\S]{0,300}?box-shadow: 0 24px 64px/,
    );
    // 这条规则必须写在「.card-shadow 一律透明」之后，否则层叠会输
    expect(css.indexOf('.card-shadow.vanblog-search-panel')).toBeGreaterThan(
      css.indexOf('[data-ui="apple"] .card-shadow,'),
    );
    // 暗色也要有自己的表面
    expect(css).toMatch(
      /html\.dark \[data-ui="apple"\] \.card-shadow\.vanblog-search-panel[\s\S]{0,200}?--ap-surface/,
    );
  });

  it('遮罩是半透明黑 + 背景模糊', () => {
    expect(css).toMatch(
      /\.vanblog-search-overlay\s*\{[^}]*background: rgba\(0, 0, 0, 0\.32\) !important/,
    );
    expect(css).toMatch(/\.vanblog-search-overlay\s*\{[^}]*backdrop-filter: saturate\(120%\) blur\(8px\)/);
  });

  it('输入框：21px、无框无底、占位符用次要灰', () => {
    expect(css).toMatch(
      /\.search-dialog-input\s*\{[^}]*background: transparent !important/,
    );
    expect(css).toMatch(/\.search-dialog-input\s*\{[^}]*border: 0 !important/);
    expect(css).toMatch(/\.search-dialog-input\s*\{[^}]*font-size: 21px !important/);
    expect(css).toMatch(/\.search-dialog-input::placeholder\s*\{[^}]*--ap-text-3/);
  });

  it('结果行去掉虚线，改圆角 + hover 浅灰', () => {
    expect(css).toMatch(/a\[data-search-result\] > div\s*\{[^}]*border: 0 !important/);
    expect(css).toMatch(/a\[data-search-result\] > div\s*\{[^}]*border-radius: 10px/);
    expect(css).toMatch(
      /a\[data-search-result\]:hover > div\s*\{[^}]*background: var\(--ap-surface-3\)/,
    );
  });

  it('快捷键提示（Ctrl+K / Esc）是无边框浅灰小胶囊', () => {
    expect(css).toMatch(
      /span\[class\*="border-gray-300"\]\[class\*="rounded-md"\]\s*\{[^}]*border: 0 !important/,
    );
    expect(css).toMatch(
      /span\[class\*="border-gray-300"\]\[class\*="rounded-md"\]\s*\{[^}]*--ap-surface-3/,
    );
  });

  it('组件上挂了钩子 class，小屏不会顶满', () => {
    const search = read('components/SearchCard/index.tsx');
    expect(search).toContain('vanblog-search-overlay');
    expect(search).toContain('vanblog-search-panel');
    const mobile = css.slice(css.indexOf('@media (max-width: 767px)'));
    expect(mobile).toMatch(/vanblog-search-panel[\s\S]{0,200}?width: 92% !important/);
  });
});

describe('Apple 皮肤：所有覆盖层都要有表面（不能透明）', () => {
  // 这几个组件都用 .card-shadow 当面板底色，而皮肤把 .card-shadow 统一改成了透明，
  // 所以每一个都必须有「更具体 + 排在后面」的还原规则，否则会变成看不见的浮层。
  const overlays = [
    { hook: 'vanblog-search-panel', file: 'components/SearchCard/index.tsx' },
    { hook: 'vanblog-nav-dropdown', file: 'components/NavBar/item.tsx' },
    { hook: 'vanblog-social-popover', file: 'components/SocialIcon/index.tsx' },
  ];

  for (const { hook, file } of overlays) {
    it(`${hook} 有表面、投影，且规则排在透明规则之后`, () => {
      expect(read(file)).toContain(hook);
      const rule = new RegExp(
        `\\.card-shadow\\.${hook}[\\s\\S]{0,300}?background: var\\(--ap-surface\\) !important`,
      );
      expect(css).toMatch(rule);
      expect(css).toMatch(new RegExp(`\\.card-shadow\\.${hook}[\\s\\S]{0,300}?box-shadow:`));
      expect(css.indexOf(`.card-shadow.${hook}`)).toBeGreaterThan(
        css.indexOf('[data-ui="apple"] .card-shadow,'),
      );
      // 暗色也要有自己的表面
      expect(css).toContain(`html.dark [data-ui="apple"] .card-shadow.${hook}`);
    });
  }

  it('皮肤里没有别的 card-shadow 组件被漏掉（清单对照）', () => {
    // 这些是允许透明的：内容直接坐在画布上
    const allowedTransparent = [
      'components/AuthorCard/index.tsx',
      'components/PostCard/index.tsx',
      'components/Toc/index.tsx',
      'pages/timeline.tsx',
      'pages/link.tsx',
      'pages/tag.tsx',
      'pages/category.tsx',
      'pages/tag/[tag].tsx',
      'pages/category/[category].tsx',
    ];
    // LinkCard 用浅灰填充，不是透明
    expect(css).toMatch(/\.vanblog-link-card,[\s\S]{0,200}?--ap-surface-3/);
    for (const file of allowedTransparent) {
      expect(read(file)).toContain('card-shadow');
    }
  });
});

describe('Apple 皮肤：接线', () => {
  it('Layout 按 uiStyle 输出 data-ui，并同步到 <html>', () => {
    const layout = read('components/Layout/index.tsx');
    expect(layout).toContain('data-ui={uiStyle}');
    expect(layout).toContain('document.documentElement.dataset.ui = uiStyle');
    expect(layout).toContain('props.option.uiStyle === "default" ? "default" : "apple"');
  });

  it('LayoutBody 与文章页给了皮肤稳定的作用域 class', () => {
    expect(read('components/LayoutBody/index.tsx')).toContain('vanblog-body');
    expect(read('pages/post/[id].tsx')).toContain('vanblog-article-page');
    expect(read('components/TimelineArchives/index.tsx')).toContain('vanblog-timeline');
    expect(read('components/TimeLineItem/index.tsx')).toContain('vanblog-timeline-item');
    expect(read('components/CategoryList/index.tsx')).toContain('vanblog-category-list');
    expect(read('components/LinkCard/index.tsx')).toContain('vanblog-link-card');
    expect(read('pages/404.tsx')).toContain('vanblog-notfound');
  });

  it('getLayoutProps 透传 uiStyle，缺省即 apple', () => {
    const props = read('utils/getLayoutProps.ts');
    expect(props).toContain('uiStyle: "apple" | "default"');
    expect(props).toContain('siteInfo.uiStyle === "default" ? "default" : "apple"');
  });
});
