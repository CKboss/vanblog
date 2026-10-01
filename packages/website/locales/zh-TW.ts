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

  // 🔴 期 10 第十批：`comment.time*` 那 4 个 key **已移除**（站长裁定「超过 30 天显示日期」之后，
  //    评论区的本地 `timeAgo()` 被删掉、改用 `utils/relativeTime.ts` 的 `formatTimeAgoOrDate()`
  //    ⇒ 相对时间统一用 `relativeTime.*` 那 5 个 key，这 4 个变成**孤儿 key**（覆盖率对账第 ② 条抓到了）。
  //    ⚠️ 因此评论时间的措辞从 `30 分钟前` 变成 `30分钟前`（少一个空格，统一到与后台一致的口径）。
  // ── 🔴 期 10 第九批：评论区 39 个 key（前台最大的一批）。
  //    地区用词：**留言**（评论→留言）、**回覆**（回复）、**暱稱**、**電子郵件**（邮箱）、
  //    **字元**（字符）、**載入**（加载）、**送出**（提交）、**部落客**（博主）、**個人首頁**（个人主页）、
  //    **支援基礎 Markdown**、**依字面顯示**（按字面）、**外部連結**（外链）、**則**（量词：条→則）。
  //    🔴 `@{nick}` 的 `@` 紧贴占位符；省略号是单字符 `…`（U+2026）；`Markdown` / `HTML` / `http/https` 三份逐字相同。
  //    🔴 `comment.honeypotLabel` 是**蜜罐**字段的诱饵文案 ⇒ 必须仍是「請留空這一項」这种人话，
  //    **绝不能**写成「这是防垃圾字段」（那等于告诉垃圾脚本别填）。
  //    ⚠️ `comment.time*` 刻意**不复用** `relativeTime.*`：那边是「{n}分钟前」（无空格）且没有
  //    「30 天后改用日期」的分支 ⇒ 两套措辞与行为都不同，硬凑同一个 key 会造成「改一处、另一处跟着变」。
  'comment.authorBadge': '部落客',
  'comment.replyTo': '回覆 @{nick}',
  'comment.cancelReply': '取消回覆',
  'comment.reply': '回覆',
  'comment.permalink': '連結到這則留言',
  'comment.repliesSummary': '共 {count} 則回覆，僅顯示前 {shown} 則',
  'comment.loadFailed': '留言載入失敗',
  'comment.emptyContent': '先寫點內容吧',
  'comment.tooLong': '內容不能超過 {max} 個字元',
  'comment.nickRequired': '暱稱必填',
  'comment.emailRequired': '本站要求填寫電子郵件（不會公開顯示）',
  'comment.pendingNotice': '留言已送出，審核通過後顯示',
  'comment.success': '留言成功',
  'comment.submitFailed': '送出失敗，請稍後再試',
  'comment.title': '留言',
  'comment.nickPlaceholder': '暱稱（必填）',
  'comment.nickLabel': '暱稱',
  'comment.emailPlaceholderRequired': '電子郵件（必填，不會公開）',
  'comment.emailPlaceholderOptional': '電子郵件（選填，不會公開）',
  'comment.emailLabel': '電子郵件',
  'comment.sitePlaceholder': '個人首頁（選填，http/https）',
  'comment.siteLabel': '個人首頁',
  'comment.textareaReplyPlaceholder': '回覆 @{nick}…（支援基礎 Markdown，原始 HTML 會依字面顯示）',
  'comment.textareaPlaceholder': '寫下你的留言…（支援基礎 Markdown，原始 HTML 會依字面顯示）',
  'comment.contentLabel': '留言內容',
  'comment.honeypotLabel': '請留空這一項',
  'comment.replyingTo': '正在回覆 @{nick}',
  'comment.cancel': '取消',
  'comment.moderationNotice': '本站留言需審核後顯示',
  'comment.markdownNotice': '支援基礎 Markdown；含外部連結或敏感詞會轉人工審核',
  'comment.submitting': '送出中…',
  'comment.submit': '發表留言',
  'comment.empty': '還沒有留言，來說兩句吧。',
  'comment.loading': '載入中…',
  'comment.loadMore': '載入更多留言（還有 {count} 則）',

  // ── 🔴 期 10 第十一批：站点外围文案（页脚备案与 fork 说明 / 版权块 / 解锁卡 / 主题按钮 / 404 / 文章卡）。
  //    地区用词：**編號** / **公安備案** / **增強修改版** / **部落格**（博客）/ **授權條款**（许可协议）/
  //    **註明出處** / **本文連結** / **版權聲明** / **密碼錯誤** / **解鎖** / **確認** / **自動模式** /
  //    **亮色 / 暗色模式** / **頁面** / **返回首頁**（主页→首頁）/ **閱讀全文**。
  //    🔴 技术标识符三份逐字相同：ICP / logo / VanBlog / CKboss/vanblog / dev/dsh / {license} 的值（如 CC BY-NC-SA 4.0）。
  //    🔴 标签末尾的冒号：繁中用全角「：」，英文用半角「:」。
  'footer.icpLabel': 'ICP 編號：',
  'footer.policeLabel': '公安備案：',
  'footer.policeLogoAlt': '公安備案 logo',
  'footer.forkTitle': 'VanBlog 增強修改版（CKboss/vanblog，分支 dev/dsh）',
  'footer.forkChangesTitle': '看看這個分支相對原版改了什麼',
  'footer.forkBadge': '增強修改版',
  'copyright.copied': '複製成功！',
  'copyright.licenseNotice': '本部落格所有文章除特別聲明外，均採用 {license} 授權條款。轉載請註明出處！',
  'copyright.authorLabel': '本文作者：',
  'copyright.linkLabel': '本文連結：',
  'copyright.declarationLabel': '版權聲明：',
  'unlock.wrongPassword': '密碼錯誤！請重試！',
  'unlock.emptyInput': '輸入不能為空！',
  'unlock.success': '解鎖成功！',
  'unlock.failed': '解鎖失敗！',
  'unlock.passwordPlaceholder': '請輸入密碼',
  'unlock.confirm': '確認',
  'theme.auto': '自動模式',
  'theme.autoLight': '自動模式-亮色',
  'theme.autoDark': '自動模式-暗色',
  'theme.light': '亮色模式',
  'theme.dark': '暗色模式',
  'notFound.pageWord': '頁面',
  'notFound.missingSentence': '此{thing}不存在',
  'notFound.backHome': '返回首頁',
  'postCard.encryptedHint': '該文章已加密，點擊 `閱讀全文` 並輸入密碼後方可查看。',
  'postCard.readMore': '閱讀全文',

  // ── 🔴 期 10 第十二批：前台零散界面文案（过期提示 / 作者卡统计 / 打赏 / 返回顶部 / 目录 /
  //    移动端后台入口 / 相关文章 / RSS toast / 图片加载失败 / 时间线篇数）。
  //    地区用词：**撰寫於**（编写于）/ **資訊**（信息）/ **贊助**（打赏）/ **載入**（加载）/
  //    **剪貼簿**（剪切板）/ **返回頂部** / **目錄** / **後台** / **相關文章** / **日誌**（指博文，不是日志文件）。
  //    🔴 `alert.outdatedNotice` 是**整句模板**（两个天数占位符）：原来是"前半句 + 变量 + 中段 + 变量 + 后半句"
  //    的拼接式文案 ⇒ 英文语序不同，只翻片段拼不出来。
  //    🔴 `timeline.articleCount` 的繁中用 `{n}篇`（**无空格**，与简体源文案一致：
  //    切换语种时不该看到间距变化）。
  //    ⚠️ `comment.imageFallbackAlt` **刻意不加**：它属于 markdown 管线（`collapseImages` 插件），
  //    站长裁定保持现状 ⇒ 加了就是孤儿 key。
  'alert.outdatedNotice': '請注意，本文撰寫於 {created} 天前，最後修改於 {updated} 天前，其中某些資訊可能已經過時。',
  'authorCard.postsLabel': '日誌',
  'authorCard.categoriesLabel': '分類',
  'authorCard.tagsLabel': '標籤',
  'reward.hint': '如果對你有用的話，可以贊助哦',
  'reward.button': '贊助',
  'backToTop.label': '返回頂部',
  'image.loadFailedTitle': '圖片載入失敗: {src}',
  'toc.barTitle': '目錄',
  'nav.mobileAdmin': '後台',
  'relatedArticles.title': '相關文章',
  'rss.copied': '已複製 RSS 訂閱地址到剪貼簿！',
  'timeline.articleCount': '{n}篇',
};

export default dict;
