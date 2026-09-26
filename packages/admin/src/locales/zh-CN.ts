/**
 * 🔴 简体中文语言包（**默认语言 / 权威口径**）。
 *
 * 第一期覆盖面：**安装页家族**（`pages/InitPage/` 的 4 个文件）。
 * 后台其余页面（含安装页第 2–4 步共用的 `components/SiteInfoForm`，108 个去重中文字面量、
 * 被 9 个测试文件钉住）属于**第二期**，见 `AGENTS.md` 的多语言分期记录。
 *
 * ## 三条必须遵守的约定
 *
 * 1. 🔴 **三份语言包（zh-CN / zh-TW / en-US）的 key 集合必须完全相等**。
 *    由 `tests/unit/localePackParity.test.js` 钉住（含反空转下界与尺子反证）。
 *    加第四种语言 = 复制这份 key 清单再翻译，不需要改任何组件。
 * 2. 🔴 **组件里的 `formatMessage` 一律带 `defaultMessage`，且它的值必须与本文件里同 id 的值逐字相同。**
 *    `defaultMessage` 有两个作用：①漏翻译时**回落到中文而不是把裸 key 显示给用户**；
 *    ②让既有的「源码文本断言」守卫继续有效（中文仍在源文件里）。
 *    代价是中文出现在两处 ⇒ 由上面那条守卫**逐条对账**，防止漂移。
 * 3. 🔴 **不要翻译「与服务端约定的字符串」**。本文件刻意**不含** `init.wire.alreadyInitialized`：
 *    `InitPage/index.tsx` 里 `String(info?.message || '').includes('已初始化')` 匹配的是
 *    **服务端 `throw new HttpException('已初始化', 500)` 产生的文本**，那是**协议**不是文案。
 *    翻译它会让「站点已初始化 ⇒ 跳登录页」这条分支永久失效。
 *    （把它改成稳定错误码属于服务端 i18n 那一期，尚未裁定。）
 */
