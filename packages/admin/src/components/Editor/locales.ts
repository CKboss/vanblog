/**
 * 编辑器（bytemd）的界面文案 —— 按语言合成的三份**扁平**对象。
 *
 * 🔴 为什么不手工维护 66 条中文字面量（本文件此前的形状）：
 * 实测（2026-09-25，逐键 AST 比对）发现此前那个 `export const cn` 的 66 个 key 里，
 * **62 个是上游 locale 文件的逐字副本**（值完全相同、零处定制）：
 *   - `bytemd/locales/zh_Hans.json`            47 个（bold / codeBlock / preview / toc …）
 *   - `@bytemd/plugin-gfm/locales/zh_Hans.json`  6 个（strike / table / task …）
 *   - `@bytemd/plugin-mermaid/locales/zh_Hans.json` 9 个（flowchart / gantt / pie …）
 * 三个来源**零 key 重叠**，而编辑器的 4 个消费方（`<Editor locale>`、`gfm({locale})`、
 * `mermaidForEditor({locale})`、math 插件的 `factory({locale})`）**都接收同一个扁平并集、各挑自己的 key**。
 *
 * 🔴 所以这里直接复用上游文件，收益是具体的：
 *   ① **零手工维护的库内文案**（原本要写 66×3 = 198 条，现在只需 ~15 条）；
 *   ② **不会与库升级漂移**（手工副本会在 bytemd 升级后悄悄过期，而这是静默的）；
 *   ③ **繁中的地区用词由上游维护**（实测 `zh_Hant.json` 用的是 連結/圖像/編輯/目錄，
 *      是真正的地区用词而不是字形转换，比我们手抄可靠）。
 * 🔴 顺带补上了上游有、而此前那份副本缺的 `mindmap` 与 `timeline` 两个图表名（合成后每种语言 68 条）。
 *
 * 🔴 只有两处上游不提供、必须我们自己维护：
 *   - **`@bytemd/plugin-mermaid` 不提供 `zh_Hant.json`**（它的 locales 目录只有
 *     ar/ca/de/en/es/fr/id/nb_NO/pl/pt_BR/ru/tr/zh_Hans）⇒ 繁中的 11 个图表名手写，用地区用词；
 *   - **`@bytemd/plugin-math-ssr` 完全不带 locale 文件**，只有内置英文默认值
 *     （`dist/index.js` 里 `block = "Block formula"` 等）⇒ 公式那 4 条三语都由我们给。
 *
 * ⚠️ **本文件刻意不做"选哪一种语言"**：`getLocale()` 内部会走 umi 的 `plugin.applyPlugins(...)`，
 * 依赖插件运行时**已初始化**，在模块加载期调用会拿到 undefined（与 `app.jsx` 的 `links` 数组同一条约束）。
 * ⇒ 这里只在模块加载期合成**纯数据**，**选择留给 `pickEditorLocale()` 在渲染期调用**。
 *
 * 🔴 `pickEditorLocale()` 返回的是 `EDITOR_LOCALES` 里的**同一个引用**（不是每次新建对象），
 * 因为 `Editor/index.tsx` 把它放进了 `useMemo` 的依赖：如果每次渲染都返回新对象，
 * **插件数组会被反复重建 ⇒ 编辑器状态被重置**。
 */
import coreZhHans from 'bytemd/locales/zh_Hans.json';
import coreZhHant from 'bytemd/locales/zh_Hant.json';
import coreEn from 'bytemd/locales/en.json';
import gfmZhHans from '@bytemd/plugin-gfm/locales/zh_Hans.json';
import gfmZhHant from '@bytemd/plugin-gfm/locales/zh_Hant.json';
import gfmEn from '@bytemd/plugin-gfm/locales/en.json';
import mermaidZhHans from '@bytemd/plugin-mermaid/locales/zh_Hans.json';
import mermaidEn from '@bytemd/plugin-mermaid/locales/en.json';

