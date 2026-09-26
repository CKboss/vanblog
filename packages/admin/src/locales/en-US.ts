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
  'common.unknownSize': 'unknown size',

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
  'common.colCategory': 'Category',
  'common.colTags': 'Tags',
  'recycle.colUpdatedAt': 'Updated',
  'recycle.colDeletedAt': 'Deleted',
  'recycle.restore': 'Restore',
  'recycle.purge': 'Delete forever',
  'recycle.noPermission': 'Your account has no permission for this action',
  'common.colAuthor': 'Author',
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
  // 🔴 保留 ISR 这个缩写：中文文案里有它，而它是**技术标识符**（用户在文档/日志里看到的就是 ISR）
  //    —— 上一版翻成 "Incremental re-render" 把缩写丢了，被"数字与技术标识符三份一致"那条守卫抓到。
  'sysconf.advance.isrManualOk': 'ISR re-render triggered',
  'sysconf.advance.isrManualFail': 'Could not trigger the ISR re-render',
  'sysconf.advance.isrManualBtn': 'Trigger now',


  // ── 🔴 期 3 第四批（19 keys）── 英文人工写；🔴 不用缩写（ICU 把单引号当转义符）。
  'common.colUsername': 'Username',
  'common.colNickname': 'Nickname',
  'common.colPermissions': 'Permissions',
  'sysconf.user.collaboratorUpdated': 'Collaborator updated',
  'common.edit': 'Edit',
  'common.editPost': 'Edit',
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
  // 🔴 "2 seconds" 用数字而不是 "Two seconds"：中文写的是「2 秒」，而数字是**契约**（守卫按数字多重集比对）。
  //    UI 文案里用数字也更符合"倒计时"的语感。
  'sysconf.caddy.confirmOff': 'Turn off the automatic https redirect? The site will be reachable over http again. 2 seconds after you confirm, the page switches to http automatically.',
  'sysconf.caddy.confirmOn': 'Before enabling the automatic https redirect, make sure the site really works over https with your domain name — once it is on, http access stops working. 2 seconds after you confirm, the page switches to https automatically. If you reverse-proxy port 80 yourself, do not enable this.',
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
  // 🔴 HTTPS 全大写：zh-CN 的标签就是 'HTTPS 自动重定向'，缩写大小写属于"必须原样保留的技术标识符"
  'sysconf.caddy.redirectLabel': 'Automatic HTTPS redirect',
  'sysconf.caddy.redirectTooltip': 'When on, http requests to this site are redirected to https automatically',


  // ── 🔴 期 4（106 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ 备案（ICP / 公安）是**中国大陆特有**的制度，英文按功能直译成 registration number/URL，
  //    并保留 "ICP" 这个专有名词；🔴 不要意译成 "license" 之类（那是另一种东西）。
  'siteInfo.author.label': 'Author name',
  'siteInfo.author.placeholder': 'Enter the author name',
  'siteInfo.authorDesc.label': 'Author bio',
  'siteInfo.authorDesc.placeholder': 'Enter the author bio',
  'siteInfo.authorLogo.label': 'Author logo',
  'siteInfo.authorLogo.placeholder': 'Enter the author logo URL',
  'siteInfo.authorLogoDark.label': 'Author logo (dark mode)',
  'siteInfo.authorLogoDark.placeholder': 'Enter the dark-mode author logo URL; leave empty to keep the previous one',
  'siteInfo.siteLogo.label': 'Site logo',
  'siteInfo.siteLogo.placeholder': 'Enter the site logo URL',
  'siteInfo.siteLogoDark.label': 'Site logo (dark mode)',
  'siteInfo.siteLogoDark.placeholder': 'Enter the dark-mode site logo URL; leave empty to keep the previous one',
  'siteInfo.favicon.label': 'Site icon (favicon)',
  'siteInfo.favicon.placeholder': 'Enter the site icon URL',
  'siteInfo.siteName.label': 'Site name',
  'siteInfo.siteName.placeholder': 'Enter the site name',
  'siteInfo.siteDesc.label': 'Site description',
  'siteInfo.siteDesc.placeholder': 'Enter the site description',
  'siteInfo.payAliPay.label': 'Alipay image URL',
  'siteInfo.payAliPay.placeholder': 'Enter the Alipay tip image URL; leave empty to disable tips',
  'siteInfo.payAliPayDark.label': 'Alipay image URL (dark mode)',
  'siteInfo.payAliPayDark.placeholder': 'Enter the dark-mode Alipay tip image URL; leave empty to keep the previous one',
  'siteInfo.payWechat.label': 'WeChat Pay image URL',
  'siteInfo.payWechat.placeholder': 'Enter the WeChat Pay tip image URL; leave empty to disable tips',
  'siteInfo.payWechatDark.label': 'WeChat Pay image URL (dark mode)',
  'siteInfo.payWechatDark.placeholder': 'Enter the dark-mode WeChat Pay tip image URL; leave empty to keep the previous one',
  'siteInfo.baseUrl.label': 'Site URL',
  'siteInfo.baseUrl.placeholder': 'Enter the full URL, including the protocol',
  'siteInfo.baseUrl.tooltip': 'Enter the full URL, including the protocol. This URL is used to generate the data for the front end, the admin panel and the RSS feed.',
  'siteInfo.copyrightAggreement.label': 'Copyright license',
  'siteInfo.beianNumber.label': 'ICP registration number',
  'siteInfo.beianNumber.placeholder': 'Enter the registration number; leave empty to hide it',
  'siteInfo.beianUrl.label': 'ICP registration URL',
  'siteInfo.beianUrl.placeholder': 'Enter the registration URL; leave empty to hide it',
  'siteInfo.gaBeianNumber.label': 'Public security registration number',
  'siteInfo.gaBeianNumber.placeholder': 'Enter the public security registration number; leave empty to hide it',
  'siteInfo.gaBeianUrl.label': 'Public security registration URL',
  'siteInfo.gaBeianUrl.placeholder': 'Enter the URL the registration number links to; leave empty for no link',
  'siteInfo.gaBeianLogoUrl.label': 'Public security registration logo URL',
  'siteInfo.gaBeianLogoUrl.placeholder': 'Enter the logo URL for the public security registration; leave empty to hide it',
  'siteInfo.enableComment.label': 'Enable the comment system',
  'siteInfo.enableComment.tooltip': 'On by default',
  'siteInfo.since.label': 'Site launch date',
  'siteInfo.since.placeholder': 'Defaults to now if left empty',
  'siteInfo.articlesPerPage.label': 'Posts per page',
  'siteInfo.articlesPerPage.tooltip': 'How many posts to show per page on the front page and on /page/n. Defaults to 5, range 1 to 50. Category, tag and timeline pages still list everything.',
  'siteInfo.uiStyle.label': 'Visual style',
  'siteInfo.uiStyle.placeholder': 'Apple style',
  'siteInfo.uiStyle.tooltip': 'The visual style of the front-end pages. The Apple style follows developer.apple.com/news: a single-column list separated by hairlines, the SF Pro typeface, 17px body text, a frosted-glass navigation bar, an Apple-blue accent colour, and automatic dark-mode support. It changes the styling only, not the structure, and you can switch back to the default at any time. Besides the two built-in styles, this list also shows the custom themes uploaded under "System settings - Themes" (use that tab to upload and manage them).',
  'siteInfo.uiStyle.apple': 'Apple style (recommended)',
  'siteInfo.uiStyle.default': 'Default (the original card style)',
  'siteInfo.showSubMenu.label': 'Show the category navigation bar',
  'common.hide': 'Hidden',
  'common.show': 'Shown',
  'siteInfo.showSubMenu.tooltip': 'Hidden by default. When on, a second navigation bar with the categories appears below the main one (a two-level navigation bar, really).',
  'siteInfo.subMenuOffset.label': 'Category bar left offset (px)',
  'siteInfo.subMenuOffset.tooltip': 'When the navigation bar shows the site name, set the offset so the first character of a category lines up with it.',
  'siteInfo.headerLeftContent.label': 'What to show on the left of the navigation bar',
  'siteInfo.headerLeftContent.siteLogo': 'Site logo',
  'siteInfo.headerLeftContent.siteName': 'Site name',
  'siteInfo.headerLeftContent.tooltip': 'Showing the site logo requires a correct site logo to be set first. Defaults to the site name.',
  'siteInfo.showAdminButton.label': 'Show the admin panel button',
  'siteInfo.showAdminButton.tooltip': 'Shown by default; when off, the front end hides the admin panel button',
  'siteInfo.showDonateInfo.label': 'Show the donation information',
  'siteInfo.showDonateInfo.tooltip': 'Shown by default; when off, the about page hides the donation information',
  'siteInfo.showCopyRight.label': 'Show the copyright notice',
  'siteInfo.showCopyRight.tooltip': 'Shown by default; when off, post pages do not show the copyright notice',
  'siteInfo.showDonateButton.label': 'Show the tip button',
  'siteInfo.showDonateButton.tooltip': 'Shown by default (provided the Alipay and WeChat Pay images are set); when off, no tip button is shown anywhere',
  'siteInfo.showDonateInAbout.label': 'Show the tip button on the about page',
  'siteInfo.showDonateInAbout.tooltip': 'Hidden by default; when on, the about page shows the tip button',
  'siteInfo.defaultTheme.label': 'Default front-end theme mode',
  'siteInfo.defaultTheme.placeholder': 'Automatic',
  'siteInfo.defaultTheme.dark': 'Dark mode',
  'siteInfo.defaultTheme.light': 'Light mode',
  'siteInfo.defaultTheme.tooltip': 'Visitors seeing the front end for the first time will start in this theme mode',
  'siteInfo.allowOpenHiddenPostByUrl.label': 'Allow opening hidden posts by URL',
  'common.disallow': 'Not allowed',
  'common.allow': 'Allowed',
  'siteInfo.allowOpenHiddenPostByUrl.tooltip': 'Not allowed by default; when on, hidden posts can be opened by URL.',
  'siteInfo.enableCustomizing.label': 'Enable the customizing feature',
  'siteInfo.enableCustomizing.tooltip': 'On by default. When off, custom CSS, Script and HTML set through the customizing panel have no effect.',
  'siteInfo.showRSS.label': 'Show the RSS button',
  'siteInfo.showRSS.tooltip': 'Shown by default; when off, the RSS button is hidden everywhere.',
  'siteInfo.defaultExpandAllCategories.label': 'Expand all categories by default on the category page',
  'siteInfo.defaultExpandAllCategories.placeholder': 'Collapsed by default',
  'siteInfo.defaultExpandAllCategories.true': 'Expanded by default',
  'siteInfo.defaultExpandAllCategories.tooltip': 'Collapsed by default, the same as before the upgrade. When on, every category is expanded when a visitor opens the front-end category list. Single-category pages, tag pages and the timeline are not affected. Visitors can still click a category row or use "Expand all / Collapse all" to switch temporarily.',
  'siteInfo.openArticleLinksInNewWindow.label': 'Default behaviour when a visitor clicks a link',
  'siteInfo.openArticleLinksInNewWindow.placeholder': 'Navigate in the current page',
  'siteInfo.openArticleLinksInNewWindow.true': 'Open in a new tab',
  'siteInfo.openArticleLinksInNewWindow.tooltip': 'Navigating in the current page is the default and applies to most links except the navigation bar. Note that opening a new tab is less smooth, while navigating in the current page feels seamless.',
  'siteInfo.showExpirationReminder.label': 'Show the outdated-content reminder on posts',
  'siteInfo.showExpirationReminder.tooltip': 'Shown by default; when off, post pages do not show the expired-content reminder.',
  'siteInfo.showEditButton.label': 'Show the edit button on the front end',
  'siteInfo.showEditButton.tooltip': 'On by default. When off, the front end no longer shows the edit button while you are signed in to the admin panel.',
  'siteInfo.friendLinkIntro.label': 'Friend-links page introduction',
  'siteInfo.friendLinkIntro.placeholder': 'These are the friend links of this site, in no particular order:',
  'siteInfo.friendLinkIntro.tooltip': 'The introduction above the friend-link list. Leave empty to keep the default text from before the upgrade.',
  'siteInfo.friendLinkApplyContent.label': 'Friend-links page footer',
  'siteInfo.friendLinkApplyContent.placeholder': 'Leave empty to use the default application requirements and site details',
  'siteInfo.friendLinkApplyContent.tooltip': 'The Markdown below the friend-link list. Leave empty to keep the application requirements from before the upgrade. The placeholders {{siteName}}, {{description}}, {{url}} and {{logo}} insert this site details.',
  'siteInfo.aboutTitle.label': 'About-page title',
  'siteInfo.aboutTitle.placeholder': 'About me',
  'siteInfo.aboutTitle.tooltip': 'The title of the front-end about page. Leave empty for "About me". The body of the about page is still edited through "Edit about" in the post list, not through this setting.',
  'siteInfo.uiStyle.customSuffix': ' (custom, {id})',


  // ── 🔴 期 5 第一批（31 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ 文案里提到的后台界面词按**目标语言**写（父代理裁定：向前一致）：图片管理 = "Images"（沿用 menu.img 的英文），
  //    补缩略图 = "Add thumbnails"，检测隐写水印 = "Detect steganographic watermark"。
  //    🔴 那两个界面此刻还没接 i18n（Static/img 是下一批）⇒ 在 en-US 下会出现"英文说明指向尚未翻译的按钮"，
  //    这是**已知且有意**的中间状态（与评论设置页签那 7 英 4 中同类），不是漏翻。
  'watermark.demoBlocked': 'This setting cannot be changed on the demo site',
  'watermark.needText': 'A watermark text is required when the visible watermark is on',
  'watermark.enableWebp.label': 'Automatic image compression',
  'watermark.enableWebp.placeholder': 'Whether to compress uploaded images automatically',
  'watermark.enableWebp.tooltip': 'When on, uploaded images are compressed to the chosen format so pages load faster, whichever storage backend is in use. Only new uploads are affected; existing files are not rewritten.',
  'watermark.compressFormat.label': 'Compression format',
  'watermark.compressFormat.webp': 'WebP (default)',
  'watermark.compressFormat.placeholder': 'Choose the output format',
  'watermark.compressFormat.tooltip': 'Only used when automatic compression is on. AVIF is usually smaller than WebP and is widely supported by modern browsers. Encoding prefers sharp (the same version the front end uses, see package.json); if the official Alpine image cannot load the musl build of sharp, avifenc from libavif-apps is used instead.',
  'watermark.enableWaterMark.label': 'Visible watermark',
  'watermark.enableWaterMark.placeholder': 'Whether to add a visible watermark',
  'watermark.enableWaterMark.tooltip': 'A visible text watermark (off by default, since many people find it gets in the way of the image). When on, every uploaded image gets one, whichever image host is used. The default style tiles small rotated text across the whole image so it cannot be cropped away; the style and position are set by the server environment variables VANBLOG_WATERMARK_STYLE and VANBLOG_WATERMARK_POSITION, not by this form. Images whose shorter edge is under 52px are skipped (the server logs a WARN and the image is still uploaded). If you want a watermark that is invisible yet verifiable, use the steganographic watermark below.',
  'watermark.waterMarkText.label': 'Visible watermark text',
  'watermark.waterMarkText.tooltip': 'The watermark text. It may contain dots (for example a domain name) and Chinese characters are supported (rendering happens on the server, and the official image ships Latin plus Chinese fonts). Longer text needs a larger image: the font size is derived from the image dimensions and shrinks automatically when the text does not fit; if it still does not fit at 8px the image is skipped (a WARN is logged and the upload is unaffected).',
  'watermark.waterMarkText.placeholder': 'Enter the watermark text',
  'watermark.enableResize.label': 'Automatic downscaling of large images',
  'watermark.enableResize.placeholder': 'Whether to scale down oversized images',
  'watermark.enableResize.tooltip': 'When on, images whose longest edge exceeds the limit below are scaled down proportionally at upload time (only ever down, never up; small images are left alone). Scaling happens before compression and before the steganographic watermark, so the watermark can still be read. Only new uploads are affected.',
  'watermark.maxImageEdge.label': 'Longest edge limit',
  'watermark.maxImageEdge.tooltip': 'In pixels. 1920 is what people usually mean by 1080p; 0 means no limit; values below 320 are raised to 320.',
  'watermark.enableThumb.label': 'Generate thumbnails',
  'watermark.enableThumb.placeholder': 'Whether to generate thumbnails',
  'watermark.enableThumb.tooltip': 'An extra small image is generated at upload time (a 300px-wide WebP by default, about 10KB). The "Images" list loads that instead of the original, which makes paging through dozens of images much faster. Existing images can be backfilled in one go under "Images - Add thumbnails".',
  'watermark.thumbWidth.label': 'Thumbnail width',
  'watermark.thumbWidth.tooltip': 'In pixels, 300 by default. Changing it only affects thumbnails generated afterwards.',
  'watermark.enableStegoWaterMark.label': 'Steganographic watermark',
  'watermark.enableStegoWaterMark.placeholder': 'Whether to embed a steganographic watermark',
  'watermark.enableStegoWaterMark.tooltip': 'Hides a piece of text in the pixels (the brightness of each 8x8 block moves by at most 4 levels, which the eye cannot see) and it can still be read after the image is compressed to WebP or re-saved as JPEG by someone else. To verify: right-click an image in the Images list and choose "Detect steganographic watermark", or use "Detect watermark" in the toolbar to upload one. Note that it cannot be read any more once the image has been scaled or cropped, and GIFs are not processed.',
  'watermark.stegoWaterMarkText.label': 'Hidden payload',
  'watermark.stegoWaterMarkText.tooltip': 'Leave empty to write "domain | uploader | upload time" automatically, which makes it easy to trace who uploaded what and when. At most 200 bytes; Chinese characters are supported. The longer the payload, the larger the image has to be (images that are too small are skipped, and the upload is unaffected).',
  'watermark.stegoWaterMarkText.placeholder': 'Leave empty to use the default payload',


  // ── 🔴 期 5 第一批（同轮追加，13 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ `picgo` / `picgoConfig` / `OSS` / `s3` 是**技术标识符**，三份包都必须原样保留（生成脚本已比对）。
  'storage.demoBlocked': 'The image-host configuration cannot be changed on the demo site',
  'storage.picgoJsonInvalid': 'picgoConfig is not valid JSON and could not be parsed',
  'storage.storageType.label': 'Storage backend',
  'storage.storageType.placeholder': 'Choose a storage backend',
  'storage.storageType.local': 'Local storage',
  'storage.storageType.picgo': 'OSS image host',
  'storage.storageType.tooltip': 'Before choosing local storage, make sure the directory is mapped to a persistent volume, otherwise images can be lost',
  'storage.picgoConfig.label': 'picgo configuration',
  'storage.picgoConfig.tooltip': 'The OSS image host backend uses picgo',
  'storage.picgoConfig.placeholder': 'Enter the picgo configuration (JSON)',
  'storage.picgoPlugins.label': 'Custom picgo plugins',
  'storage.picgoPlugins.tooltip': 'Enter plugin names (for example s3), separated by commas',
  'storage.picgoPlugins.placeholder': 'Ignore this if you are not sure',


  // ── 🔴 期 5 第二批（70 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    🔴 计数句一律用 **ICU plural**（`{count, plural, one {# post} other {# posts}}`）：
  //    `img.refPopoverTitle` / `img.refCount` / `img.totalCount` / `img.backfillDone` 四条都是"占位符紧跟复数名词"，
  //    不用 plural 会渲染出 "1 posts"，而且会被复数约定守卫点名。
  //    ⚠️ zh-CN / zh-TW 保持 `{count} 篇` 这种形状（汉语没有复数变化，加了只会让文案变丑）。
  'img.detectFoundTitle': 'Found a steganographic watermark from this site:',
  'img.detectMeta': 'Size {width}×{height}, repetition {repetition}, uncertain bits {uncertain}',
  'img.detectNoneTitle': 'No watermark from this site was found.',
  'img.detectNoneReasons': 'Common reasons: the image was not uploaded here; the steganographic watermark was off when it was uploaded; the image has been scaled or cropped; or the site watermark key has changed.',
  'img.detectTitle': 'Watermark check: {name}',
  'img.detectFailed': 'Detection failed',
  'img.backfillConfirmTitle': 'Generate thumbnails for every image?',
  'img.backfillConfirmContent': 'Images that already have a thumbnail are skipped, and only locally stored images are processed. This can take a while when there are many images.',
  'img.backfillDone': '{total, plural, one {# image} other {# images}} in total: {generated} generated, {existed} already existed, {skipped} skipped, {failed} failed',
  'img.backfillFailed': 'Could not add the thumbnails',
  'img.deleteOkOss': 'Deleted. Note that it was not removed from the OSS bucket.',
  'img.deleteOkLocal': 'Deleted permanently',
  'img.deleteFailed': 'Could not delete',
  'img.replaceConfirmTitle': 'Replace this image?',
  'img.replaceConfirmP1': 'The link stays the same, and references in posts point to the new image automatically:',
  'img.replaceConfirmP2': 'The new file goes through the same scaling, steganographic watermark and compression, and a new thumbnail is generated. The previous content cannot be recovered.',
  'img.replaceOk': 'Replaced. The link did not change.',
  'img.replaceFailed': 'Could not replace the image',
  'img.infoTitle': 'Image details',
  'img.deleteConfirmTitle': 'Delete this image? This cannot be undone.',
  'img.refsTitle': 'Posts referencing this image',
  'img.refsColId': 'Post ID',
  'common.colTitle': 'Title',
  'img.colImage': 'Image',
  'img.colFormat': 'Format',
  'img.colDimensions': 'Dimensions',
  'img.colBytes': 'Size',
  'img.colUploadedAt': 'Uploaded',
  'img.colRefs': 'Referenced by',
  'img.notReferenced': 'Not referenced',
  'img.refPopoverTitle': 'Referenced by {count, plural, one {# post} other {# posts}}',
  'img.refArticleFallback': 'Post {id}',
  'img.refMore': '…and {count} in total',
  'img.refCount': '{count, plural, one {# post} other {# posts}}',
  'img.actCopyLink': 'Copy link',
  'common.download': 'Download',
  'img.actReplace': 'Replace',
  'img.actDetect': 'Detect watermark',
  'img.pageTip': 'The settings page is where you change the image storage backend, scaling and watermarks. Right-click an image for more actions, including the steganographic watermark check.',
  'img.viewThumb': 'Small',
  'img.viewLarge': 'Large',
  'img.viewList': 'List',
  'img.backfillBtn': 'Add thumbnails',
  'img.clipboardEmpty': 'There is no image on the clipboard',
  'img.clipboardBtn': 'Upload from clipboard',
  'img.clipboardNew': 'Clipboard image uploaded. ',
  'img.clipboardExists': 'The clipboard image already existed. ',
  'img.uploadBtn': 'Upload images',
  'img.uploadNew': '{name} uploaded. ',
  'img.uploadExists': '{name} already existed. ',
  'img.menuCopyMarkdown': 'Copy Markdown link',
  'img.menuCopyMarkdownAbs': 'Copy the full Markdown link',
  'img.menuInfo': 'Details',
  'img.menuSearchRefs': 'Find posts referencing it',
  'img.menuDetectStego': 'Detect steganographic watermark',
  'img.menuReplace': 'Replace image',
  'img.empty': 'No images yet, upload one',
  'img.totalCount': '{total, plural, one {# image} other {# images}}',
  'img.copiedMarkdown': '{prefix}The Markdown link is on the clipboard.',
  'img.copiedLink': '{prefix}The image link is on the clipboard.',
  'img.copyFailed': '{prefix}Could not copy the link to the clipboard.',
  'img.meta.height': 'Height',
  'img.meta.width': 'Width',
  'img.meta.storageType': 'Storage',
  'img.meta.url': 'External URL',
  'img.meta.thumb': 'Thumbnail',
  'img.meta.thumbWidth': 'Thumbnail width',
  'img.meta.thumbHeight': 'Thumbnail height',
  'img.meta.local': 'Local',


  // ── 🔴 期 5 第二批（同轮追加，2 keys）：ObjTable column headers ──
  'common.colProperty': 'Property',
  'common.colValue': 'Value',


  // ── 🔴 期 5 第三批（36 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ 帮助文案是**片段**：每个片段都要能在 JSX 的顺序里拼成通顺英文
  //    （例如 helpP4a + <code>/static/...</code> + helpP4b + <code>/c/uptime/</code> + helpP4c + …）。
  'customPage.type': 'Type',
  'customPage.typeFile': 'Single-file page',
  'customPage.typeFolder': 'Multi-file page',
  'customPage.colPath': 'Path',
  'customPage.editContent': 'Edit content',
  'customPage.fileManager': 'Manage files',
  'common.view': 'View',
  'common.editInfo': 'Edit details',
  'customPage.demoBlocked': 'This cannot be changed on the demo site',
  'customPage.deleteConfirmBody': 'Delete this custom page?',
  'customPage.helpP1a': 'A custom page mounts static content under',
  'customPage.helpPathSample': '/c/<path>/',
  // 🔴 片段式翻译的代价：`{helpP1a} <code>/c/<path>/</code> {' '} {helpP1b}` 拼出来的英文
  //    第一版是 "…under /c/<path>/ It is not general-purpose app hosting." —— 🔴 **少了一个句读**
  //    （中文那边 P1b 以「下，」开头所以看不出来）。用破折号接上，读起来才是一句话。
  'customPage.helpP1b': '— it is not general-purpose app hosting.',
  'customPage.helpP2': 'There are two kinds: a single-file page (edit one HTML document in the admin panel) and a multi-file page (upload static HTML/CSS/JS files).',
  'customPage.helpP3a': 'A multi-file page served at',
  'customPage.helpP3b': 'reads',
  // 🔴 同上，这一处是**少了一个空格**：JSX 里 `{helpP3b}` 与 `<strong>` 之间没有 `{' '}`
  //    （中文「时读取根目录的 index.html」本来就不需要空格 ⇒ 不能为了英文去改 JSX，那会动中文渲染结果）
  //    ⇒ 把空格放在**英文片段的开头**（zh-CN / zh-TW 都没有这个前导空格，逐字对账仍然成立）。
  'customPage.helpP3strong': ' index.html in the root of that folder',
  'customPage.helpP3c': '. Make sure it is visible at the top level of the file tree, without an extra folder left over from unzipping.',
  'customPage.helpP4a': 'A React or Vue SPA whose assets are written as',
  'customPage.helpP4b': '(a site-root path) usually shows a blank page when placed under',
  // 🔴 第三处同类缺陷：JSX 在 `<code>/c/uptime/</code>` 与这个片段之间放了一个 `{' '}`，
  //    所以以 '.' 开头会渲染成 "/c/uptime/ ."（**句号前多一个空格**）。
  //    不能为了英文去删那个空格（中文渲染结果会变）⇒ 让片段以破折号开头，空格就变成正常的插入语分隔。
  'customPage.helpP4c': '— use relative paths instead (such as',
  'customPage.helpP4d': '), or set homepage / base to',
  'customPage.helpP4e': 'at build time. If you need a backend or a separate domain, use a reverse proxy instead of putting the whole project into a custom page.',
  'customPage.createdOk': 'Created',
  'customPage.modalEditTitle': 'Edit custom page',
  'customPage.modalCreateTitle': 'New custom page',
  'customPage.pathMustStartSlash': 'The path must start with a slash',
  'customPage.pathMustBeSingleLevel': 'The path must have a single level, for example /uptime (which maps to /c/uptime/); do not use /foo/bar',
  'customPage.createAlert': 'After creating it, edit the content or upload files from the list. A multi-file page only hosts static HTML/CSS/JS and its entry point must be index.html in the root folder (the path /uptime maps to /c/uptime/). React build output that references /static/... absolute paths usually does not open; use relative paths or a reverse proxy.',
  'customPage.typeTooltip': 'Single file: edit one HTML document in the admin panel. Multi-file: upload static HTML/CSS/JS files; Node or PHP backends are not supported. For an SPA use relative asset paths and make sure the root folder has index.html.',
  'customPage.typePlaceholder': 'Choose a type',
  'customPage.namePlaceholder': 'Enter a name',
  'customPage.nameTooltip': 'The name of the custom page',
  'customPage.pathPlaceholder': 'For example /uptime',
  'customPage.pathTooltip': 'Must start with / and have a single level, for example /uptime. The real address is /c plus the path, i.e. /c/uptime/. A multi-file page reads index.html from that folder.',


  // ── 🔴 期 5 第四批（21 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ `Sign-in status`（登录状态）与 `Result`（流水线结果）是**两个不同的列**，别混成一个词。
  'log.system': 'System log',
  'log.pipeline': 'Pipeline log',
  'log.login': 'Sign-in log',
  'common.colIndex': 'No.',
  'log.colLoginTime': 'Sign-in time',
  'log.colLoginAddress': 'Sign-in address',
  'log.colLoginIp': 'Sign-in IP',
  'log.colLoginDevice': 'Device',
  'log.colLoginStatus': 'Sign-in status',
  'common.success': 'Succeeded',
  'common.fail': 'Failed',
  'log.colPipelineId': 'Pipeline ID',
  'log.colTriggerEvent': 'Trigger event',
  'log.colResult': 'Result',
  'log.detail': 'Details',
  'log.scriptLogs': 'Script log:',
  'log.input': 'Input:',
  'log.output': 'Output:',
  'log.systemCardTitle': 'System log (refreshes every 5s)',
  'common.manualRefresh': 'Refresh now',
  'log.systemFetchFailed': 'Could not fetch the log (the server is unreachable or the session expired). It retries automatically every 5 seconds.',


  // ── 🔴 期 5 第五批（26 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ 术语与回收站那批一致：Recycle bin / Restore / **Delete forever**（= `recycle.purge`）。
  //    🔴 `draft.deleteConfirmTitle` 带 ICU 占位符 `{title}`（草稿标题），三份包占位符名一致（生成脚本已比对）。
  'common.batchDeleteOk': 'Deleted the selected drafts',
  'common.batchDelete': 'Delete selected',
  'common.batchExport': 'Export selected',
  'common.clearSelection': 'Clear selection',
  'common.importOk': 'Imported',
  'common.recycleBin': 'Recycle bin',
  'draft.colTitleTip': 'Long titles are truncated automatically',
  'common.fieldRequired': 'This field is required',
  'common.searchOrSelect': 'Search or choose',
  'common.createdAt': 'Created',
  'common.publish': 'Publish',
  'draft.deleteConfirmTitle': 'Delete the draft "{title}"?',
  'draft.deleteConfirmContent': 'The draft moves to the Recycle bin in the toolbar on this page and can be restored at any time. Only Delete forever inside the Recycle bin is irreversible.',
  'common.movedToRecycleOk': 'Deleted. It moved to the Recycle bin and can be restored!',
  'common.importHint': 'Import from markdown files; you can select several',
  'common.importBtn': 'Import',
  'draft.importTitle': 'Import drafts',
  'common.articleTitle': 'Post title',
  'common.titlePlaceholder': 'Enter a title',
  'common.categoryPlaceholder': 'Choose a category',
  'common.categoryTooltip': 'First time here? Add categories under Site management, then Data, then Categories',
  'common.content': 'Content',
  'draft.newTitle': 'New draft',
  'common.createdAtPlaceholder': 'Leave empty to use the current time',
  'common.authorPlaceholder': 'Leave empty to use the signed-in user',
  'common.export': 'Export',


  // ── 🔴 期 5 第六批（26 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ 「黄色信息」写 explicit content；术语与回收站那批一致（Recycle bin / restoring）。
  //    🔴 这批是**安全相关文案**（密码不可找回、清除即解除加密）⇒ 译文逐句对着中文核过，
  //    并且生成脚本的术语闸门会检查"含回收站/恢复/永久删除的条目必须用既有术语"。
  'common.demoBlockedUpdate': 'The details cannot be changed on the demo site',
  'common.demoBlockedReason': 'It used to be allowed, but someone put explicit content on the demo home page, so the permission was turned off.',
  'common.okClear': 'Clear it',
  'common.cancelReconsider': 'Let me reconsider',
  'common.okSaveAnyway': 'Save anyway',
  'common.cancelGoBack': 'Go back and change the time',
  'common.articleUpdated': 'Post updated',
  'common.draftUpdated': 'Draft updated',
  'common.updateFailedCheck': 'Could not save. Please check the values you entered.',
  'common.topPriority': 'Pin priority',
  'common.topPriorityPlaceholder': 'Leave empty or 0 to keep it unpinned; the larger the number, the higher the priority',
  'common.encrypted': 'Encrypt',
  'common.no': 'No',
  'common.yes': 'Yes',
  'common.password': 'Password',
  'common.passwordTooltipSet': 'A password is already set. Leave empty to keep it, or enter a new value to change it.',
  'common.passwordTooltipUnset': 'Leave empty for no encryption; if you enter one, the post is encrypted with that password.',
  'common.clearPasswordExtra': 'Ticking this and submitting removes the encryption on this post. The original password cannot be recovered afterwards. To only change the password, do not tick it and enter the new password above.',
  'common.hiddenField': 'Hide',
  'common.scheduledPublish': 'Scheduled publishing',
  'common.copyright': 'Copyright notice',
  'common.copyrightTooltip': 'Replaces the default copyright notice at the bottom of the post page. Leave empty to follow the related options in the system settings.',
  'common.copyrightPlaceholder': 'Replaces the default copyright notice at the bottom of the post',
  'draft.publishTitle': 'Publish draft: {title}',
  'common.demoBlockedCreate': 'New posts cannot be created on the demo site',
  'draft.publishOk': 'Published. The original draft moved to the Recycle bin for drafts automatically (restoring it does not affect the published post).',


  // ── 🔴 期 7 第一批（15 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ `scrypt` 是技术标识符，三份包都必须原样保留（生成脚本的闸门会查）。
  'accessPassword.unrecoverable': 'The password is stored as a scrypt hash and the server cannot read it back: if you forget or clear it, it cannot be recovered, only set again.',
  'accessPassword.clearLabel': 'Clear password',
  'accessPassword.clearTooltip': 'Tick this and submit = remove the encryption (the server sets the password to empty). Leave it unticked and the password box empty = keep the current password.',
  'accessPassword.placeholderCreate': 'Leave empty for no encryption',
  'accessPassword.placeholderSet': 'A password is set; leave empty to keep it',
  // 🔴 尾部那个空格是**刻意**的：`passwordHelp` 把"语义句"与"不可找回警告"**直接拼接**
  //    （`${semantic}${warning}`）；中文不需要空格，而英文拼出来会是 "…that password.The password is stored…"。
  //    🔴 这是活体探针在 en-US 下量出来的（单测当时只断言 startsWith/endsWith，没验**接缝**）。
  //    修法与 §7.152 B 的 `img.helpP3strong` 同一手法：空格放进**英文片段**，中文两份都不带 ⇒ 对账仍成立。
  'accessPassword.helpCreate': 'Leave empty = no encryption; enter one = encrypt with that password. ',
  'accessPassword.helpSet': 'This post or category already has a password. Leave empty = keep it; enter a new value = change it; to remove the encryption, tick Clear password. ',
  'accessPassword.errBothFillAndClear': 'You cannot enter a new password and clear it at the same time: to change the password only enter the new one, to remove the encryption only tick clear.',
  'accessPassword.errNothingToClear': 'This post or category has no password, so there is nothing to clear.',
  'accessPassword.errPrivateNeedsPassword': 'If you turn on encryption, enter a password',
  'accessPassword.clearTitle': 'Clear the access password for {target}?',
  'accessPassword.clearContent': 'This removes the encryption on {target}, so anyone can see the content. The password is stored as a hash and cannot be recovered after clearing. If you only want a different password, do not tick clear and enter the new password in the password box.',
  'accessPassword.targetIt': 'it',
  'accessPassword.privateToggleHint': 'Turning encryption off does not delete the password that is already set (use Clear password for that); turning it back on keeps using the original password.',
  'accessPassword.targetThisArticle': 'this post',


  // ── 🔴 期 5 第七批（9 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ `URL` / `Open Graph` / `Twitter` 是技术标识符，三份包都要原样保留（闸门会查）。
  'article.newTitle': 'New post',
  'article.importTitle': 'Import posts',
  'common.passwordInputPlaceholder': 'Enter a password',
  'cover.label': 'Header image',
  'cover.placeholder': 'Optional image URL; leave empty for no header image',
  'cover.tooltip': 'Optional. Shown at the top of the post page and used as the preview image when sharing to other apps (Open Graph / Twitter). Upload it to the existing image host or enter an image URL. Leave empty to show nothing; existing posts are not affected.',
  'cover.uploadedOk': '{name} uploaded!',
  'cover.uploadedExists': '{name} already exists!',
  'cover.clear': 'Clear the header image',


  // ── 🔴 期 5 第八批（30 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ 术语与回收站那批一致：Recycle bin / restored / **Delete forever**。
  //    🔴 片段句（hiddenWarningPrefix + <a>Layout</a> + hiddenWarningSuffix、
  //    scheduledWarningP1a + <b>时间</b> + P1b）是**按 JSX 顺序拼出整句**校对过的，不是逐段直译。
  'article.genPinyinTitle': 'Generate pinyin path names for every post?',
  'article.genPinyinContent': 'For every post whose custom path name is empty, a pinyin path is generated from the title (duplicates get -2, -3 appended). Existing path names are not changed, and the old /post/ numeric id links keep working.',
  'common.generate': 'Generate',
  // 🔴 两处"计数紧跟复数名词"⇒ 必须用 ICU plural（否则渲染出 "1 path names"）；
  //    zh-CN / zh-TW 保持 `{updated} 个路径名` 这种形状（汉语没有复数变化，加了只会让文案变丑）。
  'article.genPinyinDone':
    '{updated, plural, one {# path name} other {# path names}} generated ({scanned, plural, one {# post} other {# posts}} scanned, {skipped} skipped)',
  'article.editAbout': 'Edit the About page',
  'article.genPinyin': 'Generate pinyin paths',
  'article.hiddenAriaLabel': 'Whether {title} is hidden',
  'article.hiddenOn': 'Hidden',
  'article.hiddenOff': 'No longer hidden',
  'article.colTop': 'Pinned',
  'article.colViews': 'Views',
  'article.hiddenTooltip': 'A hidden post is not shown on the site and is not counted in the total word count, the timeline and so on. Toggle it here instead of opening the details dialog.',
  'article.scheduledTooltip': 'A scheduled post is invisible to every public page (list, search, RSS and sitemap) until its time comes; the server publishes it within a minute after that. It is based on whether publishAt is later than the current time.',
  'article.hiddenWarningTitle': 'This post is hidden',
  'article.hiddenWarningP1': 'A hidden post shows a 404 page unless access by URL is turned on (it is off by default).',
  'article.hiddenWarningPrefix': 'You can change this in the',
  'article.layoutConfig': 'Layout',
  'article.hiddenWarningSuffix': 'section of the site settings.',
  'common.visitAnyway': 'Open it anyway',
  'common.back': 'Back',
  'article.scheduledWarningTitle': 'This post is scheduled and not published yet',
  'article.scheduledWarningP1a': 'This post is scheduled to publish at',
  'article.scheduledWarningP1b': 'and until then it is invisible to every public page, so opening it now shows a 404 page.',
  'article.scheduledWarningP2': 'To change the time or cancel the schedule, use Edit, then Edit details, then Scheduled publishing.',
  'article.deleteConfirmTitle': 'Delete "{title}"?',
  'article.deleteConfirmContent': 'The post moves to the Recycle bin in the toolbar on this page and disappears from the site at once. It can be restored at any time; only Delete forever inside the Recycle bin is irreversible.',
  'common.demoBlockedDelete': 'This post cannot be deleted on the demo site',
  'common.batchDeleteConfirmTitle': 'Delete the selected items?',
  'common.batchDeleteConfirmContent': 'This cannot be undone',
  'common.batchDeleteFailed': '{failed} of {total} could not be deleted',


  // ── 🔴 期 5 第九批（29 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ `Revert these changes` 在 `cover.revertHint` 里被**引用**（"点右下角「撤销本次改动」"）⇒ 两处必须逐字一致。
  'cover.previewFailed': 'Could not load the preview',
  'cover.writtenFor': 'Added a cover to {count, plural, one {# post} other {# posts}}',
  'cover.writeFailed': 'Could not write the covers',
  'cover.revertedFor': 'Reverted the cover changes on {count, plural, one {# post} other {# posts}}',
  'cover.revertFailed': 'Could not revert',
  'common.close': 'Close',
  'cover.revertedDone': 'Changes reverted',
  'cover.revertBtn': 'Revert these changes',
  'cover.confirmWrite': 'Confirm writing ({count, plural, one {# post} other {# posts}})',
  'cover.triggerTooltip': 'Scans post bodies and fills in the first usable image for posts whose cover is empty. Preview first; you can revert after writing.',
  'cover.triggerBtn': 'Add covers from the first image',
  'cover.doneTitle': 'Covers added',
  'cover.writtenSummary': 'Added a cover to {changed, plural, one {# post} other {# posts}} ({scanned} scanned)',
  'cover.revertHint': 'If a post got the wrong image, use Revert these changes at the bottom right to put the covers of this batch back to their previous values (empty stays empty).',
  'cover.scanning': 'Scanning post bodies for the first image…',
  'cover.onlyEmpty': 'Only posts with an empty cover are filled in; existing covers are not changed. You can untick individual posts before writing.',
  'cover.previewRetry': 'The preview did not run; use the button below to try again',
  'cover.rescan': 'Scan again',
  'common.selectAll': 'Select all',
  'common.invertSelection': 'Invert selection',
  'cover.selectedCount': '{selected} of {total} selected',
  'coverBackfill.emptyResult': 'Every post already has a cover, or no usable image was found in the bodies',
  'coverBackfill.untitled': 'Post {id}',
  'coverBackfill.rowScanned': 'Scanned',
  'coverBackfill.rowMatched': 'With a first image',
  'coverBackfill.rowWillWrite': 'Will write',
  'coverBackfill.rowWritten': 'Written',
  'coverBackfill.rowSkippedHasCover': 'Skipped: has a cover',
  'coverBackfill.rowSkippedNoImage': 'Skipped: no image',


  // ── 🔴 期 5 第十批（36 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ `VANBLOG_ARTICLE_REVISIONS_KEEP=0` / `404` / `article:update` / `restored=false` 是技术标识符，原样保留。
  //    🔴 `{count} words` 用 ICU plural；`revision.savedVersionWhen` 与 `revision.detailWrap` 的英文
  //    **带前导空格**（拼接处需要，中文两份都不带 ⇒ 逐字对账仍成立，手法同 §7.152 B）。
  'revision.needArticleId': 'The post has not been saved yet (it has no ID). Save it first, then come back to the revision history.',
  'revision.detailMissingId': 'This revision has no ID, so it cannot be opened',
  'revision.restoreMissingId': 'The post or revision ID is missing, so it cannot be restored',
  'revision.colSavedAt': 'Saved at',
  'revision.colWordCount': 'Words',
  'revision.colReason': 'Source',
  'revision.restoreOkBtn': 'Restore this revision',
  'revision.backToList': 'Back to the list',
  'revision.savedAt': 'Saved at {when}',
  'revision.wordCountValue': '{count, plural, one {# word} other {# words}}',
  'revision.sizeValue': 'Size {size}',
  'revision.reasonValue': 'Source {reason}',
  'revision.title': 'Revision history',
  'revision.titleWithArticle': 'Revision history: {title}',
  'revision.loadingDetail': 'Loading the revision content…',
  'revision.featureOff': 'The revision history feature is off (VANBLOG_ARTICLE_REVISIONS_KEEP=0 on the server, or the server version does not support it yet). Once it is on, every save records a revision, and the server prunes revisions beyond the retention limit.',
  'revision.empty': 'This post has no revisions yet. Saving the post records a revision automatically (the retention limit is controlled by the server); if revision history is off on the server (VANBLOG_ARTICLE_REVISIONS_KEEP=0), this list stays empty.',
  'revision.detailEmptyContent': '(This revision has no body content)',
  'revision.reasonUpdate': 'Saved an update',
  'revision.reasonPreRestore': 'Saved automatically before a restore',
  'revision.untitled': '(untitled)',
  'revision.detailWrap': ' ({message})',
  'revision.listFailed': 'Could not load the revision history{detail}. Please try again later.',
  'revision.detailNotFound': 'The content of this revision is not available (404): it may have just been pruned by the server retention policy, or it belongs to another post. Refresh the list to confirm.',
  'revision.detailFailed': 'Could not load the revision content{detail}. Please try again later.',
  'revision.restoreNotFound': 'That revision was not found (404): it may have been pruned by the server retention policy, or it belongs to another post. The list will refresh to the latest state.',
  'revision.restoreForbidden': 'This account does not have permission to restore revisions (article:update is required). Please contact an administrator.',
  'revision.restoreUnauthorized': 'The session has expired. Please sign in again and try once more.',
  'revision.restoreFailed': 'Could not restore the revision{detail}. Please try again later.',
  'revision.restoreConfirmTitle': 'Restore the post to the revision "{title}"?',
  'revision.restoreConfirmContent': 'Before restoring, the server saves the current state of the post as a new revision, so this restore is itself reversible (you can restore back to the current content later). Confirming overwrites the current body of the post with the body of that revision.',
  'revision.restoreNotApplied': 'The server reported that this restore did not take effect (restored=false); the post was not changed. Refresh the list and try again.',
  'revision.savedVersionWhen': ' (the revision saved at {when})',
  'revision.restoreSnapshot': 'The content from before the restore was saved as a new revision automatically, so you can restore it back.',
  'revision.restoreSnapshotAlt': 'The content from before the restore was also saved as a new revision, so you can restore it back at any time.',
  'revision.restoreSuccess': 'Restored to "{title}"{when}. {snapshot}',


  // ── 🔴 期 7 第二批（11 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ `Hugo` / `slug` / `SEO` / `URL` / `/post/` / `:slug` / `RSS` / `sitemap` / `permalinks.post` /
  //    `machine learning` 都是技术标识符，三份包原样保留（闸门会查）。
  'tagTokens.placeholder': 'Choose, type or paste several tags (separate with commas, semicolons or new lines)',
  'tagTokens.tooltip': 'You can paste several tags at once. Separate them with commas, semicolons or new lines (either script); spaces do not split, so multi-word tags such as "machine learning" stay intact.',
  'pathname.label': 'Custom path name',
  'pathname.placeholder': 'For example the slug from Hugo; leave empty to generate a pinyin path from the title instead of a numeric id',
  'pathname.tooltip': 'After publishing, the address is /post/[custom path name], which matches permalinks.post = "/post/:slug" in Hugo. When migrating from Hugo, put the old slug here to keep the old URL and its SEO. Leave empty to generate a pinyin path from the title automatically (duplicates get -2, -3 and finally -post id); it falls back to the numeric id only when the title has no usable characters. A path name that is already set does not change when the title changes, and the numeric id address always works; there is no site-level permalink template.',
  'schedule.tagText': 'Scheduled',
  'schedule.publishAtPlaceholder': 'Leave empty = not scheduled (publish immediately)',
  'schedule.publishAtTooltip': 'After you set a future time, the post is invisible to every public page (list, search, RSS and sitemap) until that time; a server cron job publishes it within a minute after it. Clearing this field = cancel the schedule (publish immediately, or keep it published).',
  'schedule.publishAtHelp': 'Scheduled publishing: before the set time this post is completely invisible on the site, and the server publishes it within a minute of that time.',
  'schedule.pastWarningText': 'The scheduled time you chose, {when}, is earlier than the current time ({now}). It will not be in the scheduled state: after saving, the server treats it as due and publishes an unpublished post within a minute. Do you still want to use this time?',
  'schedule.pastWarningTitle': 'The scheduled time is in the past',


  // ── 🔴 期 7 第三批（29 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    🔴 计数句一律 ICU plural；`({local} local, {remote} external)` 是"占位符 + 形容词"⇒ **不用** plural。
  //    ⚠️ `Markdown` / `.md` / `.mdz` / `.zip` / `Typora` / `Obsidian` / `data URI` 都是技术标识符，原样保留。
  //    🔴 `{note}` 是服务端产物文件名（`导出说明.md`）⇒ 英文值里**不出现汉字**，因为那个字面量在调用期才喂进来。
  'export.formatMdHint': 'Body only; images still point at the site (fastest)',
  'export.formatMdzLabel': 'Typora image bundle (.mdz)',
  'export.formatMdzHint': 'Body + images, with the links rewritten to relative paths',
  'export.formatZipLabel': 'Everything in one archive (.zip)',
  'export.formatZipHint': 'md + mdz + the export notes, all at once',
  'export.loadingMd': 'Exporting Markdown…',
  'export.loadingPack': 'Packing Markdown and images…',
  'export.outcomeMdTitle': 'Markdown exported (without images)',
  'export.outcomeMdRefs': 'Found {refs, plural, one {# image reference} other {# image references}} in the body; the links still point at the site. That is what the .md format does.',
  'export.outcomeMdPickMdz': 'If you need the images too (for example to open the post offline in Typora or Obsidian), choose Typora image bundle (.mdz) instead.',
  'export.outcomeNoImagesMdzTitle': 'This post has no images',
  'export.outcomeNoImagesTitle': 'Export finished (this post has no images)',
  'export.outcomeNoImagesWhy': 'This post has no images, so there is no .mdz. The point of .mdz is to carry the images along and rewrite their links to relative paths.',
  'export.outcomeNoImagesPickMd': 'Choose Markdown (.md) instead; the content is the same.',
  'export.outcomeNoImagesAllContent': 'The .md you got is the whole content.',
  'export.outcomeProblemsTitle': 'Export finished, but some images did not make it into the archive',
  'export.outcomeProblemsSummary': 'Found {refs, plural, one {# image reference} other {# image references}} in the body and packed {packed, plural, one {# image} other {# images}} ({local} local, {remote} external).',
  'export.outcomeProblemsFailed': '{failed, plural, one {# image} other {# images}} could not be fetched; the md keeps the original links.',
  'export.outcomeProblemsSkipped': 'Skipped {skipped, plural, one {# reference} other {# references}} (data URIs, relative paths that could not be resolved, and so on).',
  'export.outcomeZipNote': 'The {note} inside the archive has the full list.',
  'export.noImagesFallback': 'This post has no images, so there is no .mdz.',
  'export.noImagesDetailRefs': 'Found {refs, plural, one {# image reference} other {# image references}} in the body, but none of them is a local or fetchable image that can go into a .mdz.',
  'export.noImagesDetailNone': 'The body has no image references at all, so .mdz and .md would be identical.',
  'export.failed': 'Export failed',
  'export.noFileFromServer': 'Export failed: the server did not return a file',
  'export.noImagesModalTitle': 'This post has no images, so there is no .mdz',
  'export.noImagesModalOk': 'Export as Markdown (.md) instead',
  'export.noImagesModalNote': 'The point of .mdz is to carry the images along and rewrite their links to relative paths; without images it is exactly the same as .md.',
  'export.success': 'Exported',


  // ── 🔴 期 7 第四批（10 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    🔴 "N 秒/分/时/天前" 一律 ICU plural（`{n, plural, one {# second} other {# seconds}} ago`）。
  //    ⚠️ `{name} 上传失败!` 的叹号在中文原文里就是**半角** ⇒ 英文也用半角、不加句点（翻译批次不改中文文案的语气符号）。
  'time.justNow': 'just now',
  'time.secondsAgo': '{n, plural, one {# second} other {# seconds}} ago',
  'time.minutesAgo': '{n, plural, one {# minute} other {# minutes}} ago',
  'time.hoursAgo': '{n, plural, one {# hour} other {# hours}} ago',
  'time.daysAgo': '{n, plural, one {# day} other {# days}} ago',
  'common.demoForbidden': 'This action is not allowed on the demo site!',
  'common.importMarkdownOnly': 'Only Markdown files can be imported for now!',
  'common.loadCategoriesFailed': 'Could not load the current categories!',
  'common.uploadFailed': 'Upload failed',
  'common.uploadFailedWithName': '{name} failed to upload!',


  // ── 🔴 期 7 第五批（4 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ 这四条是**全局兜底**：任何一次失败的请求都可能弹它，所以英文要短、要说清"下一步怎么办"。
  'request.sessionExpired': 'Your session has expired',
  'request.loginSuccess': 'Signed in',
  'request.forbidden': 'You do not have permission to do that',
  'request.defaultError': 'The action failed. Please try again later.',


  // ── 🔴 期 6 第一批（6 keys）── 英文人工写；`more marker` 指文章里的 `<!-- more -->` 摘要分割标记。
  'editor.undo': 'Undo',
  'editor.redo': 'Redo',
  'editor.emoji': 'Emoji',
  'editor.insertMore': 'Insert the more marker',
  'editor.copied': 'Copied',
  'editor.customContainer': 'Custom callout',


  // ── 🔴 期 6 第二批（15 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  //    ⚠️ `Markdown` / `HTML` / `<img>` / `/static` / `data:` 是技术标识符，三份包原样保留。
  //    🔴 计数句一律 ICU plural（`{transferred, plural, one {# image} other {# images}}`）。
  'editor.uploadSuccess': 'Uploaded',
  'editor.clipboardUpload': 'Upload an image from the clipboard',
  'editor.clipboardEmpty': 'There is no image on the clipboard',
  'editor.clipboardUploadFailed': 'Could not upload the clipboard image',
  'editor.attachmentUploadFailed': 'Could not upload the attachment',
  'editor.uploadAttachment': 'Upload an attachment and insert the link',
  'editor.attachmentUploaded': 'Attachment uploaded: {url}',
  'editor.transferTitle': 'Copy remote images to this site',
  'editor.transferConfirmContent': 'This scans the body for remote images (Markdown and HTML <img>), downloads them into the image storage of this site and rewrites the links. Addresses that are already on this site under /static or in the image storage, relative paths and data: images are skipped. Links that fail stay as they are. Continue?',
  'editor.transferStart': 'Start copying',
  'editor.transferFailedNoData': 'The transfer failed',
  'editor.transferPartial': 'Transferred {transferred, plural, one {# image} other {# images}}, skipped {skipped, plural, one {# image} other {# images}}, failed {failed, plural, one {# image} other {# images}}: {urls}',
  'editor.transferNone': 'No remote images need transferring ({skipped, plural, one {# image} other {# images}} skipped)',
  'editor.transferDone': 'Transferred {transferred, plural, one {# remote image} other {# remote images}} into the image storage of this site ({skipped} skipped)',
  'editor.transferFailed': 'Could not transfer the remote images',


  // ── 🔴 期 6 第三批（13 keys）── 英文人工写；不用缩写（ICU 把单引号当转义符）。
  'editorProfile.title': 'Editor preferences',
  'common.saveSuccess': 'Saved',
  'editorProfile.storageNote': 'These preferences are stored in this browser, so you need to set them again on another device.',
  'editorProfile.afterSaveLabel': 'After saving',
  'editorProfile.afterSavePlaceholder': 'Choose what happens after saving; the default is to stay on this page',
  'editorProfile.stayHere': 'Stay on this page',
  'editorProfile.goBack': 'Go back to the previous page',
  'editorProfile.localCacheLabel': 'Local cache',
  'editorProfile.localCacheTooltip': 'Off by default. When it is on, the editor content is cached in this browser, and if the local copy is newer than the copy on the server, the local copy is shown in the editor.',
  'editorProfile.localCachePlaceholder': 'Whether to cache the editor content in this browser',
  'editorProfile.softWrapLabel': 'Soft wrap',
  'editorProfile.softWrapTooltip': 'Off by default, which keeps standard Markdown: a single Enter stays in the same paragraph, and a line break needs two spaces at the end of the line or a blank line. When it is on, pressing Enter or pasting several lines adds the two trailing spaces automatically to make a soft wrap; existing posts are not rewritten when you open or save them.',
  'editorProfile.softWrapPlaceholder': 'Whether to add the trailing spaces automatically',

};
