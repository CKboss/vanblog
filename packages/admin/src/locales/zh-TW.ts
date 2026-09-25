/**
 * 🔴 繁體中文語言包（zh-TW）。
 *
 * ⚠️ **兩條翻譯原則**（違反任何一條都會造成「看得懂但用不了」）：
 *
 * 1. 🔴 **不只是字形轉換，還要套地區用詞**：檔案（文件）、影片（視頻）、預設（默認）、
 *    軟體（軟件）、伺服器（服務器）、網路（網絡）、使用者（用戶）、登入（登錄）、
 *    帳號（賬號）、留言（評論）、設定（設置）、部落格（博客）、精靈（向導）、
 *    協定（協議）、版面（布局）、進階（高級）、重新整理（刷新）、匯出（導出）、
 *    還原（恢復）、金鑰（密鑰）、資料（數據）、檔名（文件名）。
 *    👉 純字形轉換（opencc 之類）只能解決「體/體」這類字形問題，**解決不了上面這些用詞**。
 * 2. 🔴 **命令與協議字串不翻譯**：`init.setupKey.hint2` 裡的 `grep 初始化密钥`
 *    必須**保持簡體**，因為它匹配的是 **server 實際印出的日誌文字**（簡體）；
 *    翻成 `grep 初始化金鑰` 會讓這條命令**永遠抓不到東西**。
 *    同族的還有 `init.restore.err.*` 裡提到的路徑、檔名範式與環境變數名。
 *
 * 🔴 key 集合必須與 `zh-CN.ts` / `en-US.ts` **完全相等**，且**每一條的值都必須與 zh-CN 不同**
 * （由 `tests/unit/localePackParity.test.js` 釘住，防止「直接複製簡體當繁中」）。
 */