/**
 * 🔴 mermaid 的繁中：上游不提供，手写。用**地区用词**而不是字形转换 ——
 * 心智圖（不是思維導圖）、圓餅圖（不是餅狀圖）、使用者旅程圖（不是用户旅程图）。
 * ⚠️ key 集合必须与 `@bytemd/plugin-mermaid/locales/zh_Hans.json` **完全一致**
 * （含上游有而旧副本缺的 `mindmap` / `timeline`），由 `i18nEditorLocaleFollows` 守卫钉住。
 */
const MERMAID_ZH_HANT: Record<string, string> = {
  class: '類圖',
  er: '關係圖',
  flowchart: '流程圖',
  gantt: '甘特圖',
  mermaid: 'Mermaid圖表',
  mindmap: '心智圖',
  pie: '圓餅圖',
  sequence: '時序圖',
  state: '狀態圖',
  timeline: '時間軸',
  uj: '使用者旅程圖',
};

/**
 * 🔴 数学公式插件的文案：`@bytemd/plugin-math-ssr` 不带任何 locale 文件，
 * 它的 `locale?: Partial<MathLocale>` 缺省时回落内置英文 ⇒ **三语都得我们自己给**。
 * 英文刻意与上游内置默认值逐字一致（`Block formula` / `formula` / `Inline formula` / `formula`），
 * 这样将来上游若开始提供 locale 文件，我们的英文不会与它冲突。
 */
const MATH_ZH_HANS: Record<string, string> = {
  block: '块级公式',
  blockText: '公式',
  inline: '行内公式',
  inlineText: '公式',
};
const MATH_ZH_HANT: Record<string, string> = {
  block: '區塊公式',
  blockText: '公式',
  inline: '行內公式',
  inlineText: '公式',
};
const MATH_EN: Record<string, string> = {
  block: 'Block formula',
  blockText: 'formula',
  inline: 'Inline formula',
  inlineText: 'formula',
};

export type EditorLang = 'zh-CN' | 'zh-TW' | 'en-US';

/**
 * 🔴 三种语言的编辑器文案。**key 集合三份完全相同（各 68 条）**，由守卫递归比对钉住。
 * 合并顺序固定为 主体 → gfm → mermaid → math；三个上游来源零 key 重叠，
 * math 的 4 个 key 也不与任何上游重叠 ⇒ 顺序不影响结果，但固定顺序便于排查。
 */
export const EDITOR_LOCALES: Record<EditorLang, Record<string, string>> = {
  'zh-CN': { ...coreZhHans, ...gfmZhHans, ...mermaidZhHans, ...MATH_ZH_HANS },
  'zh-TW': { ...coreZhHant, ...gfmZhHant, ...MERMAID_ZH_HANT, ...MATH_ZH_HANT },
  'en-US': { ...coreEn, ...gfmEn, ...mermaidEn, ...MATH_EN },
};

/**
 * 按 umi 的 locale 代码挑一份。**必须在渲染期调用**（见文件头的说明）。
 *
 * 🔴 容错：本站的语言包只有三种，但 `getLocale()` 理论上可能返回别的写法
 * （`zh_Hant`、`zh-HK`，或将来新增的语言）。回落规则是——
 * 繁体写法（tw/hk/mo/hant）→ `zh-TW`；其它 `zh*` → `zh-CN`；其余一律 → `en-US`。
 * ⚠️ **绝不返回 undefined**：那会让 bytemd 的工具栏 tooltip 显示成 `undefined`。
 *
 * 🔴 返回的是 `EDITOR_LOCALES` 里的**稳定引用**（见文件头关于 `useMemo` 的说明）。
 */
export function pickEditorLocale(lang?: string | null): Record<string, string> {
  const raw = typeof lang === 'string' ? lang : '';
  if (raw === 'zh-CN' || raw === 'zh-TW' || raw === 'en-US') {
    return EDITOR_LOCALES[raw];
  }
  const lower = raw.toLowerCase().replace(/_/g, '-');
  if (lower.startsWith('zh')) {
    return /(tw|hk|mo|hant)/.test(lower) ? EDITOR_LOCALES['zh-TW'] : EDITOR_LOCALES['zh-CN'];
  }
  return EDITOR_LOCALES['en-US'];
}
