/**
 * 前台主题（插件式）。
 *
 * 设计要点：
 * - **主题 = 一份 CSS + 一个 id**。前台把 id 写到最外层容器与 <html> 的 `data-ui` 上，
 *   主题 CSS 里所有规则都挂在 `[data-ui="<id>"]` 下面 —— 这样多个主题可以共存，
 *   切换时互不污染，切回 `default` 就整体失效（内置的 apple 主题就是这么做的）。
 * - 内置主题（default / apple）打包在前台产物里；**上传的主题是一份静态文件**，
 *   存在图床目录的 `themes/` 下，由 caddy 直接服务，前台用 <link> 引入。
 *   所以换主题**不需要重新构建前台**：刷新页面即生效（配合 ISR 全量渲染）。
 * - 文件名带内容 hash（`<id>-<hash8>.css`），重新上传后 URL 变化，
 *   中间层缓存（caddy / CDN / 浏览器）自然失效，不用手工清缓存。
 */
export interface ThemeMeta {
  /** 主题 id，同时是前台 `data-ui` 的值。规则见 THEME_ID_RE。 */
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  source: 'builtin' | 'upload';
  /** 上传主题的 CSS 地址（`/static/themes/<id>-<hash8>.css`）；内置主题为空。 */
  url?: string;
  /** 内容 hash 前 8 位，用于缓存刷新与前端比对。 */
  hash?: string;
  /** 字节数 */
  size?: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

/** settings 集合里 type='theme' 的 value 形状（只存上传的主题，内置的写在代码里） */
export interface ThemeSetting {
  themes: ThemeMeta[];
}

/** 内置主题：不入库、不可删、不可覆盖 */
export const BUILTIN_THEMES: ThemeMeta[] = [
  {
    id: 'default',
    name: '默认（原卡片风格）',
    description: '不加载任何额外主题样式',
    source: 'builtin',
  },
  {
    id: 'apple',
    name: 'Apple 风格',
    description: '参考 developer.apple.com/news 的单列排版，已打包进前台，作用域 [data-ui="apple"]',
    source: 'builtin',
  },
];

/** 主题 id：小写字母/数字开头，允许 - 与 _，2-40 位。会同时用作 data-ui 与文件名的一部分。 */
export const THEME_ID_RE = /^[a-z0-9][a-z0-9-_]{1,39}$/;

/** 单个主题 CSS 的上限（512KB）。再大就该考虑是不是把图片 base64 塞进来了。 */
// 🔴 只用 `import type`：这是个纯类型/工具文件，运行期不该因为一个类型别名而多出依赖边
//    （`serverErrorCodes.ts` 会 import @nestjs/common，而本文件被前台/工具链多处引用）。
import type { ServerErrorCode } from 'src/utils/serverErrorCodes';

import { codedError } from 'src/utils/serverErrorCodes';
export const THEME_MAX_BYTES = 512 * 1024;

/**
 * 校验一份主题 CSS。返回 `{ ok: true, css, warnings }` 或 `{ ok: false, reason }`。
 *
 * 这份 CSS 会被注入到**每一个前台页面**，所以要做基本的安全过滤：
 * - `javascript:` / `expression(` / `behavior:` 是 IE 时代留下的注入面，直接拒；
 * - `</style>` 之类的闭合标签会让内联样式提前结束（我们用 <link> 引入，风险低，但一样拒掉）；
 * - 远程 `@import` 允许（引字体是正当用法），但会在 warnings 里提示：它会把访客的 IP
 *   交给第三方，而且 @import 必须写在最前面才生效。
 */
export function validateThemeCss(input: string | Buffer): {
  ok: boolean;
  reason?: string;
  /**
   * 🔴 期 9 第五批：拒绝时**同时**给出服务端错误码（与可选 params），
   * 让调用方能 `throw codedError(code, params)` ⇒ 后台按当前语言显示译文。
   * ⚠️ `reason` **保留且逐字不变**（`theme.provider.spec.ts` 有 4 条断言钉着它的内容），
   * 并由 spec 断言 `reason === SERVER_ERROR_CODES[code].zh` —— 🔴 否则同一句话就有两处口径，迟早漂。
   */
  code?: ServerErrorCode;
  params?: Record<string, string | number>;
  css?: string;
  warnings?: string[];
} {
  let css = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  // 去 BOM（Windows 编辑器常见，留着会让第一条规则失效）
  css = css.replace(/^\uFEFF/, '');
  const bytes = Buffer.byteLength(css, 'utf8');
  if (!css.trim()) {
    return { ok: false, reason: 'CSS 是空的', code: 'themeCssEmpty' };
  }
  if (bytes > THEME_MAX_BYTES) {
    return {
      ok: false,
      reason: `CSS 太大（${(bytes / 1024).toFixed(1)}KB > ${THEME_MAX_BYTES / 1024}KB）`,
      code: 'themeCssTooLarge',
      // 🔴 数字走 params（不写死在译文里）。⚠️ KB 值可能是小数（`toFixed(1)`）⇒ 英文**不用** ICU 复数
      //    （复数配小数会读成 "1.0 bytes" 那种怪话），三份都写成 `{size}KB`。
      params: { size: (bytes / 1024).toFixed(1), max: THEME_MAX_BYTES / 1024 },
    };
  }
  // 二进制/乱码：出现 NUL 就说明传的不是文本
  if (css.indexOf('\u0000') >= 0) {
    return {
      ok: false,
      reason: '文件里有 NUL 字节，看起来不是 CSS 文本',
      code: 'themeCssHasNul',
    };
  }
  // ⚠️ 扫描前先去掉注释，两个理由：
  //  1) 注释里**提到**这些关键词是正当的（示例主题就会写"javascript: 会被拒绝"），
  //     直接扫原文会把合法主题拒掉（第一版就是这么把自家 demo 挡在门外的）；
  //  2) 反过来，CSS 分词阶段会先吃掉注释，所以 `java/*x*/script:` 在浏览器眼里就是
  //     `javascript:` —— **必须扫去掉注释之后的文本**才拦得住这种拆词写法。
  // 去掉注释时**替换成空串而不是空格**：这样 `java/*x*/script:` 会变成 `javascript:` 被拦住。
  // 严格按 CSS 分词规则注释是"分隔符"、不会把两个 token 拼起来，但这里只是做安全扫描，
  // 宁可保守（正常 CSS 里不可能出现 java/*x*/script: 这种写法）。
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const lower = withoutComments.toLowerCase();
  // 🔴 期 9 第五批：每一项多带一个**错误码**。刻意按 label 拆成 6 个码，而不是"一个码 + {label} 参数"：
  //    这些 label **本身含中文**（`javascript: 伪协议`、`</style> 闭合标签`、`<script> 标签`）⇒
  //    当参数传进 ICU，英文里就会夹中文（与 `${label}密码太短`、`NumSelect d="天"` 同一个形状的坑）。
  // ⚠️ 写成**对象数组**而不是三元组：admin 侧那条"防死码"判据按 `code: '<code>'` 这个形状找码名
  //    （动态派发的那一族，见 `i18nServerErrorCodes.test.js` 第 ② 条的注释）⇒
  //    三元组里的 `'themeCssForbiddenXxx'` 只是个裸字符串，判据找不到，会把 6 个活码判成死码。
  //    🔴 这也是"判据的形状要求反向约束代码组织"的又一例（上一例：响应助手收 body 而不是码名）。
  const banned: Array<{ re: RegExp; label: string; code: ServerErrorCode }> = [
    { re: /javascript\s*:/, label: 'javascript: 伪协议', code: 'themeCssForbiddenJsProtocol' },
    { re: /expression\s*\(/, label: 'CSS expression()', code: 'themeCssForbiddenExpression' },
    { re: /behavior\s*:/, label: 'CSS behavior（HTC）', code: 'themeCssForbiddenBehavior' },
    { re: /-moz-binding/, label: '-moz-binding', code: 'themeCssForbiddenMozBinding' },
    { re: /<\/style/i, label: '</style> 闭合标签', code: 'themeCssForbiddenStyleClose' },
    { re: /<script/i, label: '<script> 标签', code: 'themeCssForbiddenScriptTag' },
  ];
  for (const b of banned) {
    if (b.re.test(lower)) {
      return { ok: false, reason: `CSS 里含有 ${b.label}，已拒绝（主题只能是样式）`, code: b.code };
    }
  }
  const warnings: string[] = [];
  // @import 的检查也用去注释后的文本（注释里的示例不该触发警告）
  const imports = withoutComments.match(/@import[^;]{0,200}/g) || [];
  const remote = imports.filter((i) => /url\(\s*['"]?https?:|@import\s+['"]https?:/i.test(i));
  if (remote.length) {
    warnings.push(
      `有 ${remote.length} 条远程 @import：访客的 IP 会被交给第三方，且 @import 必须写在样式表最前面才生效`,
    );
  }
  if (imports.length && !/^\s*@import/.test(withoutComments)) {
    warnings.push('@import 不在文件开头，浏览器会忽略它');
  }
  if (!/\[data-ui=/.test(withoutComments)) {
    warnings.push(
      '没有发现 [data-ui="<id>"] 作用域：规则会全局生效，切回其它主题时可能残留影响',
    );
  }
  return { ok: true, css, warnings };
}

/** 把主题名/文件名规整成一个合法 id（小写、非字母数字换成 -） */
export function slugifyThemeId(input: string): string {
  const raw = String(input || '')
    .toLowerCase()
    .replace(/\.css$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return raw || '';
}