export default {
  // ── 初始化金鑰（setup key）卡片 ───────────────────────────────
  'init.setupKey.cardTitle': '本網站開啟了初始化保護：請填寫初始化金鑰',
  'init.setupKey.alertFallback': '伺服器端要求攜帶初始化金鑰（setup key）之後才能完成初始化／還原',
  'init.setupKey.placeholder': '貼上 setup.key 檔案的完整內容（或啟動日誌裡「初始化密钥」那一行）',
  'init.setupKey.hint1':
    '新版安裝預設要求初始化金鑰（VANBLOG_INIT_REQUIRE_SETUP_KEY 預設開啟）：網站未初始化期間，server 會在啟動時輸出金鑰區塊，之後每 10 分鐘重新輸出一次（VANBLOG_SETUP_KEY_REMIND_MINUTES 可調，0=只輸出一次），直到完成初始化',
  // 🔴 `grep 初始化密钥` 刻意保持簡體：它匹配的是 server 印出的日誌文字（見檔頭原則 2）
  'init.setupKey.hint2':
    '取得金鑰：docker logs <容器名稱> 2>&1 | grep 初始化密钥；或直接讀掛載日誌目錄裡的 setup.key 檔案（容器內預設 /var/log/setup.key；裸機部署在 config.yaml 的 log 目錄下），複製「完整一行」，不要帶多餘字元',
  'init.setupKey.hint3':
    '金鑰每次重新啟動 vanblog 都會重新產生；初始化完成後伺服器端自動刪除該檔案、停止提醒，兩條初始化介面也不再接受金鑰',
  'init.setupKey.hint4':
    '只有維運人員明確設定了 VANBLOG_INIT_REQUIRE_SETUP_KEY=false（逃生口，不建議）時才不要求金鑰 —— 那種情況下這一欄留空送出即可',

  // ── 「用備份還原」卡片 ────────────────────────────────────────
  'init.restore.cardTitle': '已有整站備份？直接還原',
  'init.restore.cardMessage': '上傳 full 備份檔，一步還原整個舊網站',
  'init.restore.cardNotePrefix': '管理員帳號、網站設定、文章、圖片',
  'init.restore.cardNoteStrong': '全部來自備份檔',
  'init.restore.cardNoteSuffix': '，不需要填寫下面初始化精靈的任何資訊；還原完成後用備份裡的帳號密碼登入。',

  // ── 精靈外殼 ──────────────────────────────────────────────────
  'init.divider': '—— 或者，手動初始化 ——',
  'init.wizard.title': '歡迎使用 VanBlog 個人部落格系統',
  'init.wizard.helpDoc': '說明文件',
  'init.step.user': '設定使用者',
  'init.step.basic': '基本設定',
  'init.step.advanced': '進階設定',
  'init.step.layout': '版面設定',
  'init.alert.allEditable': '初始化頁面所有設定都可在初始化後進入後台修改。',
  'init.alert.uploadDefault':
    '預設的上傳圖片會進到內建圖床，若要設定 oss 圖床，可在初始化後到設定頁變更。初始化頁面所有設定都可在初始化後進入後台修改。',

  // ── 表單欄位 ──────────────────────────────────────────────────
  'init.field.required': '這是必填欄位',
  'init.field.username': '登入使用者名稱',
  'init.field.usernamePlaceholder': '請輸入登入使用者名稱',
  'init.field.password': '登入密碼',
  'init.field.passwordPlaceholder': '請輸入登入密碼',

  // ── 對話框 ────────────────────────────────────────────────────
  'init.success.title': '初始化成功!',
  'init.success.content':
    '首次使用請記得先到後台「網站管理／留言管理」註冊留言系統的管理員帳號！留言通知等設定可在「系統設定／留言設定」中找到。',
  'init.alreadyInit.title': '本網站已經初始化過了',
  'init.alreadyInit.content': '初始化只能執行一次，接下來請直接登入。',
  'init.baseUrl.invalidTitle': '網站 URL 無效！',
  'init.baseUrl.invalidLine1': '請輸入包含完整協定的 URL',
  'init.baseUrl.invalidLine2': '例: https://blog.example.com',

  // ── 還原流程（RestoreFromBackup.tsx）─────────────────────────
  'init.restore.uploadButton': '上傳備份並還原',
  'init.restore.confirmTitle': '用 {name}（{size}）還原整個網站？',
  'init.restore.confirmOk': '我確定，還原',
  'init.restore.confirmCancel': '取消',
  'init.restore.uploading': '正在上傳…',
  'init.restore.restoring': '正在還原…',
  'init.restore.uploadingLong':
    '上傳完成，伺服器端正在還原（解壓縮 + 匯入資料庫 + 寫回靜態檔案）。幾十 MB 的備份通常要 1–2 分鐘，請不要關閉或重新整理頁面。',
  'init.restore.uploadFailed': '上傳失敗：網路錯誤或服務無法連線，請確認 server 正在執行後重試。',
  'init.restore.doneTitle': '還原完成',
  'init.restore.toSignIn': '前往登入',
  'init.restore.noAdminTitle': '資料已還原，但備份裡沒有管理員帳號',
  'init.restore.continueInit': '繼續初始化',
  'init.restore.needSetupKey': '需要初始化金鑰',
  'init.restore.failedTitle': '還原失敗',

  // ── 還原結果統計（restoreCore.formatRestoreCounts）────────────
  'init.restore.count.articles': '文章',
  'init.restore.count.images': '圖片',
  'init.restore.count.users': '使用者',
  'init.restore.count.visits': '存取記錄',
  'init.restore.count.viewers': '訪客',
  'init.restore.count.settings': '設定',
  'init.restore.count.total': '合計',
  'init.restore.count.unknownSize': '未知大小',

  // ── 還原失敗的解釋（restoreCore.describeRestoreFailure）───────
  'init.restore.err.rejected': '還原被拒絕（statusCode={code}）',
  'init.restore.err.httpFailed': '還原請求失敗（HTTP {status}）',
  'init.restore.err.409': '已經有一個還原正在進行中：等它結束再試；若那一次成功了，重新整理頁面即可進入後台。',
  'init.restore.err.403':
    '這個網站已經初始化過了：init 入口只對全新網站開放。請登入後台，用「系統設定 → 備份與還原 → 上傳備份並還原」。',
  'init.restore.err.429': '初始化相關請求太頻繁（流量限制：每 10 分鐘 5 次），請稍後再試。',
  'init.restore.err.400':
    '這個檔案不是本網站匯出的整站備份，或它由「更新版本」的 VanBlog 產生、目前 server 讀不了：先確認檔案來源；確定是新版本備份的話，升級 server 之後再來。',
  'init.restore.err.fallback1':
    '請確認選的是「匯出整站備份」產生的備份檔（檔名形如 vanblog-full-YYYYMMDD-HHMMSS.tar.zst / .tar.xz / .tar.gz）；後台匯出的 JSON 資料備份不走這裡 —— 那個在「系統設定 → 備份與還原」裡還原。',
  'init.restore.err.fallback2':
    '如果這個網站其實已經初始化過，這裡會拒絕還原 —— 請登入後台，用「系統設定 → 備份與還原」的上傳還原。',

  // ── 恢复结果的细节区块与确认弹窗（JSX 文本节点，第一轮清单漏了这批）──
  'init.restore.detail.seconds': '耗時 {seconds} 秒。',
  'init.restore.detail.counts': '還原進來：{counts}',
  'init.restore.detail.db': '{db}：{collections} 張資料表 / {documents} 筆',
  'init.restore.detail.static': '靜態檔案 {folder}：{files} 個',
  'init.restore.doneLine1Prefix': '請用',
  'init.restore.doneLine1Strong': '備份檔裡的那組帳號密碼',
  'init.restore.doneLine1Suffix': '登入 —— 不是這個頁面上填過的任何內容。',
  'init.restore.noAdminNote': '注意：這份備份檔本身沒有帶使用者記錄。若備份裡的帳號登入不上，可用 server 日誌裡的還原金鑰走「忘記密碼」流程。',
  'init.restore.uninitLine1Prefix': '備份檔裡的資料已經匯入本網站，但它',
  'init.restore.uninitLine1Strong': '不包含',
  'init.restore.uninitLine1Suffix': '管理員帳號 —— 網站仍處於未初始化狀態。',
  'init.restore.uninitLine2': '請繼續用下面的初始化精靈建立管理員帳號；剛還原進來的文章、圖片、設定都會保留。',
  'init.restore.confirmIntro': '將用這份整站備份覆蓋並初始化本網站：',
  'init.restore.confirmItem1': '資料庫全部集合（文章、草稿、分類、標籤、圖床記錄、設定、存取統計…）',
  'init.restore.confirmItem2': 'waline 留言庫',
  'init.restore.confirmItem3': '本機靜態檔案（圖床圖片與縮圖、附件、自訂頁面）',
  'init.restore.confirmNotePrefix': '管理員帳號與密碼',
  'init.restore.confirmNoteStrong': '來自備份檔',
  'init.restore.confirmNoteSuffix': '，下面初始化精靈裡的任何輸入都不需要。備份帶有管理員帳號時，還原完成後直接到登入頁；萬一這份備份檔裡沒有帳號，網站會保持未初始化，回來繼續走精靈建一個即可。',

  'common.language': '語言',
  'login.subTitle': 'VanBlog 部落格管理後台',
  'login.usernamePlaceholder': '使用者名稱',
  'login.usernameRequired': '使用者名稱是必填項！',
  'login.passwordPlaceholder': '密碼',
  'login.passwordRequired': '密碼是必填項！',
  'login.autoLogin': '自動登入',
  'login.forgotPassword': '忘記密碼',

  // 🔴 第二期第一块：後台側邊欄選單。术语沿用第一期的地区用词表（資料/留言/設定/自訂/網站/圖片/日誌）。
  // ⚠️ 「文章管理」「草稿管理」「附件管理」三条简繁逐字相同 ⇒ 已加进 localePackParity 的
  //    IDENTICAL_ZH_TW_OK 白名单（白名单必须恰好等于实际相同的那一批，多一条少一条都会红）。
  'menu.welcome': '分析概覽',
  'menu.article': '文章管理',
  'menu.editor': '圖形編輯器',
  'menu.code': '程式碼編輯器',
  'menu.about': '關於',
  'menu.draft': '草稿管理',
  'menu.img': '圖片管理',
  'menu.file': '附件管理',
  'menu.site': '網站管理',
  'menu.site.data': '資料管理',
  'menu.site.comment': '留言管理',
  'menu.site.pipeline': '流水線',
  'menu.site.setting': '系統設定',
  'menu.site.customPage': '自訂頁面',
  'menu.site.log': '日誌管理',

  // 🔴 第二期第二块：侧边栏底部（主站/关于/登出）、主题三档、登出提示。
  //    繁中套地区用词（關於 / 自動 / 登入 / 伺服器 / 工作階段），不是字形转换。
  'common.mainSite': '主站',
  'common.about': '關於',
  'common.logout': '登出',
  'theme.light': '亮色模式',
  'theme.dark': '暗色模式',
  'theme.auto': '自動模式',
  'logout.ok': '登出成功！',
  'logout.sessionGone': '已退出登入（伺服器工作階段已失效）',
  'logout.local': '已退出登入',
  'sysconf.waline.title': 'Waline 留言設定',
  'sysconf.waline.notice': '本表單控制內嵌 Waline 留言系統。換成自訂網域信箱時，開啟「是否啟用郵件通知」後填寫 SMTP、部落客信箱（收件人）與寄件地址（From）即可，不用另外部署郵件服務。說明見：',
  'sysconf.img.featureCard': '圖床功能設定',
  'sysconf.img.storageCard': '儲存策略設定',
  'sysconf.img.advancedCard': '進階操作',
  'sysconf.img.scanBtn': '掃描現有文章圖片到圖床',
  'sysconf.img.scanTip': 'PS: 掃描文章圖片會把文章內的所有圖片掃描到資料庫中，就可以在圖床頁面看到了。只支援外部連結。',
  'sysconf.img.scanOk': '掃描成功！共 {total} 項',
  'sysconf.img.scanFailed': '掃描失敗！',
  'sysconf.img.deadLinks': '失效連結：',
  'sysconf.img.colArticleId': '文章 ID',
  'sysconf.img.colTitle': '標題',
  'sysconf.img.colLink': '連結',
  'sysconf.img.exportBtn': '匯出全部本地圖床內容（壓縮檔）',
  'sysconf.img.exportTip': 'PS: 匯出全部圖片會把本地圖床的全部檔案打包成一個 zip 壓縮檔，並在完成後彈出下載視窗。',
  'sysconf.img.packDone': '圖片打包完成，已開始下載',
  'sysconf.img.packFailed': '打包失敗！',
  'sysconf.img.exportFailed': '匯出失敗',
  'sysconf.img.rewriteCard': '網域變更後改寫文章圖片連結',
  'sysconf.img.rewriteWarn': '換網域後，文章/草稿裡已經寫成絕對位址的圖片（如 https://舊網域/static/...）不會跟著改。這裡只改 Mongo 裡的本文連結，不會移動磁碟上的檔案，也不會改寫你沒填寫的第三方圖床。',
  'sysconf.img.oldBase': '舊網站 / 圖床位址',
  'sysconf.img.newBase': '新網站 / 圖床位址',
  'sysconf.img.rewriteBtn': '改寫文章與草稿中的連結',
  // 🔴 跨頁組共用的同一句話 ⇒ key 屬 `common.*`（與 zh-CN 包同一條說明）。
  'common.demoBlocked': '示範站禁止修改此項！',
  'sysconf.img.demoBlockedBody': '示範站不允許批次改寫文章內容。',
  'sysconf.img.fillBoth': '請填寫舊位址與新位址',
  'sysconf.img.rewriteConfirm': '確認改寫文章與草稿中的連結？',
  'sysconf.img.rewriteConfirmBody': '將把以「{from}」開頭的連結改寫成「{to}」。建議先在「備份還原」匯出一份資料。相對路徑 /static/... 不會改動。',
  'sysconf.img.rewriteOk': '開始改寫',
  'sysconf.img.rewriteDone': '改寫完成：文章 {articles} 篇，草稿 {drafts} 篇，共 {replacements} 處',
  'sysconf.img.afterRewrite': '之後請到「站點配置」把網站 Url 改成新網域，並確認 DNS 已指向本站。新上傳的圖片會按目前存取網域寫入。',

  // 🔴 期 3 第二批（2026-09-25）：SystemConfig 的「评论设置」（CommentSystem.jsx）与「定制化」
  // （Customizing.jsx）两个页签；跨页共用的动作词放在 common.* 下。
  // ⚠️ Customizing.jsx 的四个内层页签标签**刻意未翻译**（与 SystemConfig/index.jsx 的外层页签
  //    同属一个跨面词汇：docs/advanced/customizing.md 有一张表逐条列出它们，而文档 i18n 尚未裁定）。
  'sysconf.comment.readFailed': '讀取留言設定失敗！',
  'common.updateSuccess': '更新成功！',
  'sysconf.comment.saveFailed': '保存失敗！',
  'sysconf.comment.title': '留言系統',
  'sysconf.comment.alertP1a': '內建留言與 Waline 是兩套互相獨立的系統：',
  'sysconf.comment.alertP1b': '切換到內建留言不會遷移既有的 Waline 留言',
  'sysconf.comment.alertP1c': '（反之亦然），原系統的歷史留言只是不再顯示，資料仍保留。',
  'sysconf.comment.alertP2': '切換到 Waline 會自動啟動內嵌 Waline 服務，切換到「關閉」會停掉前台留言入口。',
  'sysconf.comment.builtin': '內建留言',
  'sysconf.comment.off': '關閉',
  'sysconf.comment.walineHint': 'Waline 的郵件通知、強制登入等選項在下方「Waline 留言設定」卡片裡設定。',
  'sysconf.comment.builtinHint': '內建留言免註冊、隨主服務運行，下面的審核規則只對內建留言生效。',
  'sysconf.comment.moderationLabel': '審核策略',
  'sysconf.comment.moderationTip': '只對內建留言生效；Waline 的審核在它自己的後台裡設定',
  'sysconf.comment.modPost': '先發後審 —— 留言直接顯示；命中待審關鍵字或包含外部連結時自動轉入「待審核」',
  'sysconf.comment.modPre': '先審後發 —— 所有留言先進入「待審核」，人工通過後才在前台顯示',
  'sysconf.comment.modNone': '不審核 —— 所有留言（含命中規則的）一律直接顯示，請謹慎開啟',
  'sysconf.comment.keywordsLabel': '待審關鍵字',
  'sysconf.comment.keywordsTip': '「先發後審」下，留言內容命中任一關鍵字（不區分大小寫）就自動轉待審；「先審後發」下所有留言本來就待審，關鍵字不再起作用',
  'sysconf.comment.keywordsExtra': '最多 {max} 個，每個不超過 {len} 字元；輸入後按 Enter 新增',
  'sysconf.comment.keywordsPlaceholder': '輸入關鍵字後按 Enter，例如：廣告',
  'sysconf.comment.requireEmailLabel': '信箱必填',
  'sysconf.comment.requireEmailTip': '開啟後訪客必須填寫信箱才能留言；信箱只在後台可見，前台不會顯示',
  'common.on': '開',
  'common.off': '關',
  'sysconf.comment.pendingOnLinkLabel': '含外部連結自動待審',
  'sysconf.comment.pendingOnLinkTip': '「先發後審」下，包含 http(s) 連結或 www. 的留言自動轉待審（垃圾廣告的常見特徵）',
  'sysconf.comment.maxLenLabel': '內容長度上限',
  'sysconf.comment.maxLenTip': '單則留言允許的最大字元數，超出會被伺服器拒絕',
  'sysconf.comment.rateLabel': '頻率限制',
  'sysconf.comment.rateTip': '同一 IP 每 10 分鐘最多能發表幾則留言，超出的請求直接拒絕',
  'common.save': '保存',
  'common.reset': '重設',
  'sysconf.customizing.helpCss': '自訂 css 會把您寫入的 css 程式碼作為 <style> 標籤插入到前台頁面的 <head> 中。',
  'sysconf.customizing.helpScript': '自訂 script 會把您寫入的 script 程式碼作為 <script> 標籤插入到前台頁面的最下方。',
  'sysconf.customizing.helpHtml': '自訂 html 會把您寫入的 html 程式碼插入到前台頁面 body 標籤中的下方。是靜態化的，首屏原始碼即存在。',
  'sysconf.customizing.helpHead': '自訂 html 會把您寫入的 html 程式碼插入到前台頁面的 head 標籤中的下方。是靜態化的，首屏原始碼即存在，可以用於網站所有權驗證。',
  'sysconf.customizing.saveConfirmTitle': '保存確認',
  'sysconf.customizing.saveConfirmBody': '保存前請確認程式碼的正確性，有問題的程式碼可能導致前台報錯！如未生效，請檢查是否在「站點配置 / 布局設定」中開啟了客製化功能。',
  'sysconf.customizing.resetOk': '重設成功！',
  'common.help': '說明',

  // ── 🔴 期 9：服務端錯誤碼（`error.<code>`）── 說明見 zh-CN 包同一處
  //    套地區用詞：建立 / 資訊 / 刪除（不是字形轉換）。
  'error.categoryDuplicateOnCreate': '分類名重複，無法建立！',
  'error.categoryDeleteNeedsName': '刪除分類必須帶分類名（name 不能為空）。',
  'error.categoryHasArticles': '分類已有文章，無法刪除！',
  'error.categoryReorderNoPayload': '無有效排序資訊！',
  'error.categoryNoneToReorder': '無分類可排序！',
  'error.categoryUpdateNoPayload': '無有效資訊，無法修改！',
  'error.categoryOrderInvalid': '排序值無效！',
  'error.categoryDuplicateOnUpdate': '分類名重複，無法修改！',

  // ── 🔴 期 9 第二批（10 個碼）── 術語決定見 zh-CN 包同一處的註解
  'error.articleImportMdzNoFile': '沒有收到檔案：請用 multipart 上傳一個 .mdz（欄位名 file）',
  'error.articleNotInRecycleBin': '資源回收筒裡沒有這篇文章（可能已還原或已永久刪除）',
  'error.articlePurgeRequiresRecycleBin': '只能永久刪除資源回收筒裡的文章（請先移入資源回收筒）',
  'error.articleNotFoundForRevision': '找不到文章（資源回收筒裡的文章請先還原，再回復歷史版本）',
  'error.revisionFeatureUnavailable': '歷史版本功能不可用（RevisionProvider 未註冊）',
  'error.revisionNotFound': '找不到這筆歷史版本（或它不屬於這篇文章）',
  'error.draftNotInRecycleBin': '資源回收筒裡沒有這篇草稿（可能已還原或已永久刪除）',
  'error.draftPurgeRequiresRecycleBin': '只能永久刪除資源回收筒裡的草稿（請先移入資源回收筒）',
  'error.exportArchiveNameInvalid': '不合法的歸檔名',
  'error.exportArchiveMissing': '歸檔不存在（可能已被清除，請重新匯出）',


  // ── 🔴 期 9 第三批（12 個碼）── 術語沿用 zh-CN 包裡那份決定：自訂頁面 / 使用者名稱 / 建立 / 伺服器 / 字元。
  'error.customPageCreateNeedsPath': '建立自訂頁面必須帶 path（頁面路由，例如 /uptime）。收到的請求裡沒有可用的 path。',
  'error.customPagePathDuplicate': '已有此路由的自訂頁面！無法重複建立！',
  'error.customPageUpdateNeedsTarget': '必須指明要修改哪一個自訂頁面：請在請求內容裡帶 `_id`（推薦，改路由時也只有它能命中原來那一列）或 `path`（頁面路由，例如 /uptime）。兩者都缺時無法定位目標，伺服器已拒絕執行（否則查詢條件會退化為「任意一頁」）。',
  'error.customPageDeleteNeedsPath': '刪除自訂頁面必須帶 path（頁面路由，例如 /uptime）。收到的請求裡沒有可用的 path，伺服器已拒絕執行（否則查詢條件會退化為「任意一頁」，刪掉一個無辜的頁面）。',
  'error.customPageNotFound': '找不到該頁面！',
  'error.collaboratorNameInvalid': '協作者使用者名稱不合法（1-50 個字元）',
  'error.accountNameInvalid': '使用者名稱不合法（1-50 個字元）',
  'error.adminPasswordInvalidNoChange': '密碼不合法，未做任何變更',
  'error.collaboratorNameDuplicate': '已有該使用者名稱的協作者，不可重複建立！',
  'error.collaboratorPasswordInvalidOnCreate': '密碼不合法，未建立協作者',
  'error.collaboratorNotFound': '沒有此協作者！無法更新！',
  'error.collaboratorPasswordInvalidOnUpdate': '密碼不合法，未變更協作者',


  // ── 🔴 期 9 第四批：資源回收筒（51 個 key）── 術語決定見 zh-CN 包同一處
  'recycle.missingIdRestore': '這筆記錄缺少 ID，無法還原',
  'recycle.missingIdPurge': '這筆記錄缺少 ID，無法永久刪除',
  'recycle.colTitle': '標題',
  'recycle.colCategory': '分類',
  'recycle.colTags': '標籤',
  'recycle.colUpdatedAt': '更新時間',
  'recycle.colDeletedAt': '刪除時間',
  'recycle.restore': '還原',
  'recycle.purge': '永久刪除',
  'recycle.noPermission': '目前帳號無操作權限',
  'recycle.colAuthor': '作者',
  'recycle.colPathname': '別名',
  'recycle.colWordCount': '字數',
  'recycle.drawerTitleDraft': '資源回收筒（已刪除的草稿）',
  'recycle.drawerTitleArticle': '資源回收筒（已刪除的文章）',
  'recycle.refresh': '重新整理',
  'recycle.draftWarningTitle': '發布成功的草稿也會自動進入資源回收筒',
  'recycle.draftWarningDesc': '還原只作用於草稿本身，不會變動已發布的文章：如果某筆草稿是發布時歸檔進來的，還原它只會得到一份發布前的舊草稿，再次編輯並發布會產生一篇重複的文章。列表本身無法區分「誤刪」與「發布後歸檔」這兩種情況，還原前請留意。',
  'recycle.listLoadFailed': '列表載入失敗，見上方提示。',
  'recycle.emptyArticle': '這裡列出的是在「文章管理」中被刪除的文章（軟刪除）：它們不會出現在前台，也不計入統計。你可以隨時「還原」把它們放回文章列表，或「永久刪除」徹底移除（無法復原）。目前沒有已刪除的文章。',
  'recycle.emptyDraft': '這裡列出的是被刪除的草稿。注意：草稿在發布成功後也會自動進入這裡（發布即歸檔草稿，是既有行為）。還原只作用於草稿本身：誤刪的草稿會回到草稿列表；發布後歸檔的草稿還原出來只是一份發布前的舊副本，不會變動已發布的文章。目前沒有已刪除的草稿。',
  'recycle.titleQuoted': '「{title}」',
  'recycle.untitled': '(無標題)',
  'recycle.restoreConfirmTitle': '確認還原這篇文章嗎？',
  'recycle.restoreConfirmText': '還原後文章會帶著刪除前的內容與設定回到「文章管理」列表。',
  'recycle.purgeConfirmTitle': '永久刪除{label}？',
  'recycle.purgeConfirmContent': '永久刪除會把這篇文章（含本文、別名、標籤等全部內容）從資料庫裡徹底移除，此操作無法復原，刪除後無法再從資源回收筒還原。如果只是誤刪，請改用「還原」。',
  'recycle.purgeOk': '永久刪除',
  'recycle.draftRestoreConfirmTitle': '確認還原這份草稿嗎？',
  'recycle.draftRestoreConfirmText': '還原只作用於草稿本身：它會回到「草稿管理」列表，可以繼續編輯。注意：發布成功的草稿也會自動進入資源回收筒 —— 如果這筆正是發布時歸檔的，還原它不會變動已發布的文章，你只會得到一份發布前的舊草稿；再次編輯並發布它會產生一篇重複的文章，請先確認這是你要的。',
  'recycle.draftPurgeConfirmTitle': '永久刪除草稿{label}？',
  'recycle.draftPurgeConfirmContent': '永久刪除會把這份草稿從資料庫裡徹底移除，此操作無法復原，刪除後無法再從資源回收筒還原。如果它已經發布過，刪除這份草稿不影響那篇已發布的文章。',
  'recycle.restoreSuccess': '已還原{label}，它已回到文章列表。還原依「文章更新」處理：繫結文章更新的流水線會執行，前台快取與總字數會重新整理。',
  'recycle.purgeSuccess': '已永久刪除{label}，此操作無法復原；總字數與前台快取會隨之重新整理。',
  'recycle.draftRestoreSuccess': '已還原草稿{label}，它已回到草稿列表。如果它曾發布過：已發布的文章不受影響，這只是發布前的舊草稿。',
  'recycle.draftPurgeSuccess': '已永久刪除草稿{label}，此操作無法復原。',
  'recycle.actionRestore': '還原',
  'recycle.actionPurge': '永久刪除',
  'recycle.actionFallback': '操作',
  'recycle.labelArticle': '文章',
  'recycle.labelDraft': '草稿',
  'recycle.labelFallback': '內容',
  'recycle.listFailure404': '目前 server 還沒有資源回收筒介面（404）：請把 server 升級到包含「文章資源回收筒」的版本後再使用這個列表。',
  'recycle.detailWrap': '（{message}）',
  'recycle.listFailureGeneric': '資源回收筒列表載入失敗{detail}，請稍後重試；這不影響文章管理裡的其它功能。',
  'recycle.actionFailure404': '這筆{label}已不在資源回收筒中（可能剛被還原或已被永久刪除），列表將重新整理為最新狀態。',
  'recycle.permissionWrap': '（需要 {permission}）',
  'recycle.actionFailure403': '目前帳號沒有{action}這筆{label}的權限{permission}，請聯絡管理員。',
  'recycle.actionFailure401': '登入已失效，請重新登入後再試。',
  'recycle.actionFailureGeneric': '{action}失敗{detail}，請稍後重試。',


  // ── 🔴 期 3 第三批（41 條）── 術語：文件（文档）/ 建立·新增（创建·新建）/ 設定（设置）/ 預設（默认）/
  //    伺服器（服务端）/ 介面（界面）/ 效能（性能）/ 隨需（按需）/ 登入（登录）/ 憑證（凭证）/ 儲存庫（仓库）/ 建置（构建）。
  'common.colName': '名稱',
  'common.colContent': '內容',
  'common.colOption': '操作',
  'sysconf.token.deleteConfirmBody': '是否確認刪除該 Token？',
  'common.deleteSuccess': '刪除成功！',
  'common.delete': '刪除',
  'sysconf.token.title': 'Token 管理',
  'sysconf.token.createTitle': '新增 API Token',
  'common.create': '新增',
  'sysconf.token.swaggerOffWithDocs': '即時 API 文件（swagger）預設關閉：設定 VANBLOG_SWAGGER=true 並重新啟動後可用。已為你開啟儲存庫裡的 API 文件。',
  'sysconf.token.swaggerOff': '即時 API 文件（swagger）預設關閉：設定 VANBLOG_SWAGGER=true 並重新啟動後可用。',
  'sysconf.token.apiDocs': 'API 文件',
  'sysconf.token.helpTitle': 'Token 管理功能介紹',
  'sysconf.token.helpP1': '建立的 Api Token 可以用來呼叫 VanBlog 的 API',
  'sysconf.token.helpP2': '搭配 API 文件，您可以做到很多有意思的事情。',
  'sysconf.token.helpP3': 'API 文件目前還不夠完整，會慢慢補齊，未來會有 API Playgroud，敬請期待。',
  'sysconf.token.helpP4': 'PS：暫時沒必要透過 API 開發自己的前台，之後會推出主題功能（完整的文件與開發指南，不限制技術棧），到時再開發會更好。',
  'sysconf.advance.loginCard': '登入安全策略',
  'sysconf.advance.retryLockedAlert': '開啟最大登入失敗次數限制目前還不穩定！暫時先不可設定，穩定後開放。',
  'sysconf.advance.demoBlockedLogin': '示範站禁止修改登入安全策略！',
  'sysconf.advance.maxRetryLabel': '開啟最大登入失敗次數限制',
  'common.enabled': '開啟',
  'common.disabled': '關閉',
  'sysconf.advance.maxRetryTooltip': '設定裡沒有明確關掉時是開啟的：同一訪客 IP 連續登入失敗 5 次後要等 5 分鐘才能再試（伺服器預設值；此項在介面裡是鎖定的）',
  'sysconf.advance.expiresInLabel': '登入憑證(Token)有效期(秒)',
  'sysconf.advance.expiresInPlaceholder': '預設為 7 天',
  'sysconf.advance.expiresInTooltip': '預設為 7 天。最小 60 秒：這個值會原樣進 JWT 的 expiresIn，0/負數會讓簽出來的 token 立刻過期（登入看起來成功、下一個請求就被踢回登入頁），所以在表單這一層就夾住。',
  'sysconf.advance.isrCard': '靜態頁面更新策略',
  'sysconf.advance.demoBlockedIsr': '示範站禁止修改靜態頁面更新策略！',
  'sysconf.advance.isrModeDelay': '延時自動',
  'sysconf.advance.isrModeOnDemand': '隨需自動',
  'sysconf.advance.isrModeTooltip': '預設「隨需自動」：後台有變動時由後端立刻觸發重新渲染，即時性高、可能需要更多效能。改成「延時自動」則按下面的秒數週期性重建。',
  'sysconf.advance.delayLabel': '延時自動更新時間(秒)',
  'sysconf.advance.delayTooltip': '僅在「延時自動更新」模式下生效：每隔這麼多秒，前台會嘗試用最新的後端資料重新產生靜態頁面。\n\n前台會把這個值夾到最小 60 秒（填更小也按 60 算），填非數字會被忽略而不是讓建置失敗。\n\n預設的「隨需更新」模式不看這個值：改文章時由後端主動觸發重新渲染，另外有一個 24 小時的兜底週期，萬一某次觸發丟了也能自我修復。',
  'sysconf.advance.isrManualCard': '手動觸發靜態頁面更新',
  'sysconf.advance.isrManualAlert': '通常你不需要這樣做，但某些情況下你也可以手動觸發增量渲染。這會讓後端嘗試重新驗證/渲染已知所有路由（觸發完成後需要一些時間生效）。',
  'sysconf.advance.isrManualOk': 'ISR 手動觸發成功！',
  'sysconf.advance.isrManualFail': 'ISR 觸發失敗！',
  'sysconf.advance.isrManualBtn': '手動觸發',


  // ── 🔴 期 3 第四批（19 條）── 術語沿用：使用者（用户）/ 名稱（名）/ 設定（设置）/ 預設（默认）/ 登入（登录）/ 檢視（查看）/ 介面（接口）。
  'common.colUsername': '使用者名稱',
  'common.colNickname': '暱稱',
  'common.colPermissions': '權限',
  'sysconf.user.collaboratorUpdated': '修改協作者成功！',
  'common.edit': '修改',
  'common.deleteConfirmTitle': '刪除確認',
  'sysconf.user.collaboratorDeleteConfirm': '是否確認刪除該協作者？',
  'sysconf.user.cardTitle': '使用者設定',
  'sysconf.user.updateOk': '更新使用者成功！請重新登入！',
  'sysconf.user.usernameLabel': '登入使用者名稱',
  'sysconf.user.usernamePlaceholder': '請輸入登入使用者名稱',
  'sysconf.user.passwordLabel': '登入密碼',
  'sysconf.user.passwordPlaceholder': '請輸入登入密碼',
  'sysconf.user.collaboratorCard': '協作者',
  'sysconf.user.collaboratorCreated': '新增協作者成功！',
  'sysconf.user.helpTitle': '協作者功能',
  'sysconf.user.helpP1': '您可以新增一些具有指定權限的協作者使用者。',
  'sysconf.user.helpP2': '協作者預設具有文章、草稿、圖片的檢視/上傳權限，其餘權限需要您明確指定。',
  'sysconf.user.helpP3': '協作者登入後將看到被精簡的後台頁面（除非此協作者具備所有權限），同時無權限的介面會報錯。',


  // ── 🔴 期 3 第五批（32 條）── 術語沿用既有包：網域（域名）/ 設定（配置）/ 日誌（日志）/ 存取（访问）/
  //    保存（同形）；本批新增：憑證（证书）/ 隨需（按需）/ 重新導向（重定向）/ 連接埠（端口）/ 反向代理（反代）/
  //    無痕視窗（无痕窗口）/ 執行日誌（运行日志）/ 進階使用者（高级玩家）/ 協定（协议）/ 資訊（信息）/ 載入（加载）。
  'sysconf.caddy.changedOk': '變更成功！將自動重新整理至新協定',
  'sysconf.caddy.updateFailed': '更新失敗！',
  'sysconf.caddy.card': 'HTTPS 相關設定',
  'sysconf.caddy.introPrefix': 'VanBlog 是透過',
  'sysconf.caddy.introSuffix': '實現憑證全自動隨需申請。',
  'common.relatedDocs': '相關文件',
  'sysconf.caddy.advancedHint': '進階使用者可點擊按鈕查看 Caddy 執行日誌或設定來排查錯誤。',
  'sysconf.caddy.accessLogHint': 'access 日誌可進入容器 /var/log/vanblog-access.log 查看',
  'sysconf.caddy.portsHint': '請確保 80/443 連接埠處於開放狀態。',
  'sysconf.caddy.firstVisitHint': '第一次透過某網域 https 存取時，如果沒有憑證會自動申請憑證。你也可以點擊下面的按鈕手動觸發憑證申請。',
  'sysconf.caddy.stableHint': '穩定後可開啟 https 自動重新導向功能，開啟後透過 http 存取將自動跳轉至 https。開啟後請用無痕視窗存取 http://你的網域 確認會跳到 https；也可點「查看 Caddy 設定」，srv1 的 listener_wrappers 應含 http_redirect。',
  'sysconf.caddy.reverseProxyWarn': '如果你用了 80 連接埠反向代理，請不要開啟 https 自動重新導向！否則你的反向代理可能會失效。',
  'sysconf.caddy.stuckPrefix': '如果不小心開啟了此選項後關不掉，可以參考：',
  'sysconf.caddy.stuckLink': '開啟了 https 重新導向後關不掉',
  'sysconf.caddy.demoBlocked': '示範站不可修改此選項，不然怕 k8s ingress 失效',
  'sysconf.caddy.noChange': '未修改任何資訊，無需保存！',
  'sysconf.caddy.confirmOff': '確定關閉 https 自動重新導向嗎？關閉後可透過 http 進行存取。點擊確定後 2 秒將自動切換到 http 存取',
  'sysconf.caddy.confirmOn': '開啟 https 自動重新導向之前，請確保透過網域可正常用 https 存取本站。開啟後將無法使用 http 存取本站。點擊確定後 2 秒將自動切換到 https 存取。注意如果是自己反向代理了 80 連接埠的話，請務必不要開啟此項！',
  'sysconf.caddy.configTitle': 'Caddy 設定',
  'sysconf.caddy.configError': '取得 Caddy 設定錯誤！',
  'sysconf.caddy.viewConfig': '查看 Caddy 設定',
  'sysconf.caddy.logTitle': 'Caddy 執行日誌',
  'sysconf.caddy.logError': '取得 Caddy 日誌錯誤！',
  'sysconf.caddy.viewLog': '查看 Caddy 日誌',
  'sysconf.caddy.clearLogConfirm': '確定清除 Caddy 執行日誌嗎？清除後將無法還原！',
  'sysconf.caddy.clearLogOk': '清除 Caddy 執行日誌成功！',
  'sysconf.caddy.clearLog': '清除 Caddy 日誌',
  'sysconf.caddy.triggerCertTitle': '觸發憑證隨需申請',
  'sysconf.caddy.triggerCertContent': '點擊確認後將開啟新視窗並用 https 存取當前網址以觸發憑證隨需申請。觸發後請稍等一會（申請時間取決於網路環境），申請完成後彈出頁面將透過 https 正常載入。',
  'sysconf.caddy.triggerCertBtn': '使用當前存取網域觸發隨需申請',
  'sysconf.caddy.redirectLabel': 'HTTPS 自動重新導向',
  'sysconf.caddy.redirectTooltip': '開啟後透過 http 存取本站將自動重新導向至 https',

};