export default {
  // ── 初始化密钥（setup key）卡片 ──────────────────────────────
  'init.setupKey.cardTitle': '本站开启了初始化保护：请填写初始化密钥',
  'init.setupKey.alertFallback': '服务端要求携带初始化密钥（setup key）后才能完成初始化/恢复',
  'init.setupKey.placeholder': '粘贴 setup.key 文件的完整内容（或启动日志里「初始化密钥」那一行）',
  'init.setupKey.hint1':
    '新版安装默认要求初始化密钥（VANBLOG_INIT_REQUIRE_SETUP_KEY 默认开启）：站点未初始化期间，server 会在启动时打印密钥块，之后每 10 分钟重印一次（VANBLOG_SETUP_KEY_REMIND_MINUTES 可调，0=只印一次），直到完成初始化',
  'init.setupKey.hint2':
    '拿密钥：docker logs <容器名> 2>&1 | grep 初始化密钥；或直接读挂载日志目录里的 setup.key 文件（容器内默认 /var/log/setup.key；裸机部署在 config.yaml 的 log 目录下），复制「完整一行」，不要带多余字符',
  'init.setupKey.hint3':
    '密钥每次重启 vanblog 都会重新生成；初始化完成后服务端自动删除该文件、停止提醒，两条初始化接口也不再接受密钥',
  'init.setupKey.hint4':
    '只有运维显式设置了 VANBLOG_INIT_REQUIRE_SETUP_KEY=false（逃生口，不推荐）时才不要求密钥 —— 那种情况下这一栏留空提交即可',

  // ── 「用备份恢复」卡片 ────────────────────────────────────────
  'init.restore.cardTitle': '已有整站备份？直接恢复',
  'init.restore.cardMessage': '上传 full 备份归档，一步恢复整个旧站点',
  'init.restore.cardNotePrefix': '管理员账号、站点设置、文章、图片',
  'init.restore.cardNoteStrong': '全部来自备份文件',
  'init.restore.cardNoteSuffix':
    '，不需要填写下面初始化向导的任何信息；恢复完成后用备份里的账号密码登录。',

  // ── 向导外壳 ──────────────────────────────────────────────────
  'init.divider': '—— 或者，手动初始化 ——',
  'init.wizard.title': '欢迎使用 VanBlog 个人博客系统',
  'init.wizard.helpDoc': '帮助文档',
  'init.step.user': '配置用户',
  'init.step.basic': '基本配置',
  'init.step.advanced': '高级配置',
  'init.step.layout': '布局配置',
  'init.alert.allEditable': '初始化页面所有配置都可在初始化后进入后台修改。',
  'init.alert.uploadDefault':
    '默认的上传图片会到内置图床，如需配置 oss 图床，可在初始化后去设置页更改。初始化页面所有配置都可在初始化后进入后台修改。',

  // ── 表单字段 ──────────────────────────────────────────────────
  'init.field.required': '这是必填项',
  'init.field.username': '登录用户名',
  'init.field.usernamePlaceholder': '请输入登录用户名',
  'init.field.password': '登录密码',
  'init.field.passwordPlaceholder': '请输入登录密码',

  // ── 弹窗 ──────────────────────────────────────────────────────
  'init.success.title': '初始化成功!',
  'init.success.content':
    '首次使用请记得去后台 “站点管理/评论管理” 中注册一下评论系统的管理员账号哦！评论通知等设置可在 “系统设置/评论设置” 中找到。',
  'init.alreadyInit.title': '本站已经初始化过了',
  'init.alreadyInit.content': '初始化只能执行一次，接下来请直接登录。',
  'init.baseUrl.invalidTitle': '网站 URL 不合法！',
  'init.baseUrl.invalidLine1': '请输入包含完整协议的 URL',
  'init.baseUrl.invalidLine2': '例: https://blog.example.com',

  // ── 恢复流程（RestoreFromBackup.tsx）─────────────────────────
  'init.restore.uploadButton': '上传备份并恢复',
  'init.restore.confirmTitle': '用 {name}（{size}）恢复整个站点？',
  'init.restore.confirmOk': '我确定，恢复',
  'init.restore.confirmCancel': '取消',
  'init.restore.uploading': '正在上传…',
  'init.restore.restoring': '正在恢复…',
  'init.restore.uploadingLong':
    '上传完成，服务端正在恢复（解压 + 导入数据库 + 写回静态文件）。几十 MB 的备份通常要 1–2 分钟，请不要关闭或刷新页面。',
  'init.restore.uploadFailed': '上传失败：网络错误或服务不可达，请确认 server 正在运行后重试。',
  'init.restore.doneTitle': '恢复完成',
  'init.restore.toSignIn': '去登录',
  'init.restore.noAdminTitle': '数据已恢复，但备份里没有管理员账号',
  'init.restore.continueInit': '继续初始化',
  'init.restore.needSetupKey': '需要初始化密钥',
  'init.restore.failedTitle': '恢复失败',

  // ── 恢复结果统计（restoreCore.formatRestoreCounts）────────────
  'init.restore.count.articles': '文章',
  'init.restore.count.images': '图片',
  'init.restore.count.users': '用户',
  'init.restore.count.visits': '访问记录',
  'init.restore.count.viewers': '访客',
  'init.restore.count.settings': '设置',
  'init.restore.count.total': '合计',
  'init.restore.count.unknownSize': '未知大小',

  // ── 恢复失败的解释（restoreCore.describeRestoreFailure）───────
  // ⚠️ 这几条的 id 与 `describeRestoreFailure` 里的分支一一对应；
  //    那个函数接受一个可选的翻译器参数，不传时**原样返回中文**（所以直接 require 它的单测不受影响）。
  'init.restore.err.rejected': '恢复被拒绝（statusCode={code}）',
  'init.restore.err.httpFailed': '恢复请求失败（HTTP {status}）',
  'init.restore.err.409': '已经有一个恢复在进行中：等它结束再试；若那一次成功了，刷新页面即可进入后台。',
  'init.restore.err.403':
    '这个站点已经初始化过了：init 入口只对全新站点开放。请登录后台，用「系统设置 → 备份与恢复 → 上传备份并恢复」。',
  'init.restore.err.429': '初始化相关请求太频繁（限流：每 10 分钟 5 次），请稍后再试。',
  'init.restore.err.400':
    '这个文件不是本站导出的整站备份，或它由「更新版本」的 VanBlog 生成、当前 server 读不了：先确认文件来源；确实是新版本备份的话，升级 server 之后再来。',
  'init.restore.err.fallback1':
    '请确认选的是「导出整站备份」生成的归档（文件名形如 vanblog-full-YYYYMMDD-HHMMSS.tar.zst / .tar.xz / .tar.gz）；后台导出的 JSON 数据备份不走这里 —— 那个在「系统设置 → 备份与恢复」里恢复。',
  'init.restore.err.fallback2':
    '如果这个站点其实已经初始化过，这里会拒绝恢复 —— 请登录后台，用「系统设置 → 备份与恢复」的上传恢复。',

  // ── 恢复结果的细节区块与确认弹窗（JSX 文本节点，第一轮清单漏了这批）──
  'init.restore.detail.seconds': '耗时 {seconds} 秒。',
  'init.restore.detail.counts': '恢复进来：{counts}',
  'init.restore.detail.db': '{db}：{collections} 张表 / {documents} 条',
  'init.restore.detail.static': '静态文件 {folder}：{files} 个',
  'init.restore.doneLine1Prefix': '请用',
  'init.restore.doneLine1Strong': '备份文件里的那套账号密码',
  'init.restore.doneLine1Suffix': '登录 —— 不是这个页面上填过的任何内容。',
  'init.restore.noAdminNote': '注意：这份归档本身没有带用户记录。若备份里的账号登录不上，可用 server 日志里的恢复密钥走「忘记密码」流程。',
  'init.restore.uninitLine1Prefix': '归档里的数据已经导入本站，但它',
  'init.restore.uninitLine1Strong': '不包含',
  'init.restore.uninitLine1Suffix': '管理员账号 —— 站点仍处于未初始化状态。',
  'init.restore.uninitLine2': '请继续用下面的初始化向导创建管理员账号；刚恢复进来的文章、图片、设置都会保留。',
  'init.restore.confirmIntro': '将用这份整站备份覆盖并初始化本站：',
  'init.restore.confirmItem1': '数据库全部集合（文章、草稿、分类、标签、图床记录、设置、访问统计…）',
  'init.restore.confirmItem2': 'waline 评论库',
  'init.restore.confirmItem3': '本地静态文件（图床图片与缩略图、附件、自定义页面）',
  'init.restore.confirmNotePrefix': '管理员账号与密码',
  'init.restore.confirmNoteStrong': '来自备份文件',
  'init.restore.confirmNoteSuffix': '，下面初始化向导里的任何输入都不需要。备份带有管理员账号时，恢复完成后直接去登录页；万一这份归档里没有账号，站点会保持未初始化，回来继续走向导建一个即可。',

  'common.language': '语言',
  'login.subTitle': 'VanBlog 博客管理后台',
  'login.usernamePlaceholder': '用户名',
  'login.usernameRequired': '用户名是必填项！',
  'login.passwordPlaceholder': '密码',
  'login.passwordRequired': '密码是必填项！',
  'login.autoLogin': '自动登录',
  'login.forgotPassword': '忘记密码',

  // 🔴 第二期第一块：后台侧边栏菜单（`config/routes.js` 的 `locale` 字段指向这些 key）。
  // ⚠️ 菜单文字由 ProLayout 用 formatMessage({id: locale, defaultMessage: name}) 渲染，
  //    所以**漏一条不会显示裸 key，而是回落到 routes.js 里的中文 name**（这正是保留中文 name 的理由）。
  // 🔴 英文/繁中的术语刻意与本包既有散文一致（例如「系统设置」在 init.* 的英文里就是 System settings），
  //    否则菜单与提示文案会互相矛盾。
  'menu.welcome': '分析概览',
  'menu.article': '文章管理',
  'menu.editor': '图形编辑器',
  'menu.code': '代码编辑器',
  'menu.about': '关于',
  'menu.draft': '草稿管理',
  'menu.img': '图片管理',
  'menu.file': '附件管理',
  'menu.site': '站点管理',
  'menu.site.data': '数据管理',
  'menu.site.comment': '评论管理',
  'menu.site.pipeline': '流水线',
  'menu.site.setting': '系统设置',
  'menu.site.customPage': '自定义页面',
  'menu.site.log': '日志管理',

  // 🔴 第二期第二块：侧边栏底部（主站/关于/登出）、主题三档、登出提示。
  //    繁中套地区用词（關於 / 自動 / 登入 / 伺服器 / 工作階段），不是字形转换。
  'common.mainSite': '主站',
  'common.about': '关于',
  'common.logout': '登出',
  'theme.light': '亮色模式',
  'theme.dark': '暗色模式',
  'theme.auto': '自动模式',
  'logout.ok': '登出成功！',
  'logout.sessionGone': '已退出登录（服务端会话已失效）',
  'logout.local': '已退出登录',
  'sysconf.waline.title': 'Waline 评论设置',
  'sysconf.waline.notice': '本表单控制内嵌 Waline 评论系统。换成自定义域名邮箱时，开启「是否启用邮件通知」后填写 SMTP、博主邮箱（收件人）和发件地址（From）即可，不用另外部署邮件服务。说明见：',
  'sysconf.img.featureCard': '图床功能设置',
  'sysconf.img.storageCard': '存储策略设置',
  'sysconf.img.advancedCard': '高级操作',
  'sysconf.img.scanBtn': '扫描现有文章图片到图床',
  'sysconf.img.scanTip': 'PS: 扫描文章图片会把文章内的所有图片扫描到数据库中，就可以在图床页面看到了。只支持外链。',
  'sysconf.img.scanOk': '扫描成功！共 {total} 项',
  'sysconf.img.scanFailed': '扫描失败！',
  'sysconf.img.deadLinks': '失效链接：',
  'sysconf.img.colArticleId': '文章 ID',
  'sysconf.img.colTitle': '标题',
  'sysconf.img.colLink': '链接',
  'sysconf.img.exportBtn': '导出全部本地图床内容（压缩包）',
  'sysconf.img.exportTip': 'PS: 导出全部图片会把本地图床的全部文件打包成一个 zip 压缩包并在完成后弹出下载窗口。',
  'sysconf.img.packDone': '图片打包完成，已开始下载',
  'sysconf.img.packFailed': '打包失败！',
  'sysconf.img.exportFailed': '导出失败',
  'sysconf.img.rewriteCard': '域名变更后改写文章图片链接',
  'sysconf.img.rewriteWarn': '换域名后，文章/草稿里已经写成绝对地址的图片（如 https://旧域名/static/...）不会跟着改。这里只改 Mongo 里的正文链接，不会移动磁盘上的文件，也不会改写你没填写的第三方图床。',
  'sysconf.img.oldBase': '旧站点 / 图床地址',
  'sysconf.img.newBase': '新站点 / 图床地址',
  'sysconf.img.rewriteBtn': '改写文章与草稿中的链接',
  // 🔴 这条虽然长在 sysconf 区块里，key 却是 `common.*`：它是**跨页组共用**的同一句话
  //    （SystemConfig 的图床/评论/备份，DataManage 的友链/社交都会弹它）⇒ 按命名规范
  //    「跨页共用的用 common」，不给每个页组各开一个同值 key（那是"同一性质两处口径"）。
  'common.demoBlocked': '演示站禁止修改此项！',
  'sysconf.img.demoBlockedBody': '演示站不允许批量改写文章内容。',
  'sysconf.img.fillBoth': '请填写旧地址和新地址',
  'sysconf.img.rewriteConfirm': '确认改写文章和草稿中的链接？',
  'sysconf.img.rewriteConfirmBody': '将把以「{from}」开头的链接改写成「{to}」。建议先在「备份恢复」导出一份数据。相对路径 /static/... 不会改动。',
  'sysconf.img.rewriteOk': '开始改写',
  'sysconf.img.rewriteDone': '改写完成：文章 {articles} 篇，草稿 {drafts} 篇，共 {replacements} 处',
  'sysconf.img.afterRewrite': '之后请到「站点配置」把网站 Url 改成新域名，并确认 DNS 已指向本站。新上传的图片会按当前访问域名写入。',

  // 🔴 期 3 第二批（2026-09-25）：SystemConfig 的「评论设置」（CommentSystem.jsx）与「定制化」
  // （Customizing.jsx）两个页签；跨页共用的动作词放在 common.* 下。
  // ⚠️ Customizing.jsx 的四个内层页签标签**刻意未翻译**（与 SystemConfig/index.jsx 的外层页签
  //    同属一个跨面词汇：docs/advanced/customizing.md 有一张表逐条列出它们，而文档 i18n 尚未裁定）。
  'sysconf.comment.readFailed': '读取评论设置失败！',
  'common.updateSuccess': '更新成功！',
  'sysconf.comment.saveFailed': '保存失败！',
  'sysconf.comment.title': '评论系统',
  'sysconf.comment.alertP1a': '内置评论与 Waline 是两套互相独立的系统：',
  'sysconf.comment.alertP1b': '切换到内置评论不会迁移已有的 Waline 评论',
  'sysconf.comment.alertP1c': '（反之亦然），原系统的历史评论只是不再展示，数据仍保留。',
  'sysconf.comment.alertP2': '切换到 Waline 会自动启动内嵌 Waline 服务，切换到「关闭」会停掉前台评论入口。',
  'sysconf.comment.builtin': '内置评论',
  'sysconf.comment.off': '关闭',
  'sysconf.comment.walineHint': 'Waline 的邮件通知、强制登录等选项在下方「Waline 评论设置」卡片里配置。',
  'sysconf.comment.builtinHint': '内置评论无需注册、随主服务运行，下面的审核规则仅对内置评论生效。',
  'sysconf.comment.moderationLabel': '审核策略',
  'sysconf.comment.moderationTip': '仅对内置评论生效；Waline 的审核在它自己的后台里配置',
  'sysconf.comment.modPost': '先发后审 —— 评论直接显示；命中待审关键词或包含外链时自动转入「待审核」',
  'sysconf.comment.modPre': '先审后发 —— 所有评论先进入「待审核」，人工通过后才在前台显示',
  'sysconf.comment.modNone': '不审核 —— 所有评论（含命中规则的）一律直接显示，请谨慎开启',
  'sysconf.comment.keywordsLabel': '待审关键词',
  'sysconf.comment.keywordsTip': '「先发后审」下，评论内容命中任一关键词（不区分大小写）就自动转待审；「先审后发」下所有评论本来就待审，关键词不再起作用',
  'sysconf.comment.keywordsExtra': '最多 {max} 个，每个不超过 {len} 字符；输入后回车添加',
  'sysconf.comment.keywordsPlaceholder': '输入关键词后回车，如：广告',
  'sysconf.comment.requireEmailLabel': '邮箱必填',
  'sysconf.comment.requireEmailTip': '开启后访客必须填写邮箱才能评论；邮箱只在后台可见，前台不会展示',
  'common.on': '开',
  'common.off': '关',
  'sysconf.comment.pendingOnLinkLabel': '含外链自动待审',
  'sysconf.comment.pendingOnLinkTip': '「先发后审」下，包含 http(s) 链接或 www. 的评论自动转待审（垃圾广告的常见特征）',
  'sysconf.comment.maxLenLabel': '内容长度上限',
  'sysconf.comment.maxLenTip': '单条评论允许的最大字符数，超出会被服务端拒绝',
  'sysconf.comment.rateLabel': '频率限制',
  'sysconf.comment.rateTip': '同一 IP 每 10 分钟最多能发表几条评论，超出的请求直接拒绝',
  'common.save': '保存',
  'common.reset': '重置',
  'sysconf.customizing.helpCss': '自定义 css 会把您写入的 css 代码作为 <style> 标签插入到前台页面中的 <head> 中。',
  'sysconf.customizing.helpScript': '自定义 script 会把您写入的 script 代码作为 <script> 标签插入到前台页面的最下方。',
  'sysconf.customizing.helpHtml': '自定义 html 会把您写入的 html 代码插入到前台页面 body 标签中的下方。是静态化的，首屏源代码即存在。',
  'sysconf.customizing.helpHead': '自定义 html 会把您写入的 html 代码插入到前台页面的 head 标签中的下方。是静态化的，首屏源代码即存在，可以用于网站所有权验证。',
  'sysconf.customizing.saveConfirmTitle': '保存确认',
  'sysconf.customizing.saveConfirmBody': '在保存前请确认代码的正确性,有问题的代码可能导致前台报错！如不生效，请检查是否在站点配置/布局设置中打开了定制化功能。',
  'sysconf.customizing.resetOk': '重置成功！',
  'common.help': '帮助',

  // ── 🔴 期 9：服务端错误码（`error.<code>`）──────────────────────────────────
  // 码的**权威登记表在服务端** `packages/server/src/utils/serverErrorCodes.ts`：
  // 服务端抛错时响应体多带一个 `code`（与可选的 `params`），而 `message` **仍是中文**。
  // 🔴 所以本包 `error.*` 的 zh-CN 值必须与登记表里的 `zh` **逐字相同** ——
  //    由 `tests/unit/i18nServerErrorCodes.test.js` 双向对账（漏译 / 死条目 / 码没被抛出 都会红）。
  // ⚠️ 这里的中文**不是**"待翻译的硬编码"，而是**回退文案**：admin 拿不到翻译器时走
  //    `t(key, 服务端 message)` 的 defaultMessage 位，行为与迁移前逐字一致。
  'error.categoryDuplicateOnCreate': '分类名重复，无法创建！',
  'error.categoryDeleteNeedsName': '删除分类必须带分类名（name 不能为空）。',
  'error.categoryHasArticles': '分类已有文章，无法删除！',
  'error.categoryReorderNoPayload': '无有效排序信息！',
  'error.categoryNoneToReorder': '无分类可排序！',
  'error.categoryUpdateNoPayload': '无有效信息，无法修改！',
  'error.categoryOrderInvalid': '排序值无效！',
  'error.categoryDuplicateOnUpdate': '分类名重复，无法修改！',

  // ── 🔴 期 9 第二批：文章/草稿的回收站、历史版本、.mdz 导入、导出归档下载（10 个码）──
  //    zh-CN 的值由脚本**直接从服务端登记表读出**（不是重敲一遍），所以逐字相同是构造出来的、不是核对出来的。
    //    ⚠️ 繁中术语决定（期 5 翻译那些组件时要沿用同一套，别再定第二遍）：
    //    回收站 → **資源回收筒**、彻底删除 → **永久刪除**、恢复 → **還原**、文件 → **檔案**、字段 → **欄位**、
    //    导出 → **匯出**、归档 → **歸檔**、清理 → **清除**、非法 → **不合法**。
  'error.articleImportMdzNoFile': '没有收到文件：请用 multipart 上传一个 .mdz（字段名 file）',
  'error.articleNotInRecycleBin': '回收站里没有这篇文章（可能已恢复或已彻底删除）',
  'error.articlePurgeRequiresRecycleBin': '只能彻底删除回收站里的文章（请先移入回收站）',
  'error.articleNotFoundForRevision': '找不到文章（回收站里的文章请先恢复再还原历史版本）',
  'error.revisionFeatureUnavailable': '历史版本功能不可用（RevisionProvider 未注册）',
  'error.revisionNotFound': '找不到这条历史版本（或它不属于这篇文章）',
  'error.draftNotInRecycleBin': '回收站里没有这篇草稿（可能已恢复或已彻底删除）',
  'error.draftPurgeRequiresRecycleBin': '只能彻底删除回收站里的草稿（请先移入回收站）',
  'error.exportArchiveNameInvalid': '非法的归档名',
  'error.exportArchiveMissing': '归档不存在（可能已被清理，请重新导出）',


  // ── 🔴 期 9 第三批：自定义页面（5 处）与账号/协作者（8 处），共 12 个码 ──
  //    zh-CN 的值同样由脚本**直接从登记表读出**（构造出逐字相同，不靠人核对）。
  //    🔴  一处登记、两个调用点：user.provider 与 auth.controller 曾各写一遍同一句话。
  'error.customPageCreateNeedsPath': '创建自定义页面必须带 path（页面路由，例如 /uptime）。收到的请求里没有可用的 path。',
  'error.customPagePathDuplicate': '已有此路由的自定义页面！无法重复创建！',
  'error.customPageUpdateNeedsTarget': '必须指明要修改哪一个自定义页面：请在请求体里带 `_id`（推荐，改路由时也只有它能命中原来那一行）或 `path`（页面路由，例如 /uptime）。两者都缺失时无法定位目标，服务端已拒绝执行（否则查询条件会退化成"任意一页"）。',
  'error.customPageDeleteNeedsPath': '删除自定义页面必须带 path（页面路由，例如 /uptime）。收到的请求里没有可用的 path，服务端已拒绝执行（否则查询条件会退化成"任意一页"，删掉一个无辜的页面）。',
  'error.customPageNotFound': '未找到该页面！',
  'error.collaboratorNameInvalid': '协作者用户名不合法（1-50 个字符）',
  'error.accountNameInvalid': '用户名不合法（1-50 个字符）',
  'error.adminPasswordInvalidNoChange': '密码不合法，未做任何修改',
  'error.collaboratorNameDuplicate': '已有为该用户名的协作者，不可重复创建！',
  'error.collaboratorPasswordInvalidOnCreate': '密码不合法，未创建协作者',
  'error.collaboratorNotFound': '没有此协作者！无法更新！',
  'error.collaboratorPasswordInvalidOnUpdate': '密码不合法，未修改协作者',


  // ── 🔴 期 9 第四批：回收站抽屉（`components/RecycleBin`）—— 组件 23 条 + 纯 JS 核心 28 条 ──
  //    zh-CN 的值由脚本**直接从源码的 defaultMessage 抽出**（不是重敲），所以逐字相同是构造出来的。
  //    ⚠️ `recycleCore.js` 是纯 JS 模块（被 node --test 直接 require）⇒ 用**注入式翻译器**：
  //    🔴 不传 t 时输出与改造前**逐字相同**（它那 30 条既有单测就是证据），传了才走这里的 key。
  //    ⚠️ 术语沿用既有包：流水线→流水線、设置→設定、恢复→還原、缓存→快取、数据库→資料庫、账号→帳號；
  //    本批新增：回收站→**資源回收筒**、刷新→**重新整理**、彻底删除→**永久刪除**、不可撤销→**無法復原**、
  //    加载→載入、联系→聯絡、记录→記錄（🔴 期 5 翻其它组件时沿用同一套，别再定第二遍）。
  //    ⚠️ 「归档」与「备份档」刻意分开：export 打出来的 zip 用**歸檔**，整站备份用**備份檔**（既有包口径）。
  'recycle.missingIdRestore': '这条记录缺少 ID，无法恢复',
  'recycle.missingIdPurge': '这条记录缺少 ID，无法永久删除',
  'common.colCategory': '分类',
  'common.colTags': '标签',
  'recycle.colUpdatedAt': '更新时间',
  'recycle.colDeletedAt': '删除时间',
  'recycle.restore': '恢复',
  'recycle.purge': '永久删除',
  'recycle.noPermission': '当前账号无操作权限',
  'common.colAuthor': '作者',
  'recycle.colPathname': '别名',
  'recycle.colWordCount': '字数',
  'recycle.drawerTitleDraft': '回收站（已删除的草稿）',
  'recycle.drawerTitleArticle': '回收站（已删除的文章）',
  'recycle.refresh': '刷新',
  'recycle.draftWarningTitle': '发布成功的草稿也会自动进入回收站',
  'recycle.draftWarningDesc': '恢复只作用于草稿本身，不会改动已发布的文章：如果某条草稿是发布时归档进来的，恢复它只会得到一份发布前的旧草稿，再次编辑并发布会产生一篇重复的文章。列表本身无法区分「误删」与「发布后归档」这两种情况，恢复前请留意。',
  'recycle.listLoadFailed': '列表加载失败，见上方提示。',
  'recycle.emptyArticle': '这里列出的是在「文章管理」中被删除的文章（软删除）：它们不会出现在前台，也不计入统计。你可以随时「恢复」把它们放回文章列表，或「永久删除」彻底移除（不可撤销）。当前没有已删除的文章。',
  'recycle.emptyDraft': '这里列出的是被删除的草稿。注意：草稿在发布成功后也会自动进入这里（发布即归档草稿，是既有行为）。恢复只作用于草稿本身：误删的草稿会回到草稿列表；发布后归档的草稿恢复出来只是一份发布前的旧副本，不会改动已发布的文章。当前没有已删除的草稿。',
  'recycle.titleQuoted': '「{title}」',
  'recycle.untitled': '(无标题)',
  'recycle.restoreConfirmTitle': '确认恢复这篇文章吗？',
  'recycle.restoreConfirmText': '恢复后文章会带着删除前的内容和设置回到「文章管理」列表。',
  'recycle.purgeConfirmTitle': '永久删除{label}？',
  'recycle.purgeConfirmContent': '永久删除会把这篇文章（含正文、别名、标签等全部内容）从数据库里彻底移除，此操作不可撤销，删除后无法再从回收站恢复。如果只是误删，请改用「恢复」。',
  'recycle.purgeOk': '永久删除',
  'recycle.draftRestoreConfirmTitle': '确认恢复这个草稿吗？',
  'recycle.draftRestoreConfirmText': '恢复只作用于草稿本身：它会回到「草稿管理」列表，可以继续编辑。注意：发布成功的草稿也会自动进入回收站 —— 如果这条正是发布时归档的，恢复它不会改动已发布的文章，你只会得到一份发布前的旧草稿；再次编辑并发布它会产生一篇重复的文章，请先确认这是你要的。',
  'recycle.draftPurgeConfirmTitle': '永久删除草稿{label}？',
  'recycle.draftPurgeConfirmContent': '永久删除会把这份草稿从数据库里彻底移除，此操作不可撤销，删除后无法再从回收站恢复。如果它已经发布过，删除这份草稿不影响那篇已发布的文章。',
  'recycle.restoreSuccess': '已恢复{label}，它已回到文章列表。恢复按「文章更新」处理：绑定文章更新的流水线会运行，前台缓存与总字数会刷新。',
  'recycle.purgeSuccess': '已永久删除{label}，此操作不可撤销；总字数与前台缓存会随之刷新。',
  'recycle.draftRestoreSuccess': '已恢复草稿{label}，它已回到草稿列表。如果它曾发布过：已发布的文章不受影响，这只是发布前的旧草稿。',
  'recycle.draftPurgeSuccess': '已永久删除草稿{label}，此操作不可撤销。',
  'recycle.actionRestore': '恢复',
  'recycle.actionPurge': '永久删除',
  'recycle.actionFallback': '操作',
  'recycle.labelArticle': '文章',
  'recycle.labelDraft': '草稿',
  'recycle.labelFallback': '内容',
  'recycle.listFailure404': '当前 server 还没有回收站接口（404）：请把 server 升级到包含「文章回收站」的版本后再用这个列表。',
  'recycle.detailWrap': '（{message}）',
  'recycle.listFailureGeneric': '回收站列表加载失败{detail}，请稍后重试；这不影响文章管理里的其它功能。',
  'recycle.actionFailure404': '这条{label}已不在回收站中（可能刚被恢复或已被永久删除），列表将刷新为最新状态。',
  'recycle.permissionWrap': '（需要 {permission}）',
  'recycle.actionFailure403': '当前账号没有{action}这条{label}的权限{permission}，请联系管理员。',
  'recycle.actionFailure401': '登录已失效，请重新登录后再试。',
  'recycle.actionFailureGeneric': '{action}失败{detail}，请稍后重试。',


  // ── 🔴 期 3 第三批：SystemConfig 的「Token 管理」与「高级设置」两个页签（41 条）──
  //    zh-CN 的值由脚本**直接从源码的 defaultMessage 抽出**（构造出逐字相同，不靠人核对）。
  //    🔴 `common.colOption` 是从 `recycle.colOption` **提升**上来的：「操作」这一列头在回收站与 Token 页
  //    是同一个性质 ⇒ 一个 key（提升后 RecycleBin 也改用它，不留同值的第二处口径）。
  //    ⚠️ `common.enabled`/`common.disabled`（开启/关闭）与 `sysconf.comment.on`/`off`（开/关）刻意分开：
  //    前者是**通用开关选项**（英文 Enabled/Disabled），后者是评论系统那一档的**短标签**（英文 On/Off），
  //    是两个不同性质，不是同值重复。
  'common.colName': '名称',
  'common.colContent': '内容',
  'common.colOption': '操作',
  'sysconf.token.deleteConfirmBody': '是否确认删除该 Token？',
  'common.deleteSuccess': '删除成功！',
  'common.delete': '删除',
  'sysconf.token.title': 'Token 管理',
  'sysconf.token.createTitle': '新建 API Token',
  'common.create': '新建',
  'sysconf.token.swaggerOffWithDocs': '实时 API 文档（swagger）默认关闭：设 VANBLOG_SWAGGER=true 并重启后可用。已为你打开仓库里的 API 文档。',
  'sysconf.token.swaggerOff': '实时 API 文档（swagger）默认关闭：设 VANBLOG_SWAGGER=true 并重启后可用。',
  'sysconf.token.apiDocs': 'API 文档',
  'sysconf.token.helpTitle': 'Token 管理功能介绍',
  'sysconf.token.helpP1': '创建的 Api Token 可以用来调用 VanBlog 的 API',
  'sysconf.token.helpP2': '结合 API 文档，您可以做到很多有意思的事情。',
  'sysconf.token.helpP3': 'API 文档现在比较水，会慢慢完善的，未来会有 API Playgroud，敬请期待。',
  'sysconf.token.helpP4': 'PS：暂时没必要通过 API 开发自己的前台，后面会出主题功能（完善的文档和开发指南，不限制技术栈），届时再开发会更好。',
  'sysconf.advance.loginCard': '登录安全策略',
  'sysconf.advance.retryLockedAlert': '开启最大登录失败次数限制目前还不稳定！暂时先不可配置，稳定后开放。',
  'sysconf.advance.demoBlockedLogin': '演示站禁止修改登录安全策略！',
  'sysconf.advance.maxRetryLabel': '开启最大登录失败次数限制',
  'common.enabled': '开启',
  'common.disabled': '关闭',
  'sysconf.advance.maxRetryTooltip': '设置里没有显式关掉时是开启的：同一访客 IP 连续登录失败 5 次后要等 5 分钟才能再试（服务端默认值；此项在界面里是锁定的）',
  'sysconf.advance.expiresInLabel': '登录凭证(Token)有效期(秒)',
  'sysconf.advance.expiresInPlaceholder': '默认为 7 天',
  'sysconf.advance.expiresInTooltip': '默认为 7 天。最小 60 秒：这个值会原样进 JWT 的 expiresIn，0/负数会让签出来的 token 立刻过期（登录看起来成功、下一个请求就被踢回登录页），所以在表单这一层就夹住。',
  'sysconf.advance.isrCard': '静态页面更新策略',
  'sysconf.advance.demoBlockedIsr': '演示站禁止修改静态页面更新策略！',
  'sysconf.advance.isrModeDelay': '延时自动',
  'sysconf.advance.isrModeOnDemand': '按需自动',
  'sysconf.advance.isrModeTooltip': '默认「按需自动」：后台有改动时由后端立刻触发重渲染，实时性高、可能需要更多性能。改成「延时自动」则按下面的秒数周期性重建。',
  'sysconf.advance.delayLabel': '延时自动更新时间(秒)',
  'sysconf.advance.delayTooltip': '仅在「延时自动更新」模式下生效：每隔这么多秒，前台会尝试用最新的后端数据重新生成静态页面。\n\n前台会把这个值夹到最小 60 秒（填更小也按 60 算），填非数字会被忽略而不是让构建失败。\n\n默认的「按需更新」模式不看这个值：改文章时由后端主动触发重渲染，另外有一个 24 小时的兜底周期，万一某次触发丢了也能自愈。',
  'sysconf.advance.isrManualCard': '手动触发静态页面更新',
  'sysconf.advance.isrManualAlert': '通常来说你不需要这样做，但某些情况下你也可以手动触发增量渲染。这会让后端尝试重新验证/渲染已知所有路由（触发完成后需要一些时间生效）。',
  'sysconf.advance.isrManualOk': 'ISR 手动触发成功！',
  'sysconf.advance.isrManualFail': 'ISR 触发失败！',
  'sysconf.advance.isrManualBtn': '手动触发',


  // ── 🔴 期 3 第四批：SystemConfig 的「用户设置」页签（19 条）──
  //    `common.deleteConfirmTitle` 是从 `sysconf.token.deleteConfirmTitle` **提升**上来的（Token 页与用户页同一个性质）。
  //    ⚠️ 权限列里的**权限名**仍是中文：它来自 `getPermissionLabel()`（CollaboratorModal 的口径），
  //    属于那一批的工作量 ⇒ 🔴 刻意不在这里翻第二遍（同一份权限名两处口径必然漂）。
  //    ⚠️ 口令最短长度的提示（`accountPasswordMinRule()`）是**共享常量**，被 passwordPolicy.test.js 钉着 ⇒ 本批不动。
  'common.colUsername': '用户名',
  'common.colNickname': '昵称',
  'common.colPermissions': '权限',
  'sysconf.user.collaboratorUpdated': '修改协作者成功！',
  'common.edit': '修改',
  // 🔴 `common.editPost`（编辑）与 `common.edit`（修改）刻意分开：中文是两个词，英文都是 Edit
  'common.editPost': '编辑',
  'common.deleteConfirmTitle': '删除确认',
  'sysconf.user.collaboratorDeleteConfirm': '是否确认删除该协作者？',
  'sysconf.user.cardTitle': '用户设置',
  'sysconf.user.updateOk': '更新用户成功！请重新登录！',
  'sysconf.user.usernameLabel': '登录用户名',
  'sysconf.user.usernamePlaceholder': '请输入登录用户名',
  'sysconf.user.passwordLabel': '登录密码',
  'sysconf.user.passwordPlaceholder': '请输入登录密码',
  'sysconf.user.collaboratorCard': '协作者',
  'sysconf.user.collaboratorCreated': '新建协作者成功！',
  'sysconf.user.helpTitle': '协作者功能',
  'sysconf.user.helpP1': '您可以添加一些具有指定权限的协作者用户。',
  'sysconf.user.helpP2': '协作者默认具有文章、草稿、图片的查看/上传权限，其余权限需要您显式指定。',
  'sysconf.user.helpP3': '协作者登录后将看到被精简的后台页面（除非此协作者具备所有权限），同时无权限的接口将抛错。',


  // ── 🔴 期 3 第五批：SystemConfig 的「HTTPS」页签（Caddy，32 条）──
  //    zh-CN 的值由脚本**直接从源码的 defaultMessage 抽出**（构造出逐字相同）。
  //    🔴 `common.relatedDocs` 是从 `sysconf.token.relatedDocs` **提升**上来的（Token 页与 HTTPS 页同一个性质）。
  //    ⚠️ 本页签有一条中文**永远不翻**：那个 FAQ 链接的 URL 锚点（`…usage.md#开启了-https-重定向后关不掉`）
  //    必须逐字对上中文文档的标题（站长已裁定文档暂不做 i18n）⇒ 它在棘轮里的预算是 1，属**永久例外**、不是欠账。
  //    ⚠️ 顺带记录（未改）：zh-CN 原文 `触发请后稍等一会` 疑为笔误（应为「触发后」）—— 属**中文文案修订**，
  //    不在多语言批次范围里，交站长裁定后再动（改了要三份包同步改，否则对账会红）。
  'sysconf.caddy.changedOk': '更改成功！将自动刷新至新协议',
  'sysconf.caddy.updateFailed': '更新失败！',
  'sysconf.caddy.card': 'HTTPS 相关配置',
  'sysconf.caddy.introPrefix': 'VanBlog 是通过',
  'sysconf.caddy.introSuffix': '实现的证书全自动按需申请。',
  'common.relatedDocs': '相关文档',
  'sysconf.caddy.advancedHint': '高级玩家可点击按钮查看 Caddy 运行日志或配置排查错误。',
  'sysconf.caddy.accessLogHint': 'access 日志可进入容器 /var/log/vanblog-access.log 查看',
  'sysconf.caddy.portsHint': '请确保 80/443 端口处于开放状态。',
  'sysconf.caddy.firstVisitHint': '第一次通过某域名 https 访问时，如果没有证书会自动申请证书的。你也可以点击下面的按钮手动触发证书申请。',
  'sysconf.caddy.stableHint': '稳定后可打开 https 自动重定向功能，开启通过 http 访问将自动跳转至 https。开启后请用无痕窗口访问 http://你的域名 确认会跳到 https；也可点「查看 Caddy 配置」，srv1 的 listener_wrappers 应含 http_redirect。',
  'sysconf.caddy.reverseProxyWarn': '如果你用了 80 端口反代，请不要开启 https 自动重定向！否则你的反代可能会失效。',
  'sysconf.caddy.stuckPrefix': '如果不小心开启了此选项后关不掉，可以参考：',
  'sysconf.caddy.stuckLink': '开启了 https 重定向后关不掉',
  'sysconf.caddy.demoBlocked': '演示站不可修改此选项，不然怕 k8s ingress 失效',
  'sysconf.caddy.noChange': '未修改任何信息，无需保存！',
  'sysconf.caddy.confirmOff': '确定关闭 https 自动重定向吗？关闭后可通过 http 进行访问。点击确定后 2 秒将自动切换到 http 访问',
  'sysconf.caddy.confirmOn': '开启 https 自动重定向之前，请确保通过域名可正常用 https 访问本站。开启将无法使用 http 访问本站。点击确定后 2 秒将自动切换到 https 访问。注意如果是自己反代了 80 端口的话，请务必不要开启此项！',
  'sysconf.caddy.configTitle': 'Caddy 配置',
  'sysconf.caddy.configError': '获取 Caddy 配置错误！',
  'sysconf.caddy.viewConfig': '查看 Caddy 配置',
  'sysconf.caddy.logTitle': 'Caddy 运行日志',
  'sysconf.caddy.logError': '获取 Caddy 日志错误！',
  'sysconf.caddy.viewLog': '查看 Caddy 日志',
  'sysconf.caddy.clearLogConfirm': '确定清除 Caddy 运行日志吗？清除后将无法恢复！',
  'sysconf.caddy.clearLogOk': '清除 Caddy 运行日志成功！',
  'sysconf.caddy.clearLog': '清除 Caddy 日志',
  'sysconf.caddy.triggerCertTitle': '触发证书按需申请',
  'sysconf.caddy.triggerCertContent': '点击确认后将打开新窗口并用 https 访问当前网址以触发证书按需申请。触发请后稍等一会（申请时间取决于网络环境），申请完成后弹出页面将通过 https 正常加载。',
  'sysconf.caddy.triggerCertBtn': '使用当前访问域名触发按需申请',
  'sysconf.caddy.redirectLabel': 'HTTPS 自动重定向',
  'sysconf.caddy.redirectTooltip': '开启后通过 http 访问本站将自动重定向至 https',


  // ── 🔴 期 4：`components/SiteInfoForm`（站点设置表单，106 条 —— 目前**最大的单文件批次**）──
  //    zh-CN 的值由脚本**直接从源码的 defaultMessage 抽出**（AST 定位 + 偏移替换，150 个替换点）。
  //    🔴 key 用 `siteInfo.<字段名>.<label|placeholder|tooltip|枚举键>`（3 段，命名守卫认）。
  //    🔴 通用词**复用**而不新增同值第二个：显示/隐藏/允许/不允许 → `common.show|hide|allow|disallow`，
  //    开启/关闭 → 既有的 `common.enabled|disabled`，「这是必填项」→ 既有的 `init.field.required`。
  //    ⚠️ `siteInfo.uiStyle.apple|default` 在 `request` 的 builtin 数组与 `valueEnum` 里**共用同一个 key**
  //    （同一个性质 ⇒ 一处口径）；`{{siteName}}` 这类是**文案里的字面占位符**、不是 ICU 的，三份包必须原样保留。
  //    ⚠️ GA / 百度统计那两个统计 ID 字段的文案来自共享模块 `@/utils/analysisFields`（被 `analysisFields` 守卫
  //    与文档措辞钉在一起）⇒ 🔴 **刻意不在本批翻**，属已裁定的暂缓项。
  'siteInfo.author.label': '作者名字',
  'siteInfo.author.placeholder': '请输入作者名字',
  'siteInfo.authorDesc.label': '作者描述',
  'siteInfo.authorDesc.placeholder': '请输入作者描述',
  'siteInfo.authorLogo.label': '作者 Logo',
  'siteInfo.authorLogo.placeholder': '请输入作者 Logo Url',
  'siteInfo.authorLogoDark.label': '作者 Logo（黑暗模式）',
  'siteInfo.authorLogoDark.placeholder': '请输入黑暗模式作者 Logo Url，留空表示沿用上个',
  'siteInfo.siteLogo.label': '网站 Logo',
  'siteInfo.siteLogo.placeholder': '请输入网站 Logo Url',
  'siteInfo.siteLogoDark.label': '网站 Logo（黑暗模式）',
  'siteInfo.siteLogoDark.placeholder': '请输入网站黑暗模式 Logo Url，留空表示沿用上个',
  'siteInfo.favicon.label': '网站图标(favicon)',
  'siteInfo.favicon.placeholder': '请输入网站图标 Url',
  'siteInfo.siteName.label': '网站名',
  'siteInfo.siteName.placeholder': '请输入网站名',
  'siteInfo.siteDesc.label': '网站描述',
  'siteInfo.siteDesc.placeholder': '请输入网站描述',
  'siteInfo.payAliPay.label': '支付宝图片 Url',
  'siteInfo.payAliPay.placeholder': '请输入支付宝打赏图片 Url，留空不启用打赏',
  'siteInfo.payAliPayDark.label': '支付宝图片 Url（黑暗模式）',
  'siteInfo.payAliPayDark.placeholder': '请输入黑暗模式支付宝打赏图片 Url，留空沿用上个',
  'siteInfo.payWechat.label': '微信图片 Url',
  'siteInfo.payWechat.placeholder': '请输入微信打赏图片 Url，留空不启用打赏',
  'siteInfo.payWechatDark.label': '微信图片 Url（黑暗模式）',
  'siteInfo.payWechatDark.placeholder': '请输入黑暗模式微信打赏图片 Url，留空沿用上个',
  'siteInfo.baseUrl.label': '网站 Url',
  'siteInfo.baseUrl.placeholder': '请输入包含访问协议的完整 URL',
  'siteInfo.baseUrl.tooltip': '请输入包含访问协议的完整 URL，此 URL 会被用来生成前后台/RSS的相关数据。',
  'siteInfo.copyrightAggreement.label': '版权协议',
  'siteInfo.beianNumber.label': 'ICP 备案号',
  'siteInfo.beianNumber.placeholder': '请输入备案号，留空不显示备案信息',
  'siteInfo.beianUrl.label': 'ICP 备案网址',
  'siteInfo.beianUrl.placeholder': '请输入备案网址，留空不显示备案信息',
  'siteInfo.gaBeianNumber.label': '公安备案号',
  'siteInfo.gaBeianNumber.placeholder': '请输入公安备案号，留空不显示公安备案信息',
  'siteInfo.gaBeianUrl.label': '公安备案网址',
  'siteInfo.gaBeianUrl.placeholder': '请输入公安备案号点击后跳转的网址，留空则不跳转',
  'siteInfo.gaBeianLogoUrl.label': '公安备案 Logo 地址',
  'siteInfo.gaBeianLogoUrl.placeholder': '请输入公安备案的 logo 的 url，留空不显示公安备案 logo',
  'siteInfo.enableComment.label': '是否开启评论系统',
  'siteInfo.enableComment.tooltip': '默认开启',
  'siteInfo.since.label': '建站时间',
  'siteInfo.since.placeholder': '不填默认为此刻',
  'siteInfo.articlesPerPage.label': '每页文章数',
  'siteInfo.articlesPerPage.tooltip': '前台首页与 /page/n 每页展示的文章数量。默认 5，范围 1–50。分类/标签/时间线仍是完整列表。',
  'siteInfo.uiStyle.label': '界面风格',
  'siteInfo.uiStyle.placeholder': 'Apple 风格',
  'siteInfo.uiStyle.tooltip': '前台展示页的视觉风格。Apple 风格参考 developer.apple.com/news：单列发丝线分隔的列表、SF Pro 字体、17px 正文、毛玻璃导航、苹果蓝强调色，并自动适配暗色模式。只改样式不改结构，随时可切回默认。除了内置的两个，这里还会列出「系统设置 → 主题」里上传的自定义主题（上传/管理请去那个页签）。',
  'siteInfo.uiStyle.apple': 'Apple 风格（推荐）',
  'siteInfo.uiStyle.default': '默认（原卡片风格）',
  'siteInfo.showSubMenu.label': '显示分类导航栏',
  'common.hide': '隐藏',
  'common.show': '显示',
  'siteInfo.showSubMenu.tooltip': '默认隐藏，开启后将在主导航栏下方显示分类子导航栏（其实就是双层导航栏）。',
  'siteInfo.subMenuOffset.label': '分类导航栏左侧偏移（px）',
  'siteInfo.subMenuOffset.tooltip': '导航栏显示的是网站名的时候，设置正确偏移以对其分类第一个字。',
  'siteInfo.headerLeftContent.label': '导航栏左侧显示内容',
  'siteInfo.headerLeftContent.siteLogo': '网站logo',
  'siteInfo.headerLeftContent.siteName': '网站名',
  'siteInfo.headerLeftContent.tooltip': '显示网站 logo 的前提是已设置正确的网站 logo 哦。默认显示网站名',
  'siteInfo.showAdminButton.label': '后台按钮是否显示',
  'siteInfo.showAdminButton.tooltip': '默认显示，关闭后前台会隐藏后台按钮',
  'siteInfo.showDonateInfo.label': '是否显示捐赠信息',
  'siteInfo.showDonateInfo.tooltip': '默认显示，关闭后关于页面会隐藏捐赠信息',
  'siteInfo.showCopyRight.label': '是否显示版权声明',
  'siteInfo.showCopyRight.tooltip': '默认显示，关闭后文章页面将不显示版权声明',
  'siteInfo.showDonateButton.label': '是否显示打赏按钮',
  'siteInfo.showDonateButton.tooltip': '默认显示（前提是设置了支付宝和微信支付图片），关闭后所有位置将不显示打赏按钮',
  'siteInfo.showDonateInAbout.label': '关于页面是否显示打赏按钮',
  'siteInfo.showDonateInAbout.tooltip': '默认隐藏，开启后关于页面会显示打赏按钮',
  'siteInfo.defaultTheme.label': '前台默认主题模式',
  'siteInfo.defaultTheme.placeholder': '自动模式',
  'siteInfo.defaultTheme.dark': '暗色模式',
  'siteInfo.defaultTheme.light': '亮色模式',
  'siteInfo.defaultTheme.tooltip': '设置后第一次进入前台的用户将以此作为默认主题模式',
  'siteInfo.allowOpenHiddenPostByUrl.label': '是否允许通过 URL 打开隐藏的文章',
  'common.disallow': '不允许',
  'common.allow': '允许',
  'siteInfo.allowOpenHiddenPostByUrl.tooltip': '默认不允许，开启后可通过 URL 打开隐藏文章。',
  'siteInfo.enableCustomizing.label': '是否开启定制化功能',
  'siteInfo.enableCustomizing.tooltip': '默认开启，关闭后即使通过定制化面板，自定义了 CSS、Script、HTML 也不会生效。',
  'siteInfo.showRSS.label': '是否显示 RSS 按钮',
  'siteInfo.showRSS.tooltip': '默认显示，关闭后所有位置会隐藏 RSS 按钮。',
  'siteInfo.defaultExpandAllCategories.label': '分类页默认展开全部分类',
  'siteInfo.defaultExpandAllCategories.placeholder': '默认收起',
  'siteInfo.defaultExpandAllCategories.true': '默认展开',
  'siteInfo.defaultExpandAllCategories.tooltip': '默认收起，和升级前一样。开启后打开前台分类列表时全部分类都是展开的。单篇分类页、标签页和时间线不受影响。访客仍可点分类行或「全部展开 / 全部收起」临时切换。',
  'siteInfo.openArticleLinksInNewWindow.label': '前台点击链接时的默认行为',
  'siteInfo.openArticleLinksInNewWindow.placeholder': '在当前页面跳转',
  'siteInfo.openArticleLinksInNewWindow.true': '打开新标签页',
  'siteInfo.openArticleLinksInNewWindow.tooltip': '默认在当前页面跳转，会影响除了导航栏之外的大部分链接。注意如果打开新标签的话，就不会那么丝滑了哦（当前页面跳转的话是无感切换的）',
  'siteInfo.showExpirationReminder.label': '是否显示文章内容过时提醒',
  'siteInfo.showExpirationReminder.tooltip': '默认显示，关闭后文章页面不会显示内容过期提醒。',
  'siteInfo.showEditButton.label': '是否在前台展示编辑按钮',
  'siteInfo.showEditButton.tooltip': '默认开启，关闭后登录后台时，前台将不再显示编辑按钮。',
  'siteInfo.friendLinkIntro.label': '友链页介绍文案',
  'siteInfo.friendLinkIntro.placeholder': '以下是本站的友情链接，排名不分先后：',
  'siteInfo.friendLinkIntro.tooltip': '友链列表上方的介绍。留空则使用升级前的默认文案。',
  'siteInfo.friendLinkApplyContent.label': '友链页底部文案',
  'siteInfo.friendLinkApplyContent.placeholder': '留空则使用默认的申领要求与本站信息',
  'siteInfo.friendLinkApplyContent.tooltip': '友链列表下方的 Markdown。留空保持升级前的申领要求。可用占位符 {{siteName}}、{{description}}、{{url}}、{{logo}} 插入本站信息。',
  'siteInfo.aboutTitle.label': '关于页标题',
  'siteInfo.aboutTitle.placeholder': '关于我',
  'siteInfo.aboutTitle.tooltip': '前台关于页标题。留空则为「关于我」。关于页正文仍在文章管理里点「编辑关于」修改，不是这段设置。',
  'siteInfo.uiStyle.customSuffix': '（自定义·{id}）',


  // ── 🔴 期 5 第一批：`components/WaterMarkForm`（图床设置里的压缩/水印/缩略图表单，31 条）──
  //    zh-CN 的值由脚本**直接从源码的 defaultMessage 抽出**（AST 定位 + 偏移替换，35 个替换点）。
  //    🔴 新组 `watermark`：这是**跨页复用的组件**（被 SystemConfig 的图床设置页签用），按组件名做组；
  //    不放 `sysconf.img.*` 是因为那会变成 **4 段**（命名守卫不允许）。
  //    ⚠️ 通用词复用：开启/关闭 → `common.enabled|disabled`，「这是必填项」→ `init.field.required`，
  //    「更新成功！」→ `common.updateSuccess`（🔴 不新增同值的第二处口径）。
  //    🔴 这批文案里的**数字与技术门槛**（52px / 8px / 320 / 1920 / 8x8 / 4 个色阶 / 200 字节 / 300px / 10KB）
  //    是**契约**：`watermarkText.test.js` 有一条跨包钉子把 52px 与服务端 `utils/watermark.ts` 钉在一起，
  //    所以生成脚本逐个 key 比对了三份的**数字序列**与环境变量名/技术词（sharp、avifenc、WARN、GIF…）。
  'watermark.demoBlocked': '演示站禁止修改此配置！',
  'watermark.needText': '开启水印必须指定水印文字！',
  'watermark.enableWebp.label': '图片自动压缩',
  'watermark.enableWebp.placeholder': '是否开启图片自动压缩',
  'watermark.enableWebp.tooltip': '开启之后上传图片将压缩为所选格式以提高加载速度，无论哪种存储策略都生效。只影响新上传，不会改写已有文件。',
  'watermark.compressFormat.label': '压缩格式',
  'watermark.compressFormat.webp': 'WebP（默认）',
  'watermark.compressFormat.placeholder': '选择压缩输出格式',
  'watermark.compressFormat.tooltip': '仅在开启自动压缩时生效。AVIF 通常比 WebP 更小；现代浏览器已广泛支持。编码优先用 sharp（与前台同一个版本，见 package.json）；官方 Alpine 镜像若无法加载 musl sharp，则使用 libavif-apps 的 avifenc。',
  'watermark.enableWaterMark.label': '可见水印',
  'watermark.enableWaterMark.placeholder': '是否开启水印',
  'watermark.enableWaterMark.tooltip': '可见的文字水印（默认关闭，很多人嫌它挡图）。开启后上传图片会自动加上，无论哪种图床。默认样式是「满图斜排平铺」（旋转小字，裁不掉），样式与位置由服务端环境变量 VANBLOG_WATERMARK_STYLE / VANBLOG_WATERMARK_POSITION 调，不在本表单里。短边小于 52px 的图会跳过水印（服务端记一条 WARN，图片照常上传）。想要看不出来又能验真的水印，请用下面的「隐写水印」。',
  'watermark.waterMarkText.label': '可见水印文字',
  'watermark.waterMarkText.tooltip': '水印文字，可包含 .（如域名），支持中文（渲染在服务端做，官方镜像已装 Latin + 中文字体）。文字越长需要的图越大：字号会按图片尺寸自动算，放不下时自动缩小，缩到 8px 还放不下就跳过这一张（记一条 WARN，不影响上传）。',
  'watermark.waterMarkText.placeholder': '请输入水印文字',
  'watermark.enableResize.label': '大图自动缩放',
  'watermark.enableResize.placeholder': '是否缩放过大的图片',
  'watermark.enableResize.tooltip': '开启后，长边超过下面「长边上限」的图片会在上传时等比缩小（只缩不放，小图不动）。缩放发生在压缩和隐写水印之前，所以水印照样读得出来。只影响新上传的图片。',
  'watermark.maxImageEdge.label': '长边上限',
  'watermark.maxImageEdge.tooltip': '单位 px。1920 就是常说的 1080p 级；填 0 表示不限制；小于 320 的值会被抬到 320。',
  'watermark.enableThumb.label': '生成缩略图',
  'watermark.enableThumb.placeholder': '是否生成缩略图',
  'watermark.enableThumb.tooltip': '上传时额外生成一张小图（默认 300px 宽的 WebP，约 10KB），「图片管理」列表加载它而不是原图，翻几十张图快得多。存量图片在「图片管理 → 补缩略图」里一次性补齐。',
  'watermark.thumbWidth.label': '缩略图宽度',
  'watermark.thumbWidth.tooltip': '单位 px，默认 300。改完只影响之后生成的缩略图。',
  'watermark.enableStegoWaterMark.label': '隐写水印',
  'watermark.enableStegoWaterMark.placeholder': '是否嵌入隐写水印',
  'watermark.enableStegoWaterMark.tooltip': '把一段文字藏进像素里（每个 8x8 块的亮度最多动 4 个色阶，肉眼看不出来），压成 WebP、被别人另存为 JPEG 之后仍然读得出来。验证方式：图片管理里对着图片右键「检测隐写水印」，或用工具栏「检测水印」上传一张图。注意：图片被缩放或裁剪后就读不出来了；GIF 不处理。',
  'watermark.stegoWaterMarkText.label': '隐写内容',
  'watermark.stegoWaterMarkText.tooltip': '留空则自动写「域名|上传者|上传时间」，方便追到是谁什么时候传的。最多 200 字节，支持中文；内容越长，需要的图片越大（太小的图会跳过水印，不影响上传）。',
  'watermark.stegoWaterMarkText.placeholder': '留空使用默认内容',


  // ── 🔴 期 5 第一批（同轮追加）：`components/StaticForm`（图床设置里的存储策略表单，13 条）──
  //    🔴 与 WaterMarkForm 一起做，是为了让**整个「图床设置」页签**不再有中英混排：
  //    这个页签由两个表单组件拼成（ImgTab 自己的卡片标题在期 3 第一批已翻），只翻一个的话
  //    页面上会同时出现"存储策略"（简体）与"Visible watermark"（英文）—— 活体探针就是这么发现的。
  //    🔴 新组 `storage`（组件级命名空间）；通用词复用：更新成功！→ `common.updateSuccess`、这是必填项 → `init.field.required`。
  //    ⚠️ `picgoConfig` 的 label 是一个 **`<a>` 元素**（指向文档）⇒ 只翻链接文字，href 原样保留。
  'storage.demoBlocked': '演示站禁止修改图床配置！',
  'storage.picgoJsonInvalid': 'picgoConfig 格式错误，无法解析成 json',
  'storage.storageType.label': '存储策略',
  'storage.storageType.placeholder': '请选择存储策略',
  'storage.storageType.local': '本地存储',
  'storage.storageType.picgo': 'OSS 图床',
  'storage.storageType.tooltip': '本地存储之前请确保映射了永久目录以防丢失哦',
  'storage.picgoConfig.label': 'picgo 配置',
  'storage.picgoConfig.tooltip': 'OSS 图床后端采用了 picgo',
  'storage.picgoConfig.placeholder': '请输入 picgo 配置 (json)',
  'storage.picgoPlugins.label': '自定义 picgo 插件',
  'storage.picgoPlugins.tooltip': '请填写插件名（如 s3），多个请用英文逗号分隔',
  'storage.picgoPlugins.placeholder': '看不懂的话请忽略',


  // ── 🔴 期 5 第二批：图片管理页（`pages/Static/img/index.tsx` + 同目录 `tools.tsx`，70 条）──
  //    🔴 按**页面**切批次（不是按文件）：这两份文件拼成同一个页面，只翻一个会留下半页中文。
  //    `tools.tsx` 是**纯函数模块**（被 `Editor/imgUpload.tsx` 也调用）⇒ 用**注入式翻译器**：
  //    `copyImgLink(…, t = IDENTITY_T)` / `mergeMetaInfo(item, t = IDENTITY_T)`，
  //    🔴 不传 t 时输出与改造前**逐字相同** ⇒ 既有调用方一个字都不用改（与 recycleCore 同一套模式）。
  //    🔴 提升/复用：`common.colTitle`（从 recycle.colTitle 提升）、`common.download`（新增）、
  //    `common.colName`/`colOption`/`edit`/`delete`（既有）、页头标题复用 `menu.img`（与侧边栏同一个性质）。
  //    ⚠️ 英文里的 "Add thumbnails" / "Detect steganographic watermark" / "Images" 必须与
  //    `watermark.enableThumb.tooltip`、`watermark.enableStegoWaterMark.tooltip` 里提到的**逐字相同**
  //    （上一批那两条 tooltip 向前一致地引用了这几个界面词）⇒ 这批落地就把那个中间态闭合了。
  'img.detectFoundTitle': '检测到本站的隐写水印：',
  'img.detectMeta': '尺寸 {width}×{height}，重复度 {repetition}，擦边 bit {uncertain}',
  'img.detectNoneTitle': '没有检测到本站水印。',
  'img.detectNoneReasons': '常见原因：不是本站上传的图；上传时「隐写水印」是关着的；图片被缩放/裁剪过；或者站点换过水印密钥。',
  'img.detectTitle': '检测水印：{name}',
  'img.detectFailed': '检测失败！',
  'img.backfillConfirmTitle': '为所有图片生成缩略图？',
  'img.backfillConfirmContent': '已经有缩略图的会跳过，只处理本地存储的图片；图片多时可能要等一会儿。',
  'img.backfillDone': '共 {total} 张：新生成 {generated}，已存在 {existed}，跳过 {skipped}，失败 {failed}',
  'img.backfillFailed': '补缩略图失败！',
  'img.deleteOkOss': '删除成功！但是 OSS 存储中并未删除哦',
  'img.deleteOkLocal': '删除成功！已彻底删除',
  'img.deleteFailed': '删除失败！',
  'img.replaceConfirmTitle': '替换这张图片？',
  'img.replaceConfirmP1': '链接保持不变，文章里的引用会自动指向新图：',
  'img.replaceConfirmP2': '新文件同样会走缩放 / 隐写水印 / 压缩，并重新生成缩略图。原内容不可恢复。',
  'img.replaceOk': '替换成功！链接没有变化。',
  'img.replaceFailed': '替换失败！',
  'img.infoTitle': '图片信息',
  'img.deleteConfirmTitle': '确定删除该图片吗？删除后不可恢复！',
  'img.refsTitle': '被引用文章',
  'img.refsColId': '文章 ID',
  'common.colTitle': '标题',
  'img.colImage': '图片',
  'img.colFormat': '格式',
  'img.colDimensions': '尺寸',
  'img.colBytes': '大小',
  'img.colUploadedAt': '上传时间',
  'img.colRefs': '引用文章',
  'img.notReferenced': '未被引用',
  'img.refPopoverTitle': '被 {count} 篇文章引用',
  'img.refArticleFallback': '文章 {id}',
  'img.refMore': '…等共 {count} 篇',
  'img.refCount': '{count} 篇',
  'img.actCopyLink': '复制链接',
  'common.download': '下载',
  'img.actReplace': '替换',
  'img.actDetect': '检测水印',
  'img.pageTip': '设置页可更改图片存储方式、缩放与水印。对着图片点右键可解锁更多操作哦（含检测隐写水印）',
  'img.viewThumb': '小图',
  'img.viewLarge': '大图',
  'img.viewList': '列表',
  'img.backfillBtn': '补缩略图',
  'img.clipboardEmpty': '剪切板无图片！',
  'img.clipboardBtn': '剪切板上传',
  'img.clipboardNew': '剪切板图片上传成功! ',
  'img.clipboardExists': '剪切板图片已存在! ',
  'img.uploadBtn': '上传图片',
  'img.uploadNew': '{name} 上传成功! ',
  'img.uploadExists': '{name} 已存在! ',
  'img.menuCopyMarkdown': '复制 Markdown 链接',
  'img.menuCopyMarkdownAbs': '复制完整 Markdown 链接',
  'img.menuInfo': '信息',
  'img.menuSearchRefs': '搜索引用文章',
  'img.menuDetectStego': '检测隐写水印',
  'img.menuReplace': '替换图片',
  'img.empty': '暂无图片，快上传呀~',
  'img.totalCount': '共 {total} 张',
  'img.copiedMarkdown': '{prefix}已复制 markdown 链接到剪切板！',
  'img.copiedLink': '{prefix}已复制图片链接到剪切板！',
  'img.copyFailed': '{prefix}复制链接到剪切板失败！',
  'img.meta.height': '高',
  'img.meta.width': '宽',
  'img.meta.storageType': '存储',
  'img.meta.url': '外链',
  'img.meta.thumb': '缩略图',
  'img.meta.thumbWidth': '缩略图宽',
  'img.meta.thumbHeight': '缩略图高',
  'img.meta.local': '本地',


  // ── 🔴 期 5 第二批（同轮追加）：`components/ObjTable`（图片信息弹窗用的键值表，2 条）──
  //    🔴 活体探针发现它的：图片管理页翻完之后，en-US 下那个弹窗的表头仍是简体「属性/值」
  //    ⇒ 页面还差这一个组件（这一页由 index.tsx + tools.tsx + ObjTable **三块**拼成）。
  //    它是跨页可复用的通用组件 ⇒ 两个列头进 `common.*`（与 名称/操作/标题 同一类）。
  'common.colProperty': '属性',
  'common.colValue': '值',


  // ── 🔴 期 5 第三批：自定义页面（`pages/CustomPage/index.jsx` + `components/CustomPageModal`，36 条）──
  //    🔴 按**页面**切批次：列表页与它的新建/修改弹窗是同一页的两块，只翻一块会留下半页中文。
  //    🔴 卡片标题**复用** `menu.site.customPage`（同一个东西 ⇒ 一处口径，与图片管理页复用 menu.img 同做法）。
  //    ⚠️ 帮助弹窗是"文本 + <code>/<strong> + 文本"的混排 ⇒ 拆成 helpP1a/P1b、helpP3a/P3b/P3strong/P3c、
  //    helpP4a…P4e 这些**片段** key；`customPage.helpPathSample`（/c/路径/）在三处复用同一个 key。
  //    🔴 片段的译文必须能按 JSX 顺序拼成一句通顺的话（英文是照着拼出来的整句校对的，不是逐段直译）。
  'customPage.type': '类型',
  'customPage.typeFile': '单文件页面',
  'customPage.typeFolder': '多文件页面',
  'customPage.colPath': '路径',
  'customPage.editContent': '编辑内容',
  'customPage.fileManager': '文件管理',
  'common.view': '查看',
  'common.editInfo': '修改信息',
  'customPage.demoBlocked': '演示站不可修改此项！',
  'customPage.deleteConfirmBody': '是否确认删除该自定义页面？',
  'customPage.helpP1a': '自定义页面把静态内容挂到站点的',
  'customPage.helpPathSample': '/c/路径/',
  'customPage.helpP1b': '下，不是通用应用托管。',
  'customPage.helpP2': '分为两种：单文件页面（后台编辑一段 HTML）、多文件页面（上传 HTML/CSS/JS 等静态文件）。',
  'customPage.helpP3a': '多文件页面访问',
  'customPage.helpP3b': '时读取',
  'customPage.helpP3strong': '根目录的 index.html',
  'customPage.helpP3c': '。请在文件树根上确认能看到它，不要多包一层解压文件夹。',
  'customPage.helpP4a': 'React / Vue 等 SPA 若资源写成',
  'customPage.helpP4b': '这种站点根路径，放到',
  'customPage.helpP4c': '下通常是白屏。请改成相对路径（如',
  'customPage.helpP4d': '），或构建时把 homepage / base 设为',
  'customPage.helpP4e': '。需要后端或独立域名时请用反代，不要把整个项目塞进自定义页面。',
  'customPage.createdOk': '新建成功！',
  'customPage.modalEditTitle': '修改自定义页面',
  'customPage.modalCreateTitle': '新建自定义页面',
  'customPage.pathMustStartSlash': '路径必须以斜杠为开头！',
  'customPage.pathMustBeSingleLevel': '路径必须是单级，例如 /uptime（对应 /c/uptime/），不要写成 /foo/bar',
  'customPage.createAlert': '创建后到列表里编辑内容或上传文件。多文件页面只托管静态 HTML/CSS/JS，入口必须是根目录的 index.html（路径 /uptime 对应 /c/uptime/）。带 /static/... 绝对路径的 React 打包产物通常打不开，请改相对路径或用反代。',
  'customPage.typeTooltip': '单文件：后台编辑一段 HTML。多文件：上传 HTML/CSS/JS 等静态文件；不支持 Node/PHP 后端。SPA 请用相对资源路径，并保证根目录有 index.html。',
  'customPage.typePlaceholder': '请选择类型',
  'customPage.namePlaceholder': '请输入名称',
  'customPage.nameTooltip': '自定义页面的名称',
  'customPage.pathPlaceholder': '例如 /uptime',
  'customPage.pathTooltip': '必须以 / 开头，且只能有一级，例如 /uptime。实际地址是 /c + 路径，即 /c/uptime/。多文件页面会读取该目录下的 index.html。',


  // ── 🔴 期 5 第四批：日志管理（`pages/LogManage/**`，4 个文件 / 21 条）──
  //    一个页面 = index（三个页签）+ 三个子表（系统 / 流水线 / 登录）⇒ 一起做，别留半页中文。
  //    🔴 页签标签与子表的 headerTitle 是**同一个东西**（同一种日志的名字）⇒ 共用 `log.system/pipeline/login`。
  //    🔴 提升/新增通用词：`common.colIndex`（从 customPage.colIndex 提升，三个页面都有「序号」列）、
  //    `common.success` / `common.fail`（两个表都用）、`common.manualRefresh`；`名称` 复用 common.colName。
  //    ⚠️ `System.tsx` 的 error state 从"存文案"改成"存布尔"：fetchLog 被 setInterval 抓住、
  //    useEffect 依赖是 [] ⇒ 那个闭包永远是首次渲染的（切语言后会用旧语言写提示，§7.144 B）。
  //    🔴 而 `console.error('[系统日志] 拉取失败')` **刻意不翻**：日志是开发者界面，翻了 grep 就抓不到
  //    （已被 bareChinese 的口径排除，见手册 §7.153 A）。
  'log.system': '系统日志',
  'log.pipeline': '流水线日志',
  'log.login': '登录日志',
  'common.colIndex': '序号',
  'log.colLoginTime': '登录时间',
  'log.colLoginAddress': '登录地址',
  'log.colLoginIp': '登录IP',
  'log.colLoginDevice': '登录设备',
  'log.colLoginStatus': '登录状态',
  'common.success': '成功',
  'common.fail': '失败',
  'log.colPipelineId': '流水线 id',
  'log.colTriggerEvent': '触发事件',
  'log.colResult': '结果',
  'log.detail': '详情',
  'log.scriptLogs': '脚本日志：',
  'log.input': '输入：',
  'log.output': '输出：',
  'log.systemCardTitle': '系统日志（每5s自动刷新）',
  'common.manualRefresh': '手动刷新',
  'log.systemFetchFailed': '日志拉取失败（server 不可达或会话过期），每 5 秒会自动重试',


  // ── 🔴 期 5 第五批：草稿管理页（index + columes + 新建/导入弹窗 + 三个共用字段组件，26 条）──
  //    🔴 表头标题**复用** `menu.draft`（与图片管理复用 menu.img、自定义页面复用 menu.site.customPage 同做法）。
  //    🔴 提升：`recycle.colCategory` / `recycle.colTags` / `recycle.colAuthor` → `common.col*`
  //    （回收站的列、草稿/文章列表的列、表单字段标签是**同一个性质** ⇒ 一个 key；
  //    同步改了 RecycleBin/index.jsx 与三处按 key 定位的守卫锚点）。
  //    ⚠️ `common.fieldRequired`（此项为必填项）与既有 `init.field.required`（这是必填项）
  //    🔴 是**两句不同的中文**，不是同值重复；要不要统一属中文文案修订，交站长裁定。
  //    ⚠️ `common.createdAtPlaceholder`（不填默认为此刻）与 `siteInfo.since.placeholder` 同文，
  //    但一个是**站点创建时间**、一个是**草稿创建时间** ⇒ 不同性质，刻意不合并。
  'common.batchDeleteOk': '批量删除成功！',
  'common.batchDelete': '批量删除',
  'common.batchExport': '批量导出',
  'common.clearSelection': '取消选择',
  'common.importOk': '导入成功！',
  'common.recycleBin': '回收站',
  'draft.colTitleTip': '标题过长会自动收缩',
  'common.fieldRequired': '此项为必填项',
  'common.searchOrSelect': '请搜索或选择',
  'common.createdAt': '创建时间',
  'common.publish': '发布',
  'draft.deleteConfirmTitle': '确定删除草稿 "{title}" 吗？',
  'draft.deleteConfirmContent': '删除后草稿会移入本页工具栏的「回收站」，可随时恢复；只有在回收站里「永久删除」才不可撤销。',
  'common.movedToRecycleOk': '删除成功，已移入回收站（可恢复）!',
  'common.importHint': '从 markdown 文件导入，可多选',
  'common.importBtn': '导入',
  'draft.importTitle': '导入草稿',
  'common.articleTitle': '文章标题',
  'common.titlePlaceholder': '请输入标题',
  'common.categoryPlaceholder': '请选择分类',
  'common.categoryTooltip': '首次使用请先在站点管理-数据管理-分类管理中添加分类',
  'common.content': '内容',
  'draft.newTitle': '新建草稿',
  'common.createdAtPlaceholder': '不填默认为此刻',
  'common.authorPlaceholder': '不填默认为登录者本人',
  'common.export': '导出',


  // ── 🔴 期 5 第六批：文章/草稿的「修改信息」与「发布草稿」两个弹窗（26 条）──
  //    🔴 绝大多数放 `common.*`：`NewArticleModal` / `ImportArticleModal` / 文章列表**下一批就要复用**
  //    （是否加密 / 置顶优先级 / 密码 / 是否隐藏 / 版权声明 / 文章标题… 是同一片字段）。
  //    🔴 提升：`customPage.editInfo` → `common.editInfo`（自定义页面与文章/草稿的"修改信息"是同一个动作）。
  //    ⚠️ 🔴 **欠条 1 条**（记在棘轮里，TOTAL 53 → 54）：`UpdateModal` 里 `clearConfirmTitle` 的实参「这篇文章」
  //    与 `clearConfirmContent` 的同名实参是中文，而模板本体在服务层 `accessPassword.js`
  //    ⇒ 两处必须**一起**翻（只翻实参会拼出「确定清除this post的访问密码？」这种半截话）。
  //    还款条件：`services/van-blog/accessPassword.js` 那批（18 条）落地时一起改掉，预算归 0。
  //    ⚠️ 另外这些**服务层常量**本轮不动（各有专门守卫钉着，属期 7）：`PUBLISH_AT_*`（schedule.js）、
  //    `PATHNAME_FIELD`（importPathname.js）、`PRIVATE_TOGGLE_HINT` / `passwordHelp` / `passwordPlaceholder` /
  //    `CLEAR_PASSWORD_*`（accessPassword.js）、`TAG_FIELD_*`（tagTokens.js）、`COVER_FIELD`（CoverImageField）
  //    ⇒ 🔴 切英文时这两个弹窗里上述几处仍是中文（已记录的中间态，不是漏翻）。
  'common.demoBlockedUpdate': '演示站禁止修改信息！',
  'common.demoBlockedReason': '本来是可以的，但有个人在演示站首页放黄色信息，所以关了这个权限了。',
  'common.okClear': '确定清除',
  'common.cancelReconsider': '再想想',
  'common.okSaveAnyway': '仍要保存',
  'common.cancelGoBack': '回去改时间',
  'common.articleUpdated': '修改文章成功！',
  'common.draftUpdated': '修改草稿成功！',
  'common.updateFailedCheck': '修改失败，请检查填写的内容！',
  'common.topPriority': '置顶优先级',
  'common.topPriorityPlaceholder': '留空或0表示不置顶，其余数字越大表示优先级越高',
  'common.encrypted': '是否加密',
  'common.no': '否',
  'common.yes': '是',
  'common.password': '密码',
  'common.passwordTooltipSet': '已设置密码。留空表示不修改；填新值表示改密码。',
  'common.passwordTooltipUnset': '留空表示不加密；填了就用这个密码加密。',
  'common.clearPasswordExtra': '勾选并提交 = 解除这篇文章的加密。清除后原密码无法找回；只想换密码请不要勾选，直接在上面填新密码。',
  'common.hiddenField': '是否隐藏',
  'common.scheduledPublish': '定时发布',
  'common.copyright': '版权声明',
  'common.copyrightTooltip': '设置后会替换掉文章页底部默认的版权声明文字，留空则根据系统设置中的相关选项进行展示',
  'common.copyrightPlaceholder': '设置后会替换掉文章底部默认的版权',
  'draft.publishTitle': '发布草稿: {title}',
  'common.demoBlockedCreate': '演示站禁止新建文章！',
  'draft.publishOk': '发布成功！原草稿已自动移入草稿回收站（恢复它不会影响这篇已发布的文章）。',


  // ── 🔴 期 7 第一批：**服务层常量怎么接 i18n** —— `services/van-blog/accessPassword.js`（15 条）──
  //    🔴 这是"模块级常量/纯函数产出文案"的**框架解法**（与 recycleCore.js、Static/img/tools.tsx 同一套）：
  //    每个产文案的函数收一个**尾参** `t = IDENTITY_T`；不传 t 时用 defaultMessage 做 `{k}` 插值
  //    ⇒ 🔴 输出与改造前**逐字相同**（既有消费方 `DataManage/tabs/Category.jsx` 与
  //    `accessPassword.test.js` 那 6 条黄金样本断言一个字都没改就照旧通过）。
  //    🔴 4 个 SCREAMING_CASE 常量保留为**同一份文案的 identity 视图**（`privateToggleHint()` 这样求值一次），
  //    留给还没接 i18n 的消费方与 `assert.equal(CLEAR_PASSWORD_LABEL, ...)` 这类断言；
  //    中文仍然只有一份（在函数的 defaultMessage 里）⇒ 不存在两处口径。已接 i18n 的组件一律用**函数 + t**。
  //    🔴 顺带还掉 §7.155 A 那张欠条：`clearConfirmTitle(t(accessPassword.targetThisArticle), t)` ——
  //    实参与模板**一起**翻，模板改成 ICU `{target}`（英文语序不同，拼接式翻不对）。
  //    ⚠️ 这是**安全相关文案**（密码不可找回、清除即解除加密）⇒ 译文逐句对着中文核过，不意译、不省后果。
  'accessPassword.unrecoverable': '密码以 scrypt 哈希存储，服务端也读不出来：忘记或清除之后无法找回，只能重新设置。',
  'accessPassword.clearLabel': '清除密码',
  'accessPassword.clearTooltip': '勾上并提交 = 解除加密（服务端把密码置空）。不勾、密码框留空 = 保持原来的密码不变。',
  'accessPassword.placeholderCreate': '留空表示不加密',
  'accessPassword.placeholderSet': '已设置密码，留空表示不修改',
  'accessPassword.helpCreate': '留空 = 不加密；填了 = 用这个密码加密。',
  'accessPassword.helpSet': '这篇/这个分类已经设过密码。留空 = 保持原密码不变；填新值 = 改成新密码；要解除加密请勾选「清除密码」。',
  'accessPassword.errBothFillAndClear': '不能同时「填写新密码」和「清除密码」：要换密码就只填新密码，要解除加密就只勾清除。',
  'accessPassword.errNothingToClear': '这篇/这个分类本来就没有设置密码，无需清除。',
  'accessPassword.errPrivateNeedsPassword': '如若加密，请填写密码！',
  'accessPassword.clearTitle': '确定清除{target}的访问密码吗？',
  'accessPassword.clearContent': '这会解除{target}的加密，任何人都能看到内容。密码是哈希存储的，清除之后「无法恢复」原来的密码；如果只是想换一个密码，请不要勾选清除，直接在密码框里填新密码。',
  'accessPassword.targetIt': '它',
  'accessPassword.privateToggleHint': '取消加密不会删除已设置的密码（要删除请用「清除密码」）；重新打开加密时会继续沿用原密码。',
  'accessPassword.targetThisArticle': '这篇文章',


  // ── 🔴 期 5 第七批：文章侧的两个弹窗 + 题头图字段（9 条新 key，**复用 25 个既有 key**）──
  //    🔴 这批最能说明"前几批把共用字段放 common.* 是对的"：22 + 19 + 7 = 48 条文案，只需要 9 个新 key。
  //    🔴 提升：`draft.importHint` / `draft.importBtn` → `common.importHint` / `common.importBtn`
  //    （草稿与文章的"导入"是同一个动作 ⇒ 一个 key）。
  //    🔴 `COVER_FIELD` 用了 §7.156 A 里定的**对象字面量常量**解法：改成 `coverField(t)` 函数，
  //    并保留 `COVER_FIELD = coverField()` 作为 identity 视图（中文只有一份，在 defaultMessage 里）。
  //    ⚠️ `cover.uploadedOk/Exists` 与 `img.uploadNew/Exists` **不是同一句**：那两条尾部有一个空格
  //    （后面还要拼"已复制…链接"），这里没有 ⇒ 各自一个 key，不为省一个 key 去改任一侧的可见文案。
  'article.newTitle': '新建文章',
  'article.importTitle': '导入文章',
  'common.passwordInputPlaceholder': '请输入密码',
  'cover.label': '题头图',
  'cover.placeholder': '可选，图片 URL，留空不显示题头图',
  'cover.tooltip': '可选。设置后显示在文章页顶部，并作为分享到其他应用时的预览图（Open Graph / Twitter）。可上传到现有图床或填写图片 URL。留空则不显示，已有文章不受影响。',
  'cover.uploadedOk': '{name} 上传成功!',
  'cover.uploadedExists': '{name} 已存在!',
  'cover.clear': '清除题头图',


  // ── 🔴 期 5 第八批：文章管理页（index + columns + 服务层 batch.ts，30 条新 key，**复用 61 个**）──
  //    🔴 提升 8 个：`draft.batchDelete` / `batchExport` / `clearSelection` / `batchDeleteOk` / `importOk` /
  //    `recycleBinBtn` / `deleteOk` 与 `customPage.view` → `common.*`（文章页与草稿页/自定义页面是同一批动作）。
  //    🔴 `batch.ts`（批量删除的确认框）用**注入式翻译器**：`batchDelete(ids, isDraft, t = IDENTITY_T)`
  //    ⇒ 不传 t 时与改造前逐字相同；文章页与草稿页两个调用点都已补上 t。
  //    ⚠️ 列头「顶置」是**源码里的笔误**（应为「置顶」）⇒ 翻译批次不改中文，照原样进包；
  //    🔴 已登记为待站长裁定的文案笔误（与 caddy 那条「触发请后」同一类）。繁体用正确词「置頂」。
  //    ⚠️ `describeScheduledTag()`（schedule.js）与 `PATHNAME_FIELD`（importPathname.js）仍是服务层常量
  //    ⇒ 定时状态标签、路径名字段在英文下仍是中文（已记录的中间态，下一批做）。
  'article.genPinyinTitle': '批量生成拼音路径名？',
  'article.genPinyinContent': '为所有「自定义路径名」为空的文章按标题生成汉语拼音路径（重名自动追加 -2、-3）。已有路径名不会被修改，旧的 /post/数字id 链接依然可用。',
  'common.generate': '生成',
  'article.genPinyinDone': '已生成 {updated} 个路径名（扫描 {scanned} 篇，跳过 {skipped} 篇）',
  'article.editAbout': '编辑关于',
  'article.genPinyin': '生成拼音路径',
  'article.hiddenAriaLabel': '是否隐藏 {title}',
  'article.hiddenOn': '已设为隐藏',
  'article.hiddenOff': '已取消隐藏',
  'article.colTop': '顶置',
  'article.colViews': '浏览量',
  'article.hiddenTooltip': '隐藏后前台不展示，也不计入总字数 / 时间线等。可在此直接开关，不必打开修改信息。',
  'article.scheduledTooltip': '定时中的文章在到点之前对所有前台页面不可见（列表/搜索/RSS/sitemap 都不出现），到点后服务端会在一分钟内自动发布。以 publishAt 是否晚于当前时间为准。',
  'article.hiddenWarningTitle': '此文章为隐藏文章！',
  'article.hiddenWarningP1': '隐藏文章在未开启通过 URL 访问的情况下（默认关闭），会出现 404 页面！',
  'article.hiddenWarningPrefix': '您可以在',
  'article.layoutConfig': '布局配置',
  'article.hiddenWarningSuffix': '中修改此项。',
  'common.visitAnyway': '仍然访问',
  'common.back': '返回',
  'article.scheduledWarningTitle': '此文章处于「定时待发布」状态！',
  'article.scheduledWarningP1a': '这篇文章定时于',
  'article.scheduledWarningP1b': '自动发布，在那之前它对所有前台页面不可见，现在打开会是 404 页面。',
  'article.scheduledWarningP2': '想改时间或取消定时：编辑 →「修改信息」→「定时发布」。',
  'article.deleteConfirmTitle': '确定删除 "{title}"吗？',
  'article.deleteConfirmContent': '删除后文章会移入本页工具栏的「回收站」，前台立刻不可见，可随时恢复；只有在回收站里「永久删除」才不可撤销。',
  'common.demoBlockedDelete': '演示站禁止删除此文章！',
  'common.batchDeleteConfirmTitle': '确定要删除选中内容吗？',
  'common.batchDeleteConfirmContent': '删除后无法恢复',
  'common.batchDeleteFailed': '{failed} / {total} 条删除失败',


  // ── 🔴 期 5 第九批：从正文首图补封面（`CoverBackfillModal` + 服务层 `coverBackfill.js`，29 条）──
  //    🔴 服务层同样是**注入式翻译器**：`summarizeBackfill(data, t = IDENTITY_T)` /
  //    `normalizeBackfillItems(data, t = IDENTITY_T)` / `emptyResultText(t = IDENTITY_T)`；
  //    🔴 `summarizeBackfill` **内部**调 `normalizeBackfillItems(data, t)`（内部也必须转发，见 §7.156 A ③）。
  //    ⚠️ `EMPTY_RESULT_TEXT` 常量保留为 identity 视图（`coverBackfill.test.js` 的黄金样本照旧通过）。
  //    ⚠️ 计数句用 ICU plural（英文），zh-CN / zh-TW 保持 `{count} 篇` 的形状；
  //    但 `{scanned} scanned` / `{total} selected` 这种"占位符 + 过去分词"**不用** plural（不是复数名词）。
  'cover.previewFailed': '预览失败！',
  'cover.writtenFor': '已为 {count} 篇文章补上封面',
  'cover.writeFailed': '写入失败！',
  'cover.revertedFor': '已撤销 {count} 篇文章的封面改动',
  'cover.revertFailed': '撤销失败！',
  'common.close': '关闭',
  'cover.revertedDone': '已撤销本次改动',
  'cover.revertBtn': '撤销本次改动',
  'cover.confirmWrite': '确认写入（{count} 篇）',
  'cover.triggerTooltip': '扫描文章正文，把第一张可用图片补进「封面为空」的文章；先看预览，写入后可撤销',
  'cover.triggerBtn': '从正文首图补封面',
  'cover.doneTitle': '补封面完成',
  'cover.writtenSummary': '已为 {changed} 篇文章补上封面（扫描 {scanned} 篇）',
  'cover.revertHint': '如果发现某篇配错了图，点右下角「撤销本次改动」可以把这批文章的封面恢复成写入前的值（原来为空就恢复为空）。',
  'cover.scanning': '正在扫描文章正文里的首图…',
  'cover.onlyEmpty': '只给「封面为空」的文章补，已有封面不会改动；写入前可以先取消勾选个别文章。',
  'cover.previewRetry': '预览没跑起来，点下面按钮重试',
  'cover.rescan': '重新扫描',
  'common.selectAll': '全选',
  'common.invertSelection': '反选',
  'cover.selectedCount': '已选 {selected} / {total} 篇',
  'coverBackfill.emptyResult': '所有文章都已有封面，或正文里没有可用图片',
  'coverBackfill.untitled': '文章 {id}',
  'coverBackfill.rowScanned': '扫描',
  'coverBackfill.rowMatched': '有首图',
  'coverBackfill.rowWillWrite': '将写入',
  'coverBackfill.rowWritten': '已写入',
  'coverBackfill.rowSkippedHasCover': '已有封面跳过',
  'coverBackfill.rowSkippedNoImage': '无图跳过',


  // ── 🔴 期 5 第十批：历史版本（`RevisionHistory/index.jsx` + `revisionCore.js`，36 条）──
  //    🔴 `revisionCore.js` 是**注入式翻译器最大的一单**：7 个 SCREAMING_CASE 常量 + 9 个产文案函数，
  //    而 `revisionHistory.test.js` 有 ~15 条**黄金样本**直接调这些函数 ⇒ 不传 t 时必须**逐字相同**
  //    （实测：迁移后那 27 条测试全绿，一个字都没改）。
  //    🔴 **内部转发**：`classifyRevisionsPayload/Error` 的 text、`revisionRestoreSuccessText` 里的
  //    `（{when} 保存的版本）` 与两句快照说明，都要把 t 一路传下去（§7.156 A ③ / §7.159 C 那个坑，已踩两次）。
  //    ⚠️ 服务端原因用 `revision.detailWrap`（`（{message}）`）包一层：英文的括号与前导空格与中文不同。
  //    🔴 这一批做完，**文章管理页的块就齐了**（pageSurface 从 144 条降到只剩服务层常量那几处）。
  'revision.needArticleId': '文章还没有保存过（缺少 ID），保存后再来查看历史版本。',
  'revision.detailMissingId': '这个版本缺少 ID，无法查看',
  'revision.restoreMissingId': '缺少文章或版本 ID，无法恢复',
  'revision.colSavedAt': '保存时间',
  'revision.colWordCount': '字数',
  'revision.colReason': '来源',
  'revision.restoreOkBtn': '恢复到这个版本',
  'revision.backToList': '返回列表',
  'revision.savedAt': '保存于 {when}',
  'revision.wordCountValue': '字数 {count}',
  'revision.sizeValue': '大小 {size}',
  'revision.reasonValue': '来源 {reason}',
  'revision.title': '历史版本',
  'revision.titleWithArticle': '历史版本：{title}',
  'revision.loadingDetail': '正在加载版本内容…',
  'revision.featureOff': '版本历史功能未开启（服务端 VANBLOG_ARTICLE_REVISIONS_KEEP=0，或 server 版本还不支持）。开启后每次保存文章都会自动记录一个版本，超出保留上限的旧版本由服务端自动清理。',
  'revision.empty': '这篇文章还没有历史版本。保存文章时会自动记录版本（保留条数上限由服务端控制）；若服务端未开启版本历史（VANBLOG_ARTICLE_REVISIONS_KEEP=0），这里会一直为空。',
  'revision.detailEmptyContent': '（这个版本没有正文内容）',
  'revision.reasonUpdate': '保存更新',
  'revision.reasonPreRestore': '恢复前自动保存',
  'revision.untitled': '(无标题)',
  'revision.detailWrap': '（{message}）',
  'revision.listFailed': '历史版本加载失败{detail}，请稍后重试。',
  'revision.detailNotFound': '这个版本的内容拿不到（404）：可能刚被服务端的保留策略清理掉，或它属于另一篇文章；请刷新列表确认。',
  'revision.detailFailed': '版本内容加载失败{detail}，请稍后重试。',
  'revision.restoreNotFound': '找不到这个版本（404）：它可能已被服务端的保留策略清理，或属于另一篇文章；列表将刷新为最新状态。',
  'revision.restoreForbidden': '当前账号没有恢复版本的权限（需要 article:update），请联系管理员。',
  'revision.restoreUnauthorized': '登录已失效，请重新登录后再试。',
  'revision.restoreFailed': '恢复版本失败{detail}，请稍后重试。',
  'revision.restoreConfirmTitle': '把文章恢复到「{title}」这个版本吗？',
  'revision.restoreConfirmContent': '恢复前，服务端会先把文章当前的状态保存成一个新的历史版本，所以这次恢复本身也是可撤销的（之后可以再恢复回现在的内容）。确认后用该版本的正文覆盖文章当前正文。',
  'revision.restoreNotApplied': '服务端报告这次恢复没有生效（restored=false），文章未改动；请刷新列表后重试。',
  'revision.savedVersionWhen': '（{when} 保存的版本）',
  'revision.restoreSnapshot': '恢复前的当前内容已自动存为一个新的历史版本，可再次恢复回来。',
  'revision.restoreSnapshotAlt': '恢复前的内容也存成了新版本，可随时再恢复回来。',
  'revision.restoreSuccess': '已恢复到「{title}」{when}；{snapshot}',


  // ── 🔴 期 7 第二批：**服务层字段常量**（tagTokens / importPathname / schedule，11 条）──
  //    🔴 这批用的就是 §7.157 B 定下的形状：**函数版 + identity 视图**
  //    （`tagFieldPlaceholder(t = IDENTITY_T)` + `const TAG_FIELD_PLACEHOLDER = tagFieldPlaceholder();`）。
  //    ⚠️ `describeScheduledTag` / `pastScheduleWarningText` 本来就有 `now` 这个可选参 ⇒ t 放**第三位**，
  //    调用方写 `describeScheduledTag(x, undefined, t)`；还没接 i18n 的 `pages/Editor/index.jsx` 继续写
  //    `describeScheduledTag(x)` ⇒ 输出与今天逐字相同（登记在 NOT_YET_I18N_CONSUMERS 里）。
  //    🔴 `pastScheduleWarningText` 原来是"三段拼接 + 两个日期插值"⇒ 收成**一条带两个 ICU 占位符**的整句
  //    （拼接式在英文里必然出接缝问题，见 §7.152 B / §7.156 B / §7.160 C 那三次）。
  //    🔴 这批做完，文章页/草稿页的**表单**里不再有服务层中文（只剩 exportFormats 那个导出下拉）。
  'tagTokens.placeholder': '选择、输入或粘贴多个标签（逗号 / 分号 / 换行分隔）',
  'tagTokens.tooltip': '可一次粘贴多个标签。用英文/中文逗号、分号或换行分隔；空格不会拆开，以便保留「machine learning」这类多词标签。',
  'pathname.label': '自定义路径名',
  'pathname.placeholder': '例如 Hugo 的 slug；留空则按标题生成拼音，而不是数字 id',
  'pathname.tooltip': '发布后地址为 /post/[自定义路径名]，对应 Hugo 的 permalinks.post = "/post/:slug"。从 Hugo 迁移时把旧 slug 填到这里，可保持旧 URL、不影响 SEO。留空则按标题自动生成汉语拼音路径（重名依次追加 -2、-3，最后兜底 -文章id）；标题里没有可用字符时才退回数字 id。已填的别名不会随标题修改而变动，数字 id 地址始终可用；没有站点级固定链接模板。',
  'schedule.tagText': '定时待发布',
  'schedule.publishAtPlaceholder': '留空 = 不定时（立即发布）',
  'schedule.publishAtTooltip': '设置一个未来时间后，文章在到点之前对所有前台页面不可见（列表、搜索、RSS、sitemap 都不出现），到点后由服务端定时任务在一分钟内自动发布。清空此字段 = 取消定时（立即发布/保持已发布）。',
  'schedule.publishAtHelp': '定时发布：到点之前这篇文章在前台完全不可见，服务端会在设定时刻起一分钟内自动把它发布出来。',
  'schedule.pastWarningText': '你选择的定时发布时间「{when}」早于当前时间（{now}）。它不会处于「定时待发布」状态：保存后服务端会认为它已到期，未发布的文章会在一分钟内直接发布出去。仍要使用这个时间吗？',
  'schedule.pastWarningTitle': '定时时间早于当前时间',


  // ── 🔴 期 7 第三批：文章导出（`exportFormats.js` + `exportMarkdown.tsx`，29 条）──
  //    形状仍是"函数版 + identity 视图"：`exportFormats(t = IDENTITY_T)` / `loadingText(format, t)` /
  //    `describeExportOutcome(report, format, t)` / `classifyExportFailure(body, format, t)`。
  //    🔴 导出结果那段"多子句汇总"原来是 **4 个插值分成两句模板字符串相加** ⇒ 收成一条带 4 个 ICU 占位符的整句
  //    （拼接式在英文里必然出接缝/复数问题：§7.152 B、§7.156 B、§7.160 C、§7.161 A 已经四次）。
  //    🔴 `exportMarkdown.tsx` 弹的全是 `message.*` / `Modal.*`（脱离 React 树的独立根，§7.151）
  //    ⇒ 它用 `getIntl(getLocale())` 在**调用期**取翻译器，不是 `useIntl()`（它不是组件）。
  //    ⚠️ `导出说明.md` 是**服务端产物文件名**（线路契约）⇒ 不进语言包：文案用 `{note}` 占位符，
  //    调用期喂 `EXPORT_NOTE_FILENAME`；`exportFormats.test.js` 有一条**跨层反向断言**钉住服务端那个名字。
  'export.formatMdHint': '只要正文，图片仍指向站点（最快）',
  'export.formatMdzLabel': 'Typora 图片包 (.mdz)',
  'export.formatMdzHint': '正文 + 图片，链接改成相对路径',
  'export.formatZipLabel': '全部打包 (.zip)',
  'export.formatZipHint': 'md + mdz + 导出说明，一次拿全',
  'export.loadingMd': '正在导出 Markdown…',
  'export.loadingPack': '正在打包 Markdown 与图片…',
  'export.outcomeMdTitle': '已导出 Markdown（不含图片）',
  'export.outcomeMdRefs': '正文里识别到 {refs} 个图片引用，链接仍指向站点 —— 这是 .md 格式的预期行为。',
  'export.outcomeMdPickMdz': '需要把图片一起带走（例如离线用 Typora/Obsidian 打开），请改选 Typora 图片包 (.mdz)。',
  'export.outcomeNoImagesMdzTitle': '这篇内容没有图片',
  'export.outcomeNoImagesTitle': '导出完成（这篇文章没有图片）',
  'export.outcomeNoImagesWhy': '这篇文章没有图片，所以没有 .mdz —— .mdz 的意义就是把图片一起带走并改成相对路径。',
  'export.outcomeNoImagesPickMd': '请改选 Markdown (.md)，内容是一样的。',
  'export.outcomeNoImagesAllContent': '拿到的 .md 就是全部内容。',
  'export.outcomeProblemsTitle': '导出完成，但有图片没打进包',
  'export.outcomeProblemsSummary': '正文里识别到 {refs} 个图片引用，成功打包 {packed} 张（本站 {local} / 外链 {remote}）。',
  'export.outcomeProblemsFailed': '抓取失败 {failed} 张，md 里保留了原链接。',
  'export.outcomeProblemsSkipped': '跳过 {skipped} 个（data URI、无法定位的相对路径等）。',
  'export.outcomeZipNote': '压缩包里的「{note}」有完整清单。',
  'export.noImagesFallback': '这篇内容没有图片，所以没有 .mdz。',
  'export.noImagesDetailRefs': '正文里识别到 {refs} 个图片引用，但都不是能打包进 .mdz 的本地/可抓取图片。',
  'export.noImagesDetailNone': '正文里没有任何图片引用，.mdz 与 .md 的内容完全相同。',
  'export.failed': '导出失败！',
  'export.noFileFromServer': '导出失败：服务端没有返回文件',
  'export.noImagesModalTitle': '这篇内容没有图片，所以没有 .mdz',
  'export.noImagesModalOk': '改为导出 Markdown (.md)',
  'export.noImagesModalNote': '.mdz 的意义就是把图片一起带走并改成相对路径；没有图片时它与 .md 完全等价。',
  'export.success': '导出成功！',

};
