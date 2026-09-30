/**
 * 🔴 前台（访客站）多语言的**接缝层**（期 10 第一批，2026-09-30）。
 *
 * ## 这份文件是什么、不是什么
 * **是**：一个"以后要接多语言时，只需要换掉这里"的**接缝**（seam）——
 * 与后台第一期做的完全是同一件事：把所有给用户看的字符串改成 `t(id, 中文默认值)` 调用，
 * 而 `t` 在**没有词典**时就原样返回中文默认值 ⇒ 🔴 **行为与今天逐字节相同**（零风险落地）。
 * **不是**：多语言实现本身。这里**刻意不做**的事：
 * - ❌ 不做 locale 路由（`/zh/...`、`/en/...`）：那会牵动 Next 的 `i18n` 配置、所有 `getStaticProps` 的
 *   路径生成、sitemap/RSS/feed 的 URL、以及 🔴 **鉴权与路径判断的安全审计**
 *   （别把 `/zh/` 前缀漏进 `isAdminRoute()` 这类判断里）⇒ 单独排一批；
 * - ❌ 不做词典文件（`locales/zh-CN.ts` 之类）：没有翻译内容之前建空词典只会让人以为"已经支持多语言了"；
 * - ❌ 不做**内容**多语言（文章/页面/评论正文）：站长已裁定内容不做 i18n；
 * - ❌ 不引入新依赖（`react-intl` / `next-intl` 都不装）：本仓库禁止 `pnpm install`。
 *
 * ## 三种调用形状（与后台一致的纪律）
 * 1. **React 组件里** ⇒ 用 `useT()`（渲染期取，切换语言会重渲染）：
 *    `const t = useT(); return <button>{t('search.submit', '搜索')}</button>;`
 * 2. **模块级纯函数 / 工厂** ⇒ 用**注入的尾参** `t: TFunc = IDENTITY_T`
 *    （模块加载时 `useIntl()` 会炸，而且纯函数在 SSR 期就要能跑）：
 *    `export function readingTime(words: number, t: TFunc = IDENTITY_T) { return t('x', '约 {n} 分钟', { n }); }`
 * 3. **服务端错误消息** ⇒ 用 `translateServerMessage(body)`：服务端 257 个错误码的三语译文在**后台**语言包里，
 *    前台目前没有词典 ⇒ 这个函数**按 `code` 查前台词典，查不到就原样返回服务端那句中文**
 *    （🔴 与迁移前逐字相同，绝不显示裸码或裸 key）。
 *
 * ## 🔴 为什么 `t` 的第二个参数必须是"中文默认值"而不是 key
 * 这样即使词典缺失/漏译，用户看到的仍是**今天这句话**（不会退化成 `search.submit` 这种裸 key）。
 * 漏译由守卫拦（`__tests__/i18nFrontendLedger.spec.ts` 与后台那套同理），不靠运行时兜底 ——
 * 但兜底方向必须是"退回旧行为"。
 */

/** 翻译函数签名：`(id, 中文默认值, 插值参数?) => 字符串`。 */
export type TFunc = (id: string, defaultMessage: string, values?: Record<string, unknown>) => string;

/** 支持的语种（🔴 只是**声明**，不代表已经实现；词典为空时一律走中文默认值）。 */
export type FrontLocale = 'zh-CN' | 'zh-TW' | 'en-US';

export const FRONT_LOCALES: FrontLocale[] = ['zh-CN', 'zh-TW', 'en-US'];

/** 默认语种：与 `_document.tsx` 的 `<Html lang="zh-CN">`、RSS 的 `<language>` 保持一致。 */
export const DEFAULT_FRONT_LOCALE: FrontLocale = 'zh-CN';

/**
 * 🔴 只做 `{name}` 替换（与服务端 `fillServerErrorMessage` 同口径）。
 * ⚠️ **刻意不实现 ICU**（plural / select）：本仓库不装 `intl-messageformat`，
 * 而"手写一个 ICU 子集"会造出与后台不一致的第二套语义。
 * ⇒ 需要复数的文案，**接缝期先按中文写**（中文没有复数变化），
 * 等真的接词典时再决定用哪套 ICU 实现（那一批必须同时处理"英文单复数"与"已格式化字符串不许套复数"这两条规矩）。
 */
function fillValues(text: string, values?: Record<string, unknown>): string {
  if (!values) return text;
  let out = String(text);
  for (const [k, v] of Object.entries(values)) {
    out = out.split('{' + k + '}').join(v === undefined || v === null ? '' : String(v));
  }
  return out;
}

/**
 * 🔴 恒等翻译器：没有词典时的默认行为 —— **原样返回中文默认值**（并做 `{name}` 插值）。
 * 这是"接缝期行为与今天逐字节相同"的关键：所有 `t('x.y', '中文')` 都还是那句中文。
 */
export const IDENTITY_T: TFunc = (_id, defaultMessage, values) => fillValues(defaultMessage, values);

/** 词典形状：`{ 'search.submit': 'Search' }`（**扁平 key**，与后台语言包同形）。 */
export type FrontDictionary = Record<string, string>;

