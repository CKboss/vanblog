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
};
