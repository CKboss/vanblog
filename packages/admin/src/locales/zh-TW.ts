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
};