let currentLocale: FrontLocale = DEFAULT_FRONT_LOCALE;
let dictionaries: Partial<Record<FrontLocale, FrontDictionary>> = {};
/** 订阅者（`useT()` 用）：`setLocale()` / `setDictionary()` 之后通知 React 重渲染。 */
const listeners = new Set<() => void>();

/** 当前语种。⚠️ 只读：改语种请用 `setLocale()`（它会通知订阅者）。 */
export function getLocale(): FrontLocale {
  return currentLocale;
}

/** 🔴 设置语种。zh-CN 一律走恒等（中文默认值就是权威文案，不需要词典）。 */
export function setLocale(next: FrontLocale): void {
  if (!FRONT_LOCALES.includes(next)) return;
  if (next === currentLocale) return;
  currentLocale = next;
  listeners.forEach((fn) => fn());
}

/** 🔴 注册某个语种的词典（将来接多语言时，这里是唯一的注入点）。 */
export function setDictionary(locale: FrontLocale, dict: FrontDictionary): void {
  dictionaries = { ...dictionaries, [locale]: { ...(dictionaries[locale] || {}), ...dict } };
  listeners.forEach((fn) => fn());
}

/** 仅供测试用：把接缝层恢复到"没有词典、zh-CN"的初始状态。 */
export function __resetI18nForTests(): void {
  currentLocale = DEFAULT_FRONT_LOCALE;
  dictionaries = {};
  listeners.clear();
}

/** 订阅语种/词典变化（`useT()` 内部用；返回取消订阅函数）。 */
export function subscribeI18n(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 🔴 主入口：按 id 查当前语种的词典；查不到就**原样返回中文默认值**。
 * ⚠️ 不抛错、不打日志、不返回裸 key —— "退回旧行为"是唯一可接受的兜底方向。
 */
export const t: TFunc = (id, defaultMessage, values) => {
  const dict = currentLocale === DEFAULT_FRONT_LOCALE ? null : dictionaries[currentLocale];
  const hit = dict ? dict[id] : undefined;
  if (typeof hit === 'string' && hit.length > 0) return fillValues(hit, values);
  return fillValues(defaultMessage, values);
};

/**
 * 供"模块级纯函数"用的**注入默认值**：`function f(x, t: TFunc = DEFAULT_T)`。
 * 🔴 与 `t` 是同一个函数（分开命名只是为了在签名里表达"这是可注入的接缝"）。
 */
export const DEFAULT_T: TFunc = t;

/**
 * 🔴 服务端错误消息的前台翻译接缝。
 *
 * 服务端的 257 个错误码在**响应体**里带着 `code` 与 `params`（`{ statusCode, message, code, params }`，
 * 少数裸响应体用 `errorCode`，见 §7.202 B）。前台要显示这些消息时**必须走这个函数**，
 * 否则英文/繁中界面上会弹出服务端那句中文（后台已经修过同一类缺陷：21 处 `message.error(err.message)`）。
 *
 * 语义（每一步都有理由）：
 * ① 认四种形状：响应体本身、`err.data`（umi-request 风格）、`err.info`、`{ response: { data } }`（fetch 风格）；
 * ② 取码的顺序是 🔴 **`errorCode` 优先、`code` 兜底**（与后台 `translateServerErrorMessage` 同口径：
 *    `export.controller` 那条的 `code` 被业务协议值 `NO_IMAGES_FOR_MDZ` 占了，i18n 码在 `errorCode`）；
 * ③ 有码且**前台词典里有** `error.<code>` ⇒ 用译文 + `params` 插值；
 * ④ 🔴 否则**原样返回服务端那句中文**（`message`）—— 与今天逐字相同，绝不显示裸码/裸 key；
 * ⑤ 什么都取不到 ⇒ 返回 `undefined`（让调用方去用它自己的兜底文案，例如 `t('comment.loadFailed', '读取评论失败')`）。
 */
export function translateServerMessage(source: unknown): string | undefined {
  const env = pickEnvelope(source);
  if (!env) return undefined;
  const code = pickCode(env);
  if (code) {
    const dict = currentLocale === DEFAULT_FRONT_LOCALE ? null : dictionaries[currentLocale];
    const hit = dict ? dict['error.' + code] : undefined;
    if (typeof hit === 'string' && hit.length > 0) {
      return fillValues(hit, (env.params || undefined) as Record<string, unknown> | undefined);
    }
  }
  const msg = env.message;
  return typeof msg === 'string' && msg.length > 0 ? msg : undefined;
}

function pickEnvelope(source: unknown): Record<string, unknown> | null {
  if (!source || typeof source !== 'object') return null;
  const s = source as Record<string, unknown>;
  const cands: unknown[] = [s, s.data, s.info, (s.response as Record<string, unknown> | undefined)?.data];
  for (const c of cands) {
    if (c && typeof c === 'object' && ('message' in c || 'code' in c || 'errorCode' in c)) {
      return c as Record<string, unknown>;
    }
  }
  return null;
}

function pickCode(env: Record<string, unknown>): string | null {
  const a = env.errorCode;
  if (typeof a === 'string' && a) return a;
  const b = env.code;
  if (typeof b === 'string' && b) return b;
  return null;
}
