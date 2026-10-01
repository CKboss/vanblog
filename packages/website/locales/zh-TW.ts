/**
 * 🔴 前台（访客站）**繁體中文**词典（期 10 第五批，2026-09-30）。
 *
 * ⚠️ 这份词典**只覆盖已经过接缝的 key**（38 个）——
 * 收口台账里还有 206 条欠条（尚未接接缝的界面文案），它们在英文/繁中界面上**仍然显示中文默认值**。
 * 所以切了语种只有一部分文字变了是当前阶段的**预期行为**，不是缺陷。
 * 🔴 覆盖率由 `__tests__/i18nDictionaryCoverage.spec.ts` 量化并**只许增不许减**（棘轮）。
 *
 * 🔴 key 与 id 必须与代码里 `t(id, 默认值)` 的 id **逐字相同**；
 * 少一个 key ⇒ 那一句回落中文默认值（有判据会红）；多一个 ⇒ 是孤儿 key（同样有判据会红）。
 * ⚠️ 地区用词（不是字形转换）：**複製程式碼 / 剪貼簿 / 搜尋 / 開啟選單 / 訂閱 / 切換主題 / 小時 / 分鐘**。
 */
const dict: Record<string, string> = {
  // 🔴 移动端侧栏里那一行小标题（桌面端只有按钮，没有这行字）
  'locale.switcherShort': '語言',
  'category.collapseAll': '全部收起',
  'category.expandAll': '全部展開',
  'locale.switcher': '切換語言：目前 {current}，按一下切換到 {next}',
  'markdown.copyCode': '複製程式碼',
  'nav.actionAdmin': '管理後台',
  'nav.actionMenu': '開啟選單',
  'nav.actionRss': 'RSS 訂閱',
  'nav.actionSearch': '搜尋',
  'nav.actionTheme': '切換主題',
  'pageNav.jumpGoLabel': '前往',
  'pageNav.jumpInputLabel': '頁碼',
  'pageNav.jumpLabel': '跳轉到頁碼',
  'pageNav.jumpPrefix': '跳轉',
  'pageNav.jumpSentence': '跳轉 {input} 頁',
  'pageNav.jumpUnit': '頁',
  'postCard.copiedArticleLink': '已複製文章連結到剪貼簿！',
  'postCard.copiedSiteName': '已複製站點名到剪貼簿！',
  'postCard.copiedTitle': '已複製標題到剪貼簿！',
  'postCard.copyArticleLink': '複製文章連結',
  'postCard.copySiteName': '複製站點名',
  'postCard.copyTitle': '複製標題',
  'postCard.edit': '編輯',
  'postCard.readingTimeHint': '閱讀時間（服務端估算）',
  'readingTime.minutes': '約 {n} 分鐘',
  'relativeTime.days': '{n}天前',
  'relativeTime.hours': '{n}小時前',
  'relativeTime.justNow': '剛剛',
  'relativeTime.minutes': '{n}分鐘前',
  'relativeTime.seconds': '{n}秒前',
  'search.clearLabel': '清除搜尋',
  'search.dialogLabel': '搜尋',
  'search.inputLabel': '搜尋內容',
  'search.resultsLabel': '搜尋結果',
  'timeline.monthLabel': '{m}月',
  'toc.closeLabel': '關閉目錄',
  'toc.openLabel': '開啟目錄',
  'toc.title': '目錄',
  'unlock.lockedPrompt': '文章已加密，請輸入密碼後查看：',

  // ── 🔴 期 10 第八批：搜索界面（搜索页 + 搜索结果区）27 个 key。
  //    地区用词：**搜尋**（不用「搜索」）、**伺服器端**、**傳回**、**介面**、**子字串比對**、
  //    **靜態索引**、**比對到**、**關鍵詞**、**上一頁 / 下一頁**。
  //    🔴 「{query}」的**角引号**保留（繁中排版习惯）；省略号是单字符 `…`（U+2026）；
  //    `JSON` 三份逐字相同。
  //    ⚠️ 这批有 3 处**整句模板**（`search.overLimit` / `search.noResultsSource` / `search.foundSummary`）：
  //    原来是"匹配到 N 篇，超过上限 M 篇：显示前 K 条"这种**拼接式**文案 ⇒
  //    🔴 只翻片段永远拼不对（英文语序不同），所以改成整句 + 占位符（见 §7.209 B）。
  'search.pageTitle': '搜尋',
  'search.pageTitleWithQuery': '搜尋：{query}',
  'search.pageSubtitle': '標題、標籤、分類與摘要；子字串比對，不做模糊與糾錯',
  'search.pageSubmit': '搜尋文章',
  'search.pagePlaceholder': '輸入關鍵詞，按 Enter 搜尋',
  'search.noJsHint': '目前瀏覽器沒有啟用 JavaScript，這一頁的搜尋需要它。可以直接使用伺服器端搜尋介面：',
  'search.noJsKeywordLabel': '關鍵詞',
  'search.noJsSubmit': '搜尋（傳回 JSON）',
  'search.resultsTitle': '搜尋結果',
  'search.resultsPagination': '搜尋結果分頁',
  'search.prevPage': '上一頁',
  'search.nextPage': '下一頁',
  'search.hitTitle': '標題命中',
  'search.hitTagCategory': '標籤/分類命中',
  'search.hitExcerpt': '摘要命中',
  'search.searching': '搜尋中…',
  'search.failedRetry': '搜尋失敗，請稍後再試',
  'search.enterKeyword': '請輸入關鍵詞',
  'search.sourceStatic': '靜態索引',
  'search.sourceServer': '伺服器端搜尋',
  'search.serverFullText': '伺服器端全文搜尋',
  'search.emptyHint': '輸入關鍵詞開始搜尋（標題、標籤、分類與摘要；正文深處的詞請使用伺服器端全文搜尋）',
  'search.overLimit': '比對到 {matched} 篇，超過上限 {max} 篇：顯示前 {shown} 條，請增加關鍵詞',
  'search.noResults': '沒有找到與「{query}」相關的文章',
  'search.noResultsSource': '沒有找到與「{query}」相關的文章（來源：{source}）',
  'search.foundSummary': '找到 {total} 條結果，共 {pages} 頁（來源：{source}）',
  'search.wordCount': '{w} 字',
};

export default dict;
