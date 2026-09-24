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
  'init.restore.detail.db': '{db}: {collections} collections / {documents} documents',
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
};
