/**
 * 🔴 English language pack (en-US).
 *
 * ⚠️ **Hand-written, not machine translated.** UI copy quality matters here because this is
 * the first thing an English-speaking operator reads while installing the site.
 *
 * 🔴 **Two strings deliberately keep Simplified Chinese**, because they match text the
 * *server* actually emits — translating them would make the instruction unusable:
 *   - `init.setupKey.placeholder` — the startup log line is labelled `初始化密钥`;
 *   - `init.setupKey.hint2` — the shell command is `grep 初始化密钥`.
 * Both are quoted verbatim and glossed in English next to them.
 *
 * 🔴 The key set must be **identical** to `zh-CN.ts` and `zh-TW.ts`, and every value must
 * differ from `zh-CN.ts` (pinned by `tests/unit/localePackParity.test.js`).
 */
export default {
  // ── Setup key card ────────────────────────────────────────────
  'init.setupKey.cardTitle': 'This site has initialization protection enabled: enter the setup key',
  'init.setupKey.alertFallback':
    'The server requires a setup key before initialization or restore can complete',
  'init.setupKey.placeholder':
    'Paste the full contents of the setup.key file (or the line labelled 初始化密钥 — “initialization key” — in the startup log)',
  'init.setupKey.hint1':
    'New installations require a setup key by default (VANBLOG_INIT_REQUIRE_SETUP_KEY is on). While the site is uninitialized the server prints the key block at startup and reprints it every 10 minutes (adjustable with VANBLOG_SETUP_KEY_REMIND_MINUTES; 0 prints it only once), until initialization completes.',
  // 🔴 `grep 初始化密钥` stays Simplified on purpose: it matches the server's own log output.
  'init.setupKey.hint2':
    'To get the key: docker logs <container> 2>&1 | grep 初始化密钥 — or read the setup.key file in the mounted log directory (in-container default /var/log/setup.key; on a bare-metal install it sits in the log directory from config.yaml). Copy one complete line and do not include any extra characters.',
  'init.setupKey.hint3':
    'The key is regenerated on every restart of vanblog. Once initialization succeeds the server deletes that file, stops the reminder, and both initialization endpoints stop accepting a key.',
  'init.setupKey.hint4':
    'A key is only unnecessary if an operator explicitly set VANBLOG_INIT_REQUIRE_SETUP_KEY=false (an escape hatch, not recommended) — in that case submit this field empty.',

  // ── “Restore from backup” card ────────────────────────────────
  'init.restore.cardTitle': 'Already have a full-site backup? Restore it directly',
  'init.restore.cardMessage': 'Upload a full backup archive to restore the whole previous site in one step',
  'init.restore.cardNotePrefix': 'The admin account, site settings, posts and images ',
  'init.restore.cardNoteStrong': 'all come from the backup file',
  'init.restore.cardNoteSuffix':
    ' — you do not need to fill in anything in the setup wizard below. After the restore, sign in with the credentials from the backup.',

  // ── Wizard chrome ─────────────────────────────────────────────
  'init.divider': '—— or initialize manually ——',
  'init.wizard.title': 'Welcome to VanBlog',
  'init.wizard.helpDoc': 'Documentation',
  'init.step.user': 'Account',
  'init.step.basic': 'Basic settings',
  'init.step.advanced': 'Advanced settings',
  'init.step.layout': 'Layout',
  'init.alert.allEditable':
    'Everything on this page can be changed later from the admin console after initialization.',
  'init.alert.uploadDefault':
    'Uploaded images go to the built-in image host by default; to use an OSS image host instead, change it on the settings page after initialization. Everything on this page can be changed later from the admin console.',

  // ── Form fields ───────────────────────────────────────────────
  'init.field.required': 'This field is required',
  'init.field.username': 'Sign-in username',
  'init.field.usernamePlaceholder': 'Enter the sign-in username',
  'init.field.password': 'Sign-in password',
  'init.field.passwordPlaceholder': 'Enter the sign-in password',

  // ── Dialogs ───────────────────────────────────────────────────
  'init.success.title': 'Initialization succeeded!',
  'init.success.content':
    'Next step: register the comment system’s admin account under “Site management / Comments” in the console. Comment notifications and related options are under “System settings / Comment settings”.',
  'init.alreadyInit.title': 'This site has already been initialized',
  'init.alreadyInit.content': 'Initialization can only run once — please sign in instead.',
  'init.baseUrl.invalidTitle': 'Invalid site URL',
  'init.baseUrl.invalidLine1': 'Enter a URL that includes the full protocol',
  'init.baseUrl.invalidLine2': 'e.g. https://blog.example.com',

  // ── Restore flow (RestoreFromBackup.tsx) ──────────────────────
  'init.restore.uploadButton': 'Upload backup and restore',
  'init.restore.confirmTitle': 'Restore the entire site from {name} ({size})?',
  'init.restore.confirmOk': 'Yes, restore it',
  'init.restore.confirmCancel': 'Cancel',
  'init.restore.uploading': 'Uploading…',
  'init.restore.restoring': 'Restoring…',
  'init.restore.uploadingLong':
    'Upload finished; the server is now restoring (decompressing + importing the database + writing static files back). A backup of a few tens of MB usually takes 1–2 minutes — please do not close or reload this page.',
  'init.restore.uploadFailed':
    'Upload failed: a network error, or the service is unreachable. Confirm the server is running and try again.',
  'init.restore.doneTitle': 'Restore complete',
  'init.restore.toSignIn': 'Go to sign in',
  'init.restore.noAdminTitle': 'Data restored, but the backup contained no admin account',
  'init.restore.continueInit': 'Continue with initialization',
  'init.restore.needSetupKey': 'Setup key required',
  'init.restore.failedTitle': 'Restore failed',

  // ── Restore result counts (restoreCore.formatRestoreCounts) ───
  'init.restore.count.articles': 'Posts',
  'init.restore.count.images': 'Images',
  'init.restore.count.users': 'Users',
  'init.restore.count.visits': 'Visit records',
  'init.restore.count.viewers': 'Visitors',
  'init.restore.count.settings': 'Settings',
  'init.restore.count.total': 'Total',
  'init.restore.count.unknownSize': 'unknown size',

  // ── Restore failure explanations (restoreCore.describeRestoreFailure) ──
  // ⚠️ These ids map one-to-one onto the branches of `describeRestoreFailure`, which takes an
  //    optional translator argument; with no argument it returns the Chinese text unchanged,
  //    so the unit tests that `require()` it directly are unaffected.
  'init.restore.err.rejected': 'Restore rejected (statusCode={code})',
  'init.restore.err.httpFailed': 'Restore request failed (HTTP {status})',
  'init.restore.err.409':
    'A restore is already in progress: wait for it to finish and try again. If that one succeeded, reloading the page will take you into the console.',
  'init.restore.err.403':
    'This site has already been initialized, and the init endpoint is only open to brand-new sites. Sign in to the console and use “System settings → Backup & restore → Upload backup and restore”.',
  'init.restore.err.429':
    'Too many initialization requests (rate limit: 5 per 10 minutes). Please try again later.',
  'init.restore.err.400':
    'This file is not a full-site backup exported by this site, or it was produced by a newer version of VanBlog that this server cannot read. Check where the file came from; if it really is a newer backup, upgrade the server first and try again.',
  'init.restore.err.fallback1':
    'Make sure you picked an archive produced by “Export full-site backup” (filenames look like vanblog-full-YYYYMMDD-HHMMSS.tar.zst / .tar.xz / .tar.gz). The JSON data export from the console does not go through here — restore that one under “System settings → Backup & restore”.',
  'init.restore.err.fallback2':
    'If this site has in fact already been initialized, the restore will be refused here — sign in to the console and use the upload-restore under “System settings → Backup & restore”.',

  // ── 恢复结果的细节区块与确认弹窗（JSX 文本节点，第一轮清单漏了这批）──
  'init.restore.detail.seconds': 'Took {seconds}s.',
  'init.restore.detail.counts': 'Restored: {counts}',
  // 🔴 ICU 复数：`{collections} collections` 在 collections=1 时会渲染成 "1 collections"。
  //    仓库已装的 react-intl@3.12.1 实测支持 `{n, plural, one {# x} other {# xs}}`，
  //    而现有 t() 形状（intl.formatMessage({id, defaultMessage}, values)）天然支持 ⇒ 不需要改造运行时。
  //    ⚠️ 只有 en-US 这类屈折语言需要；zh-CN / zh-TW 保持「{collections} 张表」（汉语无复数变化）。
  //    由 tests/unit/i18nPluralConvention.test.js 钉住（含"用 react-intl 真的渲染一次"的正向断言）。
  'init.restore.detail.db':
    '{db}: {collections, plural, one {# collection} other {# collections}} / {documents, plural, one {# document} other {# documents}}',
  'init.restore.detail.static': 'Static files {folder}: {files}',
  'init.restore.doneLine1Prefix': 'Sign in with ',
  'init.restore.doneLine1Strong': 'the credentials from the backup file',
  'init.restore.doneLine1Suffix': ' — not anything you typed on this page.',
  'init.restore.noAdminNote':
    'Note: this archive contained no user records. If the account from the backup cannot sign in, use the recovery key in the server log with the “forgotten password” flow.',
  'init.restore.uninitLine1Prefix': 'The data from the archive has been imported into this site, but it ',
  'init.restore.uninitLine1Strong': 'does not include',
  'init.restore.uninitLine1Suffix': ' an admin account — the site is still uninitialized.',
  'init.restore.uninitLine2':
    'Please continue with the setup wizard below to create the admin account; the posts, images and settings just restored will all be kept.',
  'init.restore.confirmIntro': 'This will overwrite and initialize the site from the full-site backup:',
  'init.restore.confirmItem1':
    'Every database collection (posts, drafts, categories, tags, image-host records, settings, visit statistics…)',
  'init.restore.confirmItem2': 'The waline comment database',
  'init.restore.confirmItem3':
    'Local static files (image-host images and thumbnails, attachments, custom pages)',
  'init.restore.confirmNotePrefix': 'The admin account and password ',
  'init.restore.confirmNoteStrong': 'come from the backup file',
  'init.restore.confirmNoteSuffix':
    '; nothing you type in the setup wizard below is needed. If the backup contains an admin account you will go straight to the sign-in page after the restore; if this archive has no account, the site stays uninitialized and you can come back and create one with the wizard.',

  'common.language': 'Language',
  'login.subTitle': 'VanBlog Admin Console',
  'login.usernamePlaceholder': 'Username',
  'login.usernameRequired': 'Username is required',
  'login.passwordPlaceholder': 'Password',
  'login.passwordRequired': 'Password is required',
  'login.autoLogin': 'Keep me signed in',
  'login.forgotPassword': 'Forgot password',

  // 🔴 Phase 2, first slice: the admin sidebar menu (`config/routes.js` points at these keys via `locale`).
  // ⚠️ Terms are deliberately aligned with the wording this pack already uses in prose
  //    ("System settings", "Site management / Comments", "Posts", "Images") so the menu and the
  //    help text never contradict each other.
  'menu.welcome': 'Overview',
  'menu.article': 'Posts',
  'menu.editor': 'Visual editor',
  'menu.code': 'Code editor',
  'menu.about': 'About',
  'menu.draft': 'Drafts',
  'menu.img': 'Images',
  'menu.file': 'Attachments',
  'menu.site': 'Site management',
  'menu.site.data': 'Data',
  'menu.site.comment': 'Comments',
  'menu.site.pipeline': 'Pipelines',
  'menu.site.setting': 'System settings',
  'menu.site.customPage': 'Custom pages',
  'menu.site.log': 'Logs',

  // 🔴 第二期第二块：侧边栏底部（主站/关于/登出）、主题三档、登出提示。
  //    繁中套地区用词（關於 / 自動 / 登入 / 伺服器 / 工作階段），不是字形转换。
  'common.mainSite': 'Site',
  'common.about': 'About',
  'common.logout': 'Sign out',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.auto': 'Auto',
  'logout.ok': 'Signed out',
  'logout.sessionGone': 'Signed out (the server session had already expired)',
  'logout.local': 'Signed out',
  'sysconf.waline.title': 'Waline comments',
  'sysconf.waline.notice': 'This form controls the built-in Waline comment system. To use a custom-domain mailbox, turn on "Enable email notifications" and fill in SMTP, the author email (recipient) and the sender address (From) — no separate mail service needed. See:',
  'sysconf.img.featureCard': 'Image hosting features',
  'sysconf.img.storageCard': 'Storage policy',
  'sysconf.img.advancedCard': 'Advanced actions',
  'sysconf.img.scanBtn': 'Scan existing post images into the image host',
  'sysconf.img.scanTip': 'Note: scanning indexes every image referenced by your posts into the database so they appear on the image host page. Only external links are supported.',
  'sysconf.img.scanOk': 'Scan complete — {total, plural, one {# item} other {# items}}',
  'sysconf.img.scanFailed': 'Scan failed.',
  'sysconf.img.deadLinks': 'Broken links:',
  'sysconf.img.colArticleId': 'Post ID',
  'sysconf.img.colTitle': 'Title',
  'sysconf.img.colLink': 'Link',
  'sysconf.img.exportBtn': 'Export all local image-host content (zip)',
  'sysconf.img.exportTip': 'Note: exporting bundles every file in the local image host into a single zip archive and opens a download dialog when finished.',
  'sysconf.img.packDone': 'Images archived — the download has started',
  'sysconf.img.packFailed': 'Archiving failed.',
  'sysconf.img.exportFailed': 'Export failed',
  'sysconf.img.rewriteCard': 'Rewrite post image links after a domain change',
  'sysconf.img.rewriteWarn': 'After a domain change, images already written as absolute URLs in posts and drafts (e.g. https://old-domain/static/...) are not updated automatically. This rewrites only the body links stored in Mongo — it does not move files on disk, and it does not touch third-party image hosts you leave blank.',
  'sysconf.img.oldBase': 'Old site / image-host URL',
  'sysconf.img.newBase': 'New site / image-host URL',
  'sysconf.img.rewriteBtn': 'Rewrite links in posts and drafts',
  // 🔴 Shared across page groups (image host / comments / backup, plus DataManage's links & social)
  //    ⇒ the key lives under `common.*` (same note as in the zh-CN pack).
  'common.demoBlocked': 'Not allowed on the demo site',
  'sysconf.img.demoBlockedBody': 'Bulk rewriting of post content is disabled on the demo site.',
  'sysconf.img.fillBoth': 'Enter both the old and the new URL',
  'sysconf.img.rewriteConfirm': 'Rewrite the links in posts and drafts?',
  'sysconf.img.rewriteConfirmBody': 'Links starting with "{from}" will be rewritten to "{to}". Exporting a backup first under "Backup & restore" is recommended. Relative paths such as /static/... are left untouched.',
  'sysconf.img.rewriteOk': 'Rewrite now',
  'sysconf.img.rewriteDone': 'Rewrite complete: {articles, plural, one {# post} other {# posts}}, {drafts, plural, one {# draft} other {# drafts}}, {replacements, plural, one {# replacement} other {# replacements}}',
  'sysconf.img.afterRewrite': 'Then go to "Site settings" and change the website URL to the new domain, and make sure DNS already points here. Newly uploaded images are stored using the domain currently being visited.',

  // 🔴 期 3 第二批（2026-09-25）：SystemConfig 的「评论设置」（CommentSystem.jsx）与「定制化」
  // （Customizing.jsx）两个页签；跨页共用的动作词放在 common.* 下。
  // ⚠️ Customizing.jsx 的四个内层页签标签**刻意未翻译**（与 SystemConfig/index.jsx 的外层页签
  //    同属一个跨面词汇：docs/advanced/customizing.md 有一张表逐条列出它们，而文档 i18n 尚未裁定）。
  'sysconf.comment.readFailed': 'Could not load the comment settings',
  'common.updateSuccess': 'Updated',
  'sysconf.comment.saveFailed': 'Could not save',
  'sysconf.comment.title': 'Comment system',
  'sysconf.comment.alertP1a': 'Built-in comments and Waline are two independent systems: ',
  'sysconf.comment.alertP1b': 'switching to built-in comments does not migrate existing Waline comments',
  'sysconf.comment.alertP1c': ' (or the other way round). The previous system’s comments are simply hidden — the data is kept.',
  'sysconf.comment.alertP2': 'Switching to Waline starts the embedded Waline service automatically; switching to "Off" removes the comment entry point from the front end.',
  'sysconf.comment.builtin': 'Built-in',
  'sysconf.comment.off': 'Off',
  'sysconf.comment.walineHint': 'Waline’s email notifications, forced sign-in and similar options are configured in the "Waline comments" card below.',
  'sysconf.comment.builtinHint': 'Built-in comments need no sign-up and run inside the main service. The moderation rules below apply to built-in comments only.',
  'sysconf.comment.moderationLabel': 'Moderation',
  'sysconf.comment.moderationTip': 'Built-in comments only; Waline moderation is configured in Waline’s own admin panel',
  'sysconf.comment.modPost': 'Publish then review — comments appear immediately, and those matching a pending keyword or containing an external link are moved to "Pending" automatically',
  'sysconf.comment.modPre': 'Review then publish — every comment starts as "Pending" and appears on the front end only after manual approval',
  'sysconf.comment.modNone': 'No moderation — every comment (including rule matches) is shown immediately. Enable with caution',
  'sysconf.comment.keywordsLabel': 'Pending keywords',
  'sysconf.comment.keywordsTip': 'Under "Publish then review", a comment matching any keyword (case-insensitive) is moved to pending automatically. Under "Review then publish" every comment is already pending, so keywords have no effect',
  'sysconf.comment.keywordsExtra': 'Up to {max, plural, one {# keyword} other {# keywords}}, each at most {len, plural, one {# character} other {# characters}}; press Enter to add',
  'sysconf.comment.keywordsPlaceholder': 'Type a keyword and press Enter, e.g. spam',
  'sysconf.comment.requireEmailLabel': 'Email required',
  'sysconf.comment.requireEmailTip': 'When on, visitors must enter an email address to comment. Emails are visible only in the admin panel, never on the front end',
  'common.on': 'On',
  'common.off': 'Off',
  'sysconf.comment.pendingOnLinkLabel': 'Auto-pending on links',
  'sysconf.comment.pendingOnLinkTip': 'Under "Publish then review", comments containing an http(s) link or www. are moved to pending automatically (a common spam trait)',
  'sysconf.comment.maxLenLabel': 'Max content length',
  'sysconf.comment.maxLenTip': 'Maximum number of characters allowed per comment; longer ones are rejected by the server',
  'sysconf.comment.rateLabel': 'Rate limit',
  'sysconf.comment.rateTip': 'How many comments one IP address may post per 10 minutes; requests beyond that are rejected outright',
  'common.save': 'Save',
  'common.reset': 'Reset',
  'sysconf.customizing.helpCss': 'Custom CSS is inserted into the front-end <head> as a <style> tag.',
  'sysconf.customizing.helpScript': 'Custom script is inserted at the very bottom of front-end pages as a <script> tag.',
  'sysconf.customizing.helpHtml': 'Custom HTML is inserted near the bottom of the front-end <body>. It is static, so it is present in the very first HTML response.',
  'sysconf.customizing.helpHead': 'Custom HTML is inserted near the bottom of the front-end <head>. It is static, so it is present in the first HTML response and can be used for site-ownership verification.',
  'sysconf.customizing.saveConfirmTitle': 'Confirm save',
  'sysconf.customizing.saveConfirmBody': 'Please check the code before saving — broken code can make the front end throw errors. If it has no effect, verify that customisation is turned on under Site settings / Layout.',
  'sysconf.customizing.resetOk': 'Reset complete',
  'common.help': 'Help',

  // ── 🔴 期 9：服务端错误码（`error.<code>`）── 说明见 zh-CN 包同一处。
  //    🔴 英文必须人工写（不是逐字直译）：这些是**操作失败那一刻**用户读到的话，
  //    要说清"发生了什么、为什么、能不能改"，而不是把中文语序搬过来。
  'error.categoryDuplicateOnCreate': 'A category with that name already exists',
  'error.categoryDeleteNeedsName': 'Deleting a category requires its name (name must not be empty)',
  'error.categoryHasArticles': 'That category still contains posts, so it cannot be deleted',
  'error.categoryReorderNoPayload': 'No valid ordering information was sent',
  'error.categoryNoneToReorder': 'There are no categories to reorder',
  'error.categoryUpdateNoPayload': 'Nothing to update: no valid fields were sent',
  'error.categoryOrderInvalid': 'Invalid order value',
  'error.categoryDuplicateOnUpdate': 'Another category already uses that name',

  // ── 🔴 期 9 第二批（10 codes）── 说明见 zh-CN 包同一处；英文是人工写的
  'error.articleImportMdzNoFile': 'No file received: upload a .mdz as multipart data with the field name \"file\"',
  'error.articleNotInRecycleBin': 'That post is no longer in the recycle bin — it may already have been restored or permanently deleted',
  'error.articlePurgeRequiresRecycleBin': 'Only posts in the recycle bin can be permanently deleted. Move the post to the recycle bin first',
  'error.articleNotFoundForRevision': 'That post does not exist. Restore it from the recycle bin before reverting to a revision',
  'error.revisionFeatureUnavailable': 'Revision history is unavailable (RevisionProvider is not registered)',
  'error.revisionNotFound': 'That revision does not exist, or it does not belong to this post',
  'error.draftNotInRecycleBin': 'That draft is no longer in the recycle bin — it may already have been restored or permanently deleted',
  'error.draftPurgeRequiresRecycleBin': 'Only drafts in the recycle bin can be permanently deleted. Move the draft to the recycle bin first',
  'error.exportArchiveNameInvalid': 'Invalid archive name',
  'error.exportArchiveMissing': 'That archive no longer exists — it may have been cleaned up. Please export again',


  // ── 🔴 期 9 第三批（12 codes）── 英文人工写：这几条是操作被服务端拒绝时用户读到的话，
  //    要说清**为什么被拒**与**能不能自己修**（例如带 path / 带 _id），不是逐字直译。
  'error.customPageCreateNeedsPath': 'Creating a custom page requires a path (the page route, e.g. /uptime). The request did not contain a usable path.',
  'error.customPagePathDuplicate': 'A custom page with that route already exists, so it cannot be created again',
  'error.customPageUpdateNeedsTarget': 'Specify which custom page to update: include `_id` in the request body (recommended — it is the only field that still matches the row when you change the route) or `path` (the page route, e.g. /uptime). With neither, the server cannot identify the target and refused to run the update (otherwise the query would degrade to "any page").',
  'error.customPageDeleteNeedsPath': 'Deleting a custom page requires a path (the page route, e.g. /uptime). The request did not contain a usable path, so the server refused to delete anything (otherwise the query would degrade to "any page" and remove an innocent one).',
  'error.customPageNotFound': 'That page does not exist',
  'error.collaboratorNameInvalid': 'Invalid collaborator username (1–50 characters)',
  'error.accountNameInvalid': 'Invalid username (1–50 characters)',
  'error.adminPasswordInvalidNoChange': 'Invalid password: nothing was changed',
  'error.collaboratorNameDuplicate': 'A collaborator with that username already exists, so it cannot be created again',
  'error.collaboratorPasswordInvalidOnCreate': 'Invalid password: the collaborator was not created',
  'error.collaboratorNotFound': 'That collaborator does not exist, so it cannot be updated',
  'error.collaboratorPasswordInvalidOnUpdate': 'Invalid password: the collaborator was not updated',


  // ── 🔴 期 9 第四批：recycle bin drawer (51 keys) —— 英文人工写。
  //    🔴 刻意不写缩写（cannot / does not / it is）：ICU 把单引号当转义符，一个撇号就会让整句解析出错。
  //    ⚠️ `{action}` 只在 403 那句里用（英文放在句中才通顺）；通用失败那句改成不含动作词的说法，
  //    因为英文的动名词/原形无法同时满足"句首"和"to 后面"两种位置（🔴 这是中文参数直译会翻车的地方）。
  'recycle.missingIdRestore': 'This row has no ID, so it cannot be restored',
  'recycle.missingIdPurge': 'This row has no ID, so it cannot be deleted forever',
  'recycle.colTitle': 'Title',
  'recycle.colCategory': 'Category',
  'recycle.colTags': 'Tags',
  'recycle.colUpdatedAt': 'Updated',
  'recycle.colDeletedAt': 'Deleted',
  'recycle.restore': 'Restore',
  'recycle.purge': 'Delete forever',
  'recycle.noPermission': 'Your account has no permission for this action',
  'recycle.colAuthor': 'Author',
  'recycle.colPathname': 'Slug',
  'recycle.colWordCount': 'Words',
  'recycle.drawerTitleDraft': 'Recycle bin (deleted drafts)',
  'recycle.drawerTitleArticle': 'Recycle bin (deleted posts)',
  'recycle.refresh': 'Refresh',
  'recycle.draftWarningTitle': 'Drafts also land here automatically once they are published',
  'recycle.draftWarningDesc': 'Restoring only affects the draft itself; published posts are left alone. If a draft came here because it was published, restoring it only gives you the pre-publication copy, and editing and publishing it again would create a duplicate post. The list cannot tell an accidental deletion from a post-publish archive, so check before restoring.',
  'recycle.listLoadFailed': 'The list failed to load; see the notice above.',
  'recycle.emptyArticle': 'These are the posts deleted from the article list (soft delete): they are hidden from the front end and excluded from the statistics. Use Restore to put one back into the article list at any time, or Delete forever to remove it completely (this cannot be undone). There are no deleted posts at the moment.',
  'recycle.emptyDraft': 'These are the deleted drafts. Note that a draft also comes here automatically after it is published successfully (publishing archives the draft; this is existing behaviour). Restoring only affects the draft itself: an accidentally deleted draft goes back to the draft list, while a draft archived by publishing comes back as a pre-publication copy and does not change the published post. There are no deleted drafts at the moment.',
  'recycle.titleQuoted': '{title}',
  'recycle.untitled': '(untitled)',
  'recycle.restoreConfirmTitle': 'Restore this post?',
  'recycle.restoreConfirmText': 'The post goes back to the article list with the content and settings it had before it was deleted.',
  'recycle.purgeConfirmTitle': 'Delete {label} forever?',
  'recycle.purgeConfirmContent': 'Deleting forever removes this post (body, slug, tags and everything else) from the database. This cannot be undone, and the post cannot be restored from the recycle bin afterwards. If you deleted it by accident, use Restore instead.',
  'recycle.purgeOk': 'Delete forever',
  'recycle.draftRestoreConfirmTitle': 'Restore this draft?',
  'recycle.draftRestoreConfirmText': 'Restoring only affects the draft itself: it goes back to the draft list and you can keep editing it. Note that drafts also come here automatically after a successful publish. If this one was archived by publishing, restoring it does not change the published post; you only get the pre-publication draft, and editing and publishing it again would create a duplicate post. Please confirm that is what you want.',
  'recycle.draftPurgeConfirmTitle': 'Delete the draft {label} forever?',
  'recycle.draftPurgeConfirmContent': 'Deleting forever removes this draft from the database. This cannot be undone, and it cannot be restored from the recycle bin afterwards. If it was published before, deleting the draft does not affect that published post.',
  'recycle.restoreSuccess': 'Restored {label}; it is back in the article list. Restoring is handled as a post update: pipelines bound to post updates will run, and the front-end cache and the total word count are refreshed.',
  'recycle.purgeSuccess': 'Deleted {label} forever. This cannot be undone; the total word count and the front-end cache are refreshed accordingly.',
  'recycle.draftRestoreSuccess': 'Restored the draft {label}; it is back in the draft list. If it had been published, the published post is unaffected and this is only the pre-publication draft.',
  'recycle.draftPurgeSuccess': 'Deleted the draft {label} forever. This cannot be undone.',
  'recycle.actionRestore': 'restore',
  'recycle.actionPurge': 'delete forever',
  'recycle.actionFallback': 'act on',
  'recycle.labelArticle': 'post',
  'recycle.labelDraft': 'draft',
  'recycle.labelFallback': 'item',
  'recycle.listFailure404': 'This server does not have the recycle-bin endpoints yet (404). Upgrade the server to a version that includes the post recycle bin, then use this list.',
  'recycle.detailWrap': ' ({message})',
  'recycle.listFailureGeneric': 'The recycle bin list failed to load{detail}. Please try again later; this does not affect anything else in the article list.',
  'recycle.actionFailure404': 'That {label} is no longer in the recycle bin (it may have just been restored or deleted forever). The list will refresh to the latest state.',
  'recycle.permissionWrap': ' (requires {permission})',
  'recycle.actionFailure403': 'Your account is not allowed to {action} this {label}{permission}. Please ask an administrator.',
  'recycle.actionFailure401': 'Your session has expired. Please sign in again and try once more.',
  'recycle.actionFailureGeneric': 'Could not complete this action{detail}. Please try again later.',


  // ── 🔴 期 3 第三批（41 keys）── 英文人工写；🔴 一律不用缩写（ICU 把单引号当转义符）。
  'common.colName': 'Name',
  'common.colContent': 'Content',
  'common.colOption': 'Actions',
  'sysconf.token.deleteConfirmBody': 'Delete this token?',
  'common.deleteSuccess': 'Deleted',
  'common.delete': 'Delete',
  'sysconf.token.title': 'API tokens',
  'sysconf.token.createTitle': 'New API token',
  'common.create': 'New',
  'sysconf.token.swaggerOffWithDocs': 'The live API documentation (swagger) is off by default: set VANBLOG_SWAGGER=true and restart to enable it. The API documentation in the repository has been opened for you instead.',
  'sysconf.token.swaggerOff': 'The live API documentation (swagger) is off by default: set VANBLOG_SWAGGER=true and restart to enable it.',
  'sysconf.token.apiDocs': 'API documentation',
  'sysconf.token.helpTitle': 'About API tokens',
  'sysconf.token.helpP1': 'An API token created here can be used to call the VanBlog API',
  'sysconf.token.helpP2': 'Combined with the API documentation, quite a lot of interesting things become possible.',
  'sysconf.token.helpP3': 'The API documentation is still thin and will improve over time; an API Playground is planned.',
  'sysconf.token.helpP4': 'PS: building your own front end on top of the API is not necessary for now — a theme system (with full documentation and a development guide, not tied to any particular stack) is planned, and building on that will be the better route.',
  'sysconf.advance.loginCard': 'Sign-in security',
  'sysconf.advance.retryLockedAlert': 'The maximum sign-in failure limit is not stable enough yet, so it cannot be configured for now. It will be opened up once it is.',
  'sysconf.advance.demoBlockedLogin': 'The sign-in security policy cannot be changed on the demo site',
  'sysconf.advance.maxRetryLabel': 'Enable the maximum sign-in failure limit',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',
  'sysconf.advance.maxRetryTooltip': 'On unless the setting explicitly turns it off: after 5 consecutive failed sign-ins from one visitor IP, that IP has to wait 5 minutes before trying again (server default; this field is locked in the UI)',
  'sysconf.advance.expiresInLabel': 'Session token lifetime (seconds)',
  'sysconf.advance.expiresInPlaceholder': 'Defaults to 7 days',
  'sysconf.advance.expiresInTooltip': 'Defaults to 7 days. Minimum 60 seconds: this value goes straight into the JWT expiresIn, and 0 or a negative number would make every issued token expire immediately (sign-in appears to succeed, then the next request bounces back to the sign-in page), so the form clamps it here.',
  'sysconf.advance.isrCard': 'Static page refresh policy',
  'sysconf.advance.demoBlockedIsr': 'The static page refresh policy cannot be changed on the demo site',
  'sysconf.advance.isrModeDelay': 'On a timer',
  'sysconf.advance.isrModeOnDemand': 'On demand',
  'sysconf.advance.isrModeTooltip': 'Defaults to "On demand": the server triggers a re-render as soon as something changes in the admin panel — more up to date, but possibly more work for the server. Choose "On a timer" to rebuild periodically using the number of seconds below.',
  'sysconf.advance.delayLabel': 'Timer interval (seconds)',
  'sysconf.advance.delayTooltip': 'Only used in "On a timer" mode: every this many seconds the front end tries to regenerate the static pages from the latest server data.\n\nThe front end clamps this value to a minimum of 60 seconds (anything smaller is treated as 60), and a non-numeric value is ignored rather than failing the build.\n\nThe default "On demand" mode ignores this value: the server triggers a re-render when a post changes, and there is a 24-hour safety cycle so a lost trigger heals itself.',
  'sysconf.advance.isrManualCard': 'Trigger a static page refresh manually',
  'sysconf.advance.isrManualAlert': 'You normally do not need this, but in some situations you can trigger an incremental re-render yourself. The server will try to revalidate and re-render every known route (it takes a little while to take effect).',
  'sysconf.advance.isrManualOk': 'Incremental re-render triggered',
  'sysconf.advance.isrManualFail': 'Could not trigger the re-render',
  'sysconf.advance.isrManualBtn': 'Trigger now',


  // ── 🔴 期 3 第四批（19 keys）── 英文人工写；🔴 不用缩写（ICU 把单引号当转义符）。
  'common.colUsername': 'Username',
  'common.colNickname': 'Nickname',
  'common.colPermissions': 'Permissions',
  'sysconf.user.collaboratorUpdated': 'Collaborator updated',
  'common.edit': 'Edit',
  'common.deleteConfirmTitle': 'Confirm deletion',
  'sysconf.user.collaboratorDeleteConfirm': 'Delete this collaborator?',
  'sysconf.user.cardTitle': 'Account',
  'sysconf.user.updateOk': 'Account updated. Please sign in again.',
  'sysconf.user.usernameLabel': 'Sign-in username',
  'sysconf.user.usernamePlaceholder': 'Enter the sign-in username',
  'sysconf.user.passwordLabel': 'Sign-in password',
  'sysconf.user.passwordPlaceholder': 'Enter the sign-in password',
  'sysconf.user.collaboratorCard': 'Collaborators',
  'sysconf.user.collaboratorCreated': 'Collaborator created',
  'sysconf.user.helpTitle': 'About collaborators',
  'sysconf.user.helpP1': 'You can add collaborator accounts with specific permissions.',
  'sysconf.user.helpP2': 'By default a collaborator can view and upload posts, drafts and images; every other permission has to be granted explicitly.',
  'sysconf.user.helpP3': 'After signing in, a collaborator sees a reduced admin panel (unless they have every permission), and any endpoint they are not allowed to call returns an error.',


  // ── 🔴 期 3 第五批（32 keys）── 英文人工写；🔴 不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ `introPrefix` / `introSuffix` 是"文本 + 链接 + 文本"拆开的一对：英文靠它们各自成句来保住语序
  //    （渲染结果 = "VanBlog uses Caddy to issue certificates automatically, on demand."）。
  'sysconf.caddy.changedOk': 'Saved. The page will reload with the new protocol automatically.',
  'sysconf.caddy.updateFailed': 'Could not update the setting',
  'sysconf.caddy.card': 'HTTPS settings',
  'sysconf.caddy.introPrefix': 'VanBlog uses',
  'sysconf.caddy.introSuffix': 'to issue certificates automatically, on demand.',
  'common.relatedDocs': 'Related documentation',
  'sysconf.caddy.advancedHint': 'Advanced users can use the buttons below to inspect the Caddy runtime log or its configuration when troubleshooting.',
  'sysconf.caddy.accessLogHint': 'The access log is inside the container at /var/log/vanblog-access.log',
  'sysconf.caddy.portsHint': 'Make sure ports 80 and 443 are open.',
  'sysconf.caddy.firstVisitHint': 'The first time a domain is visited over https, a certificate is requested automatically if there is none yet. You can also use the button below to trigger a certificate request yourself.',
  'sysconf.caddy.stableHint': 'Once things are stable you can turn on the automatic https redirect: http requests will then be redirected to https. After enabling it, open http://your-domain in a private window to confirm the redirect happens; you can also open "View Caddy config" and check that the srv1 listener_wrappers contains http_redirect.',
  'sysconf.caddy.reverseProxyWarn': 'If you reverse-proxy port 80 yourself, do not enable the automatic https redirect — your proxy may stop working.',
  'sysconf.caddy.stuckPrefix': 'If you enabled this option by accident and cannot turn it off again, see:',
  'sysconf.caddy.stuckLink': 'Cannot turn off the https redirect after enabling it',
  'sysconf.caddy.demoBlocked': 'This option cannot be changed on the demo site, otherwise the k8s ingress might break',
  'sysconf.caddy.noChange': 'Nothing changed, so there is nothing to save',
  'sysconf.caddy.confirmOff': 'Turn off the automatic https redirect? The site will be reachable over http again. Two seconds after you confirm, the page switches to http automatically.',
  'sysconf.caddy.confirmOn': 'Before enabling the automatic https redirect, make sure the site really works over https with your domain name — once it is on, http access stops working. Two seconds after you confirm, the page switches to https automatically. If you reverse-proxy port 80 yourself, do not enable this.',
  'sysconf.caddy.configTitle': 'Caddy configuration',
  'sysconf.caddy.configError': 'Could not read the Caddy configuration',
  'sysconf.caddy.viewConfig': 'View Caddy config',
  'sysconf.caddy.logTitle': 'Caddy runtime log',
  'sysconf.caddy.logError': 'Could not read the Caddy log',
  'sysconf.caddy.viewLog': 'View Caddy log',
  'sysconf.caddy.clearLogConfirm': 'Clear the Caddy runtime log? This cannot be undone.',
  'sysconf.caddy.clearLogOk': 'Caddy runtime log cleared',
  'sysconf.caddy.clearLog': 'Clear Caddy log',
  'sysconf.caddy.triggerCertTitle': 'Trigger an on-demand certificate request',
  'sysconf.caddy.triggerCertContent': 'A new window will open and load the current address over https, which triggers the on-demand certificate request. Give it a moment (how long it takes depends on the network); once the certificate is issued, the page that opened will load normally over https.',
  'sysconf.caddy.triggerCertBtn': 'Trigger a request using the current domain',
  'sysconf.caddy.redirectLabel': 'Automatic https redirect',
  'sysconf.caddy.redirectTooltip': 'When on, http requests to this site are redirected to https automatically',

};
