/**
 * 🔴 前台（访客站）**英文**词典（期 10 第五批，2026-09-30）。
 *
 * ⚠️ 只覆盖已经过接缝的 key（38 个）；其余文案仍显示中文默认值（见 zh-TW.ts 的说明）。
 *
 * 🔴 **不用 ICU 复数**：接缝层的格式化器只做 `{name}` 替换（本仓库不装 intl 库，
 * 手写 ICU 子集会造出与后台 react-intl 不一致的第二套语义）。
 * ⚠️ 已知代价（如实记）：`{n} days ago` 在 n=1 时会显示 `1 days ago`；
 * `About {n} min` 用缩写 `min` 规避了单复数；`Month {m}` 是
 * `Intl.DateTimeFormat` 接上之前的**权宜写法**（英文月份名应当是 `Sep`，不是 `Month 9`）。
 * 🔴 这三条都已登记在台账/手册里，接真 ICU 那一批要一起解决。
 * 🔴 全文**不含撇号**（`'` 与 `’` 都没有）：ICU 把撇号当转义符。
 */
const dict: Record<string, string> = {
  // 🔴 移动端侧栏里那一行小标题（桌面端只有按钮，没有这行字）
  'locale.switcherShort': 'Language',
  'category.collapseAll': 'Collapse all',
  'category.expandAll': 'Expand all',
  'locale.switcher': 'Change language: currently {current}, click to switch to {next}',
  'markdown.copyCode': 'Copy code',
  'nav.actionAdmin': 'Admin panel',
  'nav.actionMenu': 'Open menu',
  'nav.actionRss': 'RSS Feed',
  'nav.actionSearch': 'Search',
  'nav.actionTheme': 'Toggle theme',
  'pageNav.jumpGoLabel': 'Go',
  'pageNav.jumpInputLabel': 'Page number',
  'pageNav.jumpLabel': 'Go to page number',
  'pageNav.jumpPrefix': 'Go to',
  'pageNav.jumpSentence': 'Go to page {input}',
  'pageNav.jumpUnit': 'page',
  'postCard.copiedArticleLink': 'Article link copied to clipboard!',
  'postCard.copiedSiteName': 'Site name copied to clipboard!',
  'postCard.copiedTitle': 'Title copied to clipboard!',
  'postCard.copyArticleLink': 'Copy article link',
  'postCard.copySiteName': 'Copy site name',
  'postCard.copyTitle': 'Copy title',
  'postCard.edit': 'Edit',
  'postCard.readingTimeHint': 'Reading time (server estimate)',
  'readingTime.minutes': 'About {n} min',
  'relativeTime.days': '{n} days ago',
  'relativeTime.hours': '{n} hours ago',
  'relativeTime.justNow': 'just now',
  'relativeTime.minutes': '{n} minutes ago',
  'relativeTime.seconds': '{n} seconds ago',
  'search.clearLabel': 'Clear search',
  'search.dialogLabel': 'Search',
  'search.inputLabel': 'Search content',
  'search.resultsLabel': 'Search results',
  'timeline.monthLabel': 'Month {m}',
  'toc.closeLabel': 'Close table of contents',
  'toc.openLabel': 'Open table of contents',
  'toc.title': 'Table of contents',
  'unlock.lockedPrompt': 'This article is encrypted. Please enter the password to view:',

  // ── 🔴 期 10 第八批：搜索界面 27 个 key。
  //    ⚠️ **不用 ICU 复数**（接缝层只做 {name} 替换，本仓库不装 intl 库）⇒
  //    `1 results` / `1 articles` 这种读起来别扭的形式是**已知且已登记**的代价（接真 ICU 那批一起解决）。
  //    🔴 英文里**不给 {query} 加引号**（写成 `No articles found for {query}`）：
  //    引号在 ICU 里有转义语义，而这一族将来很可能要接真 ICU ⇒ 现在就不引入。
  //    `{w} characters` 用的是"字符"口径（对应中文的"字"）；省略号 `…` 保留单字符；全文无撇号。
  'search.pageTitle': 'Search',
  'search.pageTitleWithQuery': 'Search: {query}',
  'search.pageSubtitle': 'Titles, tags, categories and excerpts; substring matching, no fuzzy matching or typo correction',
  'search.pageSubmit': 'Search articles',
  'search.pagePlaceholder': 'Type a keyword and press Enter to search',
  'search.noJsHint': 'JavaScript is not enabled in your current browser, and search on this page requires it. You can use the server-side search API directly:',
  'search.noJsKeywordLabel': 'Keyword',
  'search.noJsSubmit': 'Search (returns JSON)',
  'search.resultsTitle': 'Search results',
  'search.resultsPagination': 'Search results pagination',
  'search.prevPage': 'Previous page',
  'search.nextPage': 'Next page',
  'search.hitTitle': 'Title match',
  'search.hitTagCategory': 'Tag/category match',
  'search.hitExcerpt': 'Excerpt match',
  'search.searching': 'Searching…',
  'search.failedRetry': 'Search failed, please try again later',
  'search.enterKeyword': 'Please enter a keyword',
  'search.sourceStatic': 'Static index',
  'search.sourceServer': 'Server-side search',
  'search.serverFullText': 'Server-side full-text search',
  'search.emptyHint': 'Enter a keyword to start searching (titles, tags, categories and excerpts; for words deep in the article body, use server-side full-text search)',
  'search.overLimit': 'Matched {matched} articles, above the limit of {max} articles: showing the first {shown} results, please add more keywords',
  'search.noResults': 'No articles found for {query}',
  'search.noResultsSource': 'No articles found for {query} (source: {source})',
  'search.foundSummary': 'Found {total} results across {pages} pages (source: {source})',
  'search.wordCount': '{w} characters',

  // 🔴 期 10 第十批：`comment.time*` 那 4 个 key **已移除**（站长裁定「超过 30 天显示日期」之后，
  //    评论区的本地 `timeAgo()` 被删掉、改用 `utils/relativeTime.ts` 的 `formatTimeAgoOrDate()`
  //    ⇒ 相对时间统一用 `relativeTime.*` 那 5 个 key，这 4 个变成**孤儿 key**（覆盖率对账第 ② 条抓到了）。
  //    ⚠️ 因此评论时间的措辞从 `30 分钟前` 变成 `30分钟前`（少一个空格，统一到与后台一致的口径）。
  // ── 🔴 期 10 第九批：评论区 39 个 key。
  //    ⚠️ **不用 ICU 复数**（接缝层只做 {name} 替换）⇒ `1 replies` / `1 characters` 这种形式是
  //    **已知且已登记**的代价（接真 ICU 那批一起解决）。
  //    🔴 英文里**不给昵称加引号**、不用撇号（ICU 转义）；省略号保留单字符 `…`；
  //    `Markdown` / `HTML` / `http/https` / `@{nick}` 逐字保留。
  //    🔴 `comment.honeypotLabel` 是**蜜罐**诱饵文案 ⇒ 必须读起来像一句普通指示
  //    （"Please leave this field empty"），**绝不能**暴露它是反垃圾字段。
  //    ⚠️ 只有 `comment.empty` 以句号结尾（中文原文就是「…来说两句吧。」）；标签/按钮一律不加句号。
  'comment.authorBadge': 'Author',
  'comment.replyTo': 'Reply to @{nick}',
  'comment.cancelReply': 'Cancel reply',
  'comment.reply': 'Reply',
  'comment.permalink': 'Link to this comment',
  'comment.repliesSummary': '{count} replies in total, showing the first {shown}',
  'comment.loadFailed': 'Failed to load comments',
  'comment.emptyContent': 'Write something first',
  'comment.tooLong': 'Content cannot exceed {max} characters',
  'comment.nickRequired': 'A nickname is required',
  'comment.emailRequired': 'This site requires an email address (it will not be shown publicly)',
  'comment.pendingNotice': 'Comment submitted; it will appear after approval',
  'comment.success': 'Comment posted',
  'comment.submitFailed': 'Submission failed, please try again later',
  'comment.title': 'Comments',
  'comment.nickPlaceholder': 'Nickname (required)',
  'comment.nickLabel': 'Nickname',
  'comment.emailPlaceholderRequired': 'Email (required, not shown publicly)',
  'comment.emailPlaceholderOptional': 'Email (optional, not shown publicly)',
  'comment.emailLabel': 'Email',
  'comment.sitePlaceholder': 'Website (optional, http/https)',
  'comment.siteLabel': 'Website',
  'comment.textareaReplyPlaceholder': 'Reply to @{nick}… (basic Markdown is supported, raw HTML will be shown literally)',
  'comment.textareaPlaceholder': 'Write your comment… (basic Markdown is supported, raw HTML will be shown literally)',
  'comment.contentLabel': 'Comment content',
  'comment.honeypotLabel': 'Please leave this field empty',
  'comment.replyingTo': 'Replying to @{nick}',
  'comment.cancel': 'Cancel',
  'comment.moderationNotice': 'Comments on this site appear after approval',
  'comment.markdownNotice': 'Basic Markdown is supported; links or sensitive words will be sent to manual review',
  'comment.submitting': 'Submitting…',
  'comment.submit': 'Post comment',
  'comment.empty': 'No comments yet - be the first to say something.',
  'comment.loading': 'Loading…',
  'comment.loadMore': 'Load more comments ({count} remaining)',
};

export default dict;
