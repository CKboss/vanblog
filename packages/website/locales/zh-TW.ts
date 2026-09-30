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
};

export default dict;
