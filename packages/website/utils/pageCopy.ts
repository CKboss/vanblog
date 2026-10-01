/**
 * Defaults match the previous hardcoded friend-link / about page copy.
 *
 * 🔴 **站长裁定（2026-10-01）：这 3 条默认文案判为「永久例外」，不接多语言。**
 *
 * 为什么（三条理由，都是"消费方"层面的）：
 * ① 🔴 它们是**站长可编辑内容的默认值**：`resolvePageCopy(value, fallback)` 的语义是
 *    "站长在后台填了就用站长的，没填才用这里的默认" ⇒ 它们**站在内容那一侧**，不是界面 chrome。
 *    而站长已裁定**内容不做多语言**（文章/页面正文）⇒ 这几条默认值跟着内容一起不翻，是一致的。
 * ② 🔴 其中 `DEFAULT_FRIEND_LINK_APPLY_CONTENT` 是一整段**友链申领规则**（站长的政策声明：
 *    "请先添加本站为友链后再申请"、"不和剽窃、侵权、无诚信的网站交换"、"原则上只与技术/日志类博客交换"…）
 *    ⇒ **翻它等于替站长说话**：那是站长对别人提出的要求，措辞与立场都属于站长，
 *    我们把它翻成英文/繁中，等于以站长的名义发布了一份他没有写过的声明。
 * ③ ⚠️ 里面还有 `{{siteName}}` / `{{url}}` 这类**双重花括号占位符**（由 `PAGE_COPY_PLACEHOLDER` 替换），
 *    🔴 与 i18n 的 `{name}` 单花括号**不是同一套**（会被 visitor 看到 `{{siteName}}` 这种字面量吗？不会，
 *    但两套占位符混在一条文案里，将来接 ICU 时极易互相踩）⇒ 又一条不翻的理由。
 *
 * 👉 如果站长将来改了主意（希望这几条也跟着语种走），要做的是：
 *    把默认值改成 `t(id, 默认值)`，并且 🔴 **同时**决定"站长自己填的那一份要不要翻"
 *    （答案只能是"不翻"—— 那是站长写的）⇒ 于是会出现"默认值多语言、站长填的单语言"的混合状态，
 *    这正是当初判它永久例外的原因之一。
 */

export const DEFAULT_FRIEND_LINK_INTRO = "以下是本站的友情链接，排名不分先后：";

export const DEFAULT_FRIEND_LINK_APPLY_CONTENT = `
**[申领要求]**
- [x] 请先添加本站为友链后再申请友链，并通过留言或邮件告知
- [x] 不和剽窃、侵权、无诚信的网站交换，优先和具有原创作品的全站 HTTPS 站点交换
- [x] 原则上要求您的博客主页被百度或者 Google 等搜索引擎收录
- [x] 由于访问安全性问题，请**务必**提供 HTTPS 链接的头像地址（或留言时备注暂无以便本站主动保存）
- [x] 不接受视频站、资源站等非博客类站点交换，原则上只与技术/日志类博客交换友链

**[本站信息]**
> 名称： {{siteName}}<br/>
> 简介： {{description}}<br/>
> 网址： [{{url}}]({{url}})<br/>
> 头像： [{{logo}}]({{logo}})
`;

export const DEFAULT_ABOUT_TITLE = "关于我";

const PAGE_COPY_PLACEHOLDER =
  /\{\{\s*(siteName|description|siteDesc|url|logo)\s*\}\}/g;

export function resolvePageCopy(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim() === "" ? fallback : value;
}

export interface FriendLinkApplyVars {
  siteName: string;
  description: string;
  url: string;
  logo: string;
}

export function interpolatePageCopy(
  template: string,
  vars: FriendLinkApplyVars
): string {
  const values: Record<string, string> = {
    siteName: vars.siteName ?? "",
    description: vars.description ?? "",
    siteDesc: vars.description ?? "",
    url: vars.url ?? "",
    logo: vars.logo ?? "",
  };
  return template.replace(PAGE_COPY_PLACEHOLDER, (_match, key: string) => {
    return values[key] ?? "";
  });
}

export function renderFriendLinkApplyContent(
  value: unknown,
  vars: FriendLinkApplyVars
): string {
  return interpolatePageCopy(
    resolvePageCopy(value, DEFAULT_FRIEND_LINK_APPLY_CONTENT),
    vars
  );
}
