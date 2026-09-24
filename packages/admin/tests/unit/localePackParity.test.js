/**
 * 🔴 多语言守卫：三份语言包的 key 集合必须完全相等，且翻译必须真的存在。
 *
 * 覆盖面：**第一期**＝安装页家族 + 登录/忘记密码页 + 语言切换器；
 * 🔴 **第二期第一块**＝后台侧边栏菜单（`config/routes.js` 的 `locale` 字段 ↔ 三份包的 `menu.*`）。
 *
 * **它防的是本仓库反复付过学费的那一族失效**：一个性质有多处口径 ⇒ 改一处忘另一处
 * （API Token 默认值曾有六处口径、两处是错的；`api.md` 的限流表曾漏掉一整个桶）。
 * 多语言天生就是「同一批 key、N 份口径」，所以**必须**有守卫，否则加一个 key 忘了翻译
 * 是静默的（用户会看到裸 key，或者看到永远不变的中文）。
 *
 * 形状刻意与 `siteInfoFieldParity.test.js` 同族（三方集合双向相等 + 反空转 + 尺子反证），
 * 因为那一条已被证明是有效的模式。
 *
 * ⚠️ 语言包是 `.ts`，而本目录是 `node --test`（解析不到 TS 别名与 ESM）⇒
 * 这里**按文本解析**，与 `siteInfoFieldParity` 同一套做法。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.resolve(__dirname, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');

const LOCALES = ['zh-CN', 'zh-TW', 'en-US'];
const PACK_REL = (l) => `src/locales/${l}.ts`;
const INIT_DIR = 'src/pages/InitPage';

/** 剥掉块注释与整行注释（⚠️ 不剥行尾注释：那会啃掉 URL 之类的内容）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/**
 * 解析语言包成 { key: value }。
 * 🔴 只认「单引号 key + 单引号 value」这一种形状（三份包都是自己生成的、形状统一）。
 * ⚠️ **解析不到必须 fail-loud**，不能静默返回空对象 —— 否则「三份都是空 ⇒ 集合相等」
 * 会变成一个恒真的绿（本仓库已有先例：枚举出 0 条路由 ⇒「未覆盖清单为空」恒真）。
 */
function parsePack(locale) {
  const rel = PACK_REL(locale);
  assert.ok(existsSync(path.join(adminRoot, rel)), `语言包不存在：${rel}`);
  const body = stripComments(read(rel));
  const out = {};
  const re = /'([^']+)':\s*\n?\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    out[m[1]] = m[2].replace(/\\'/g, "'");
  }
  return out;
}

/**
 * 从组件源码里抽出所有 `t('id', 'defaultMessage'` 调用对。
 * 🔴 用 `[\s\S]` 而不是 `.`：本仓库的 prettier 会把长调用折成多行。
 */
function parseTCalls(src) {
  const body = stripComments(src);
  const out = [];
  const re = /\bt\(\s*'([^']+)',\s*\n?\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.push({ id: m[1], defaultMessage: m[2].replace(/\\'/g, "'") });
  }
  return out;
}

const packs = {};
for (const l of LOCALES) packs[l] = parsePack(l);

/**
 * 🔴 允许 zh-TW 与 zh-CN **逐字相同**的 key 白名单。
 *
 * 这不是偷懒：这几条**在简繁两种写法下本来就是同一个字符串**
 * （不含任何简繁异形字），例如「取消」「文章」「初始化成功!」。
 * 把它们排除在「必须不同」之外是正确的；🔴 但白名单必须**恰好等于**实际相同的那一批，
 * 这样任何人新增了第 6 条相同的值都会红 ⇒ 他必须有意识地把它加进白名单并说明理由。
 */
const IDENTICAL_ZH_TW_OK = [
  'init.success.title', // 初始化成功! —— 五个字简繁同形
  'init.baseUrl.invalidLine2', // 例: https://blog.example.com —— 只有「例」一个字，简繁同形
  'init.restore.confirmCancel', // 取消
  'init.restore.count.articles', // 文章
  'init.restore.count.unknownSize', // 未知大小
  'init.restore.uninitLine1Strong', // 不包含 —— 三个字简繁同形
  // 🔴 第二期第一块（侧边栏菜单）新增的三条：这几个词简繁逐字相同，
  //    「文章」「草稿」「附件」「管理」四个字都不含简繁异形字。
  //    ⚠️ 这不是偷懒：把它们排除在「必须不同」之外是正确的，而白名单必须**恰好等于**
  //    实际相同的那一批 ⇒ 谁再多复制一条简体当繁中，这条就会红。
  // 🔴 第二期第二块（侧边栏底部 / 主题三档 / 登出提示）新增的五条：
  //    「主站」「登出」「亮色模式」「暗色模式」「登出成功！」简繁逐字相同
  //    （不含简繁异形字：主/站/登/出/亮/色/模/式/暗/成/功 都同形）。
  //    ⚠️ 白名单必须**恰好等于**实际相同的那一批 ⇒ 谁再多复制一条简体当繁中，这条就会红。
  'common.mainSite', // 主站
  'common.logout', // 登出
  'theme.light', // 亮色模式
  'theme.dark', // 暗色模式
  'logout.ok', // 登出成功！
  'menu.article', // 文章管理
  'menu.draft', // 草稿管理
  'menu.file', // 附件管理
];

/**
 * 🔴 高频「简体专用字」：这些字在繁体里**一定**是另一个字形。
 * 只要 zh-TW 里出现其中任何一个，就说明有人**直接把简体复制过来当繁中**。
 * 这条与上面的白名单互补：白名单管「合法相同」，这条管「非法相同」。
 */
// 🔴 这张表只收「在繁体里一定换成另一个字形」的字。
// ⚠️ 刻意**不含** 填 / 目 / 粘 / 包 / 含 / 不 / 文 / 章 等简繁同形字 ——
//    把它们放进来会产生假阳性（填寫、目錄、粘合 里的这些字简繁是一样的），
//    而假阳性比漏报更糟：它会训练下一个人忽略红灯。
const SIMPLIFIED_ONLY =
  '设备复务网页图导录账号评论处动进级单击确认时间题误报读压缩数据库静态档称随机闭开启传输应该这会说请试频简护贴载键运显实个为来对过还';

describe('多语言第一期：三份语言包的 key 集合完全相等', () => {
  it('zh-CN / zh-TW / en-US 三方的 key 集合两两相等（双向）', () => {
    const a = Object.keys(packs['zh-CN']).sort();
    const b = Object.keys(packs['zh-TW']).sort();
    const c = Object.keys(packs['en-US']).sort();
    assert.deepEqual(b, a, 'zh-TW 的 key 集合与 zh-CN 不一致（漏翻译或多了幽灵 key）');
    assert.deepEqual(c, a, 'en-US 的 key 集合与 zh-CN 不一致（漏翻译或多了幽灵 key）');
  });

  it('反空转：key 数不少于 50（否则「集合相等」可能是三份都空）', () => {
    const n = Object.keys(packs['zh-CN']).length;
    assert.ok(n >= 50, `只解析到 ${n} 个 key，疑似解析器坏了而不是语言包真的这么小`);
    for (const l of LOCALES) {
      assert.ok(
        Object.values(packs[l]).every((v) => typeof v === 'string' && v.trim().length > 0),
        `${l} 里有空值`,
      );
    }
  });

  it('反空转：解析器不是恒返回空 —— 已知必然存在的 key 必须被解析到', () => {
    for (const l of LOCALES) {
      assert.ok('init.step.user' in packs[l], `${l} 连 init.step.user 都没解析到 ⇒ 解析器坏了`);
      assert.ok('init.setupKey.hint1' in packs[l], `${l} 缺 init.setupKey.hint1`);
    }
  });
});

describe('多语言第一期：翻译必须真的存在（不是复制简体充数）', () => {
  it('en-US 的每一条都必须与 zh-CN 不同', () => {
    const same = Object.keys(packs['zh-CN']).filter(
      (k) => packs['en-US'][k] === packs['zh-CN'][k],
    );
    assert.deepEqual(same, [], `en-US 这些 key 直接抄了简体：${same.join(', ')}`);
  });

  it('en-US 里不许出现中日韩统一表意文字（除了刻意保留的命令/日志标记）', () => {
    // 🔴 两处刻意保留简体：`grep 初始化密钥` 与启动日志里那一行的标签，
    //    因为它们匹配的是 **server 实际输出的文字**，翻译了命令就抓不到东西。
    const ALLOW = ['init.setupKey.placeholder', 'init.setupKey.hint2'];
    const bad = Object.keys(packs['en-US']).filter(
      (k) => !ALLOW.includes(k) && /[\u4e00-\u9fff]/.test(packs['en-US'][k]),
    );
    assert.deepEqual(bad, [], `en-US 这些 key 还留着中文：${bad.join(', ')}`);
    // 反过来钉住：那两处**必须**真的含中文（否则说明有人把命令也翻了 ⇒ 命令会失效）
    for (const k of ALLOW) {
      assert.match(
        packs['en-US'][k],
        /初始化密钥/,
        `${k} 必须原样保留「初始化密钥」：它匹配的是 server 的简体日志输出`,
      );
    }
  });

  it('zh-TW 与 zh-CN 相同的 key 必须恰好等于白名单（多一条少一条都红）', () => {
    const same = Object.keys(packs['zh-CN'])
      .filter((k) => packs['zh-TW'][k] === packs['zh-CN'][k])
      .sort();
    assert.deepEqual(
      same,
      [...IDENTICAL_ZH_TW_OK].sort(),
      'zh-TW 与 zh-CN 逐字相同的 key 集合变了：新增的说明忘了做繁中转换，' +
        '减少的说明白名单里有条目已经不需要了（请一并删掉，别留死条目）',
    );
  });

  it('zh-TW 里不许出现高频简体专用字（防「整包复制简体」）', () => {
    const hits = [];
    for (const [k, v] of Object.entries(packs['zh-TW'])) {
      // 🔴 白名单里的那几条本来就与简体相同，跳过（它们不含简体专用字，但别误判）
      const found = [...v].filter((ch) => SIMPLIFIED_ONLY.includes(ch));
      if (found.length > 0) hits.push(`${k}: ${[...new Set(found)].join('')}`);
    }
    assert.deepEqual(
      hits,
      [],
      `zh-TW 这些值里含简体专用字（疑似直接复制简体）：\n  ${hits.join('\n  ')}`,
    );
  });
});

describe('多语言第一期：组件里的每个 id 都必须在三份包里存在，且 defaultMessage 与 zh-CN 一致', () => {
  const COMPONENTS = [
    ...['index.tsx', 'RestoreFromBackup.tsx'].map((f) => `${INIT_DIR}/${f}`),
    // 🔴 第二期第二块：侧边栏底部与主题/登出组件也开始用 t()，
    //    所以它们的 defaultMessage 同样必须与 zh-CN 包逐字相同。
    'src/app.jsx',
    'src/components/ThemeButton/index.tsx',
    'src/components/LogoutButton/index.jsx',
  ];
  const calls = [];
  for (const rel of COMPONENTS) {
    for (const c of parseTCalls(read(rel))) calls.push({ ...c, rel });
  }

  it('反空转：确实抽到了 t() 调用（不是解析器坏了）', () => {
    assert.ok(calls.length >= 30, `只抽到 ${calls.length} 个 t() 调用，疑似解析器坏了`);
  });

  it('每个 id 都在三份语言包里存在', () => {
    const missing = [];
    for (const { id, rel } of calls) {
      for (const l of LOCALES) {
        if (!(id in packs[l])) missing.push(`${rel} → ${id} 缺 ${l}`);
      }
    }
    assert.deepEqual(missing, [], `有 id 在语言包里不存在：\n  ${missing.join('\n  ')}`);
  });

  it('每个 defaultMessage 都与 zh-CN 包里同 id 的值逐字相同（防两处口径漂移）', () => {
    const drift = [];
    for (const { id, defaultMessage, rel } of calls) {
      const want = packs['zh-CN'][id];
      if (want !== undefined && want !== defaultMessage) {
        drift.push(`${rel} → ${id}\n     源码: ${defaultMessage}\n     zh-CN: ${want}`);
      }
    }
    assert.deepEqual(
      drift,
      [],
      `defaultMessage 与 zh-CN 语言包不一致（同一性质两处口径必然漂移，请改成一致）：\n  ${drift.join('\n  ')}`,
    );
  });

  it('🔴 与服务端约定的字符串绝不可进语言包：`已初始化` 是协议不是文案', () => {
    // InitPage 用 String(info?.message).includes('已初始化') 匹配 **服务端 HttpException 的文本**。
    // 翻译它会让「站点已初始化 ⇒ 跳登录页」这条分支永久失效。
    const src = read(`${INIT_DIR}/index.tsx`);
    assert.match(src, /includes\('已初始化'\)/, 'wire-contract 匹配被改动了，请确认这是有意的');
    for (const l of LOCALES) {
      const leaked = Object.entries(packs[l]).filter(([, v]) => v.includes('已初始化'));
      assert.deepEqual(leaked.map(([k]) => k), [], `${l} 里出现了 wire-contract 字符串`);
    }
  });
});

describe('多语言第一期：纯 JS 核心模块的注入式翻译器', () => {
  const setupKeyCore = require('../../src/pages/InitPage/setupKeyCore');
  const restoreCore = require('../../src/pages/InitPage/restoreCore');

  it('SETUP_KEY_HINT_IDS 与 SETUP_KEY_HINTS 一一对应，且每个 id 都在三份包里', () => {
    const ids = setupKeyCore.SETUP_KEY_HINT_IDS;
    assert.equal(ids.length, setupKeyCore.SETUP_KEY_HINTS.length, '两个数组长度必须一致');
    assert.ok(ids.length >= 4, `只有 ${ids.length} 条提示，疑似常量被改小了`);
    for (const id of ids) {
      for (const l of LOCALES) assert.ok(id in packs[l], `${id} 缺 ${l}`);
    }
  });

  it('zh-CN 包里每条 hint 的值 == 模块里的中文常量（模块常量是权威，包不得漂）', () => {
    setupKeyCore.SETUP_KEY_HINT_IDS.forEach((id, i) => {
      assert.equal(
        packs['zh-CN'][id],
        setupKeyCore.SETUP_KEY_HINTS[i],
        `${id} 的 zh-CN 值与 setupKeyCore.SETUP_KEY_HINTS[${i}] 不一致`,
      );
    });
  });

  it('不传翻译器时 getSetupKeyHints() 原样返回中文（单测与旧行为逐字一致）', () => {
    assert.deepEqual(setupKeyCore.getSetupKeyHints(), setupKeyCore.SETUP_KEY_HINTS);
  });

  it('传入翻译器时 getSetupKeyHints(t) 走 id（证明注入真的生效，不是恒返回中文）', () => {
    const seen = [];
    const out = setupKeyCore.getSetupKeyHints((id, dm) => {
      seen.push(id);
      return `#${id}`;
    });
    assert.deepEqual(seen, setupKeyCore.SETUP_KEY_HINT_IDS, '翻译器必须按顺序收到每个 id');
    assert.deepEqual(out, setupKeyCore.SETUP_KEY_HINT_IDS.map((id) => `#${id}`));
  });

  it('restoreCore：注入翻译器后 describeRestoreFailure 返回 id 而不是中文', () => {
    const out = restoreCore.describeRestoreFailure(429, '', (id) => `#${id}`);
    assert.deepEqual(out, ['#init.restore.err.429']);
    // 🔴 而不传翻译器时仍是中文（既有单测依赖这一点）
    assert.deepEqual(restoreCore.describeRestoreFailure(429, ''), [
      '初始化相关请求太频繁（限流：每 10 分钟 5 次），请稍后再试。',
    ]);
  });

  it('restoreCore：占位符插值在不传翻译器时与旧实现逐字相同', () => {
    assert.equal(
      restoreCore.parseRestoreResponse(500, '').message,
      '恢复请求失败（HTTP 500）',
      'identity 翻译器必须把 {status} 插值成与旧模板字符串相同的结果',
    );
    assert.equal(
      restoreCore.parseRestoreResponse(400, JSON.stringify({ statusCode: 409 })).message,
      '恢复被拒绝（statusCode=409）',
    );
    // 注入翻译器时走 id + values
    const got = restoreCore.parseRestoreResponse(500, '', (id, dm, values) => `${id}|${JSON.stringify(values)}`);
    assert.equal(got.message, 'init.restore.err.httpFailed|{"status":500}');
  });

  it('restoreCore：formatRestoreCounts 与 describeFileSize 都接受翻译器', () => {
    assert.equal(
      restoreCore.formatRestoreCounts({ articles: 3 }, (id) => `#${id}`),
      '#init.restore.count.articles 3',
    );
    assert.equal(restoreCore.formatRestoreCounts({ articles: 3 }), '文章 3');
    assert.equal(restoreCore.describeFileSize(0, (id) => `#${id}`), '#init.restore.count.unknownSize');
    assert.equal(restoreCore.describeFileSize(0), '未知大小');
  });
});

/**
 * 🔴 语言切换器必须**真的被渲染**，而不只是"被编译进产物"。
 *
 * **它防的是 v2026.9.6 那个已发版的缺陷**：`@umijs/plugin-locale` 启用后，`SelectLang`
 * 组件确实被编译进了 bundle（产物里按 `\uXXXX` 转义形式能搜到 `简体中文`/`繁體中文`），
 * 但**没有任何用户能到达的页面渲染它** ⇒ 站长在后台"什么都没看到"。两个成因：
 *   1. 🔴 `src/app.jsx` 导出的运行时 `layout` 配置里提供了 `rightContentRender`，
 *      它会**整体覆盖** plugin-layout 生成的右侧内容 —— 而那个"自动出现"的切换器
 *      正是 plugin-layout 的 `genRenderRightContent({ locale: hasPlugins([...]) })`
 *      放进去的 ⇒ **"启用插件头部就会自动出现切换器"这个推断在本仓库不成立**。
 *   2. `/user`（登录、忘记密码）与 `/init` 都是 `layout: false` ⇒ 拿不到头部；
 *      而 `/init` 在**已初始化**的站点上不可达 ⇒ 上一轮写在安装页里的那个只有全新安装才看得到。
 *
 * ⚠️ **判据的口径**（这一节的存在理由）：
 * 🔴 **"某个生成文件存在"（`.umi/plugin-locale/SelectLang.tsx`）、"localeInfo 注册了三份"、
 * "ConfigProvider 已接管"这三条都是真的，但没有一条能证明切换器会被渲染。**
 * 唯一可靠的尺子是：①**源码里那个真正生效的渲染点确实引用了它**（本节），
 * ②**构建产物里搜得到切换器要显示的文字**（见 `docs`/手册记录的转义形式口径）。
 *
 * ⚠️ 一律**先剥注释再断言**：本仓库的注释里会写 `<SelectLang />` 来解释成因，
 * 若不剥注释，那些注释会喂饱断言 ⇒ 守卫变成恒真（本仓库已为此付过 5 次学费）。
 */
describe('多语言第一期：语言切换器必须真的被渲染（不是只被编译进产物）', () => {
  /**
   * 四个"必须有切换器"的位置。
   * 🔴 `why` 说明每一处为什么必须有 —— 断言失败时要能看出是哪一处、为什么。
   */
  const REQUIRED = [
    {
      file: 'src/app.jsx',
      why: '后台头部：运行时 layout 的 rightContentRender 会覆盖 plugin-layout 生成的右侧内容',
      // 🔴 必须落在这个函数体内，不能只是"文件里某处出现过"
      scope: /rightContentRender:\s*\(\)\s*=>\s*\{[\s\S]*?\n    \},/,
    },
    {
      file: 'src/app.jsx',
      why:
        '🔴 侧边栏 links 区：handleSizeChange() 在视口 >768px 时把 header 设成 display:none，' +
        '所以 rightContentRender 里的切换器在桌面端不可见；links 区是桌面端唯一常驻可见的操作区' +
        '（主题按钮与登出本来就在这里各重复了一份）',
      // 🔴 必须落在 links 数组里，不能只是"文件里某处出现过"
      scope: /links:\s*\[[\s\S]*?\n    \],/,
    },
    {
      file: 'src/pages/user/Login/index.jsx',
      why: '登录页是 layout:false 且是站长看到的第一屏 ⇒ 登录之前就要能切换语言',
      scope: null,
    },
    {
      file: 'src/pages/user/Restore/index.jsx',
      why: '忘记密码页同为 layout:false，同样在登录之前',
      scope: null,
    },
    {
      file: 'src/pages/InitPage/index.tsx',
      why: '安装页是 layout:false（⚠️ 已初始化的站点上 /init 不可达，只有全新安装看得到）',
      scope: null,
    },
  ];

  it('反空转：清单必须是这 4 处、且每个文件都真实存在', () => {
    assert.equal(REQUIRED.length, 5, '清单条数变了 ⇒ 这条期望值必须一起改（这个摩擦是刻意留的）');
    for (const r of REQUIRED) {
      assert.ok(existsSync(path.join(adminRoot, r.file)), `文件不存在：${r.file}`);
    }
  });

  for (const r of REQUIRED) {
    it(`${r.file} 必须 import 并渲染 <SelectLang />（${r.why}）`, () => {
      const raw = read(r.file);
      // 🔴 剥注释后再断言：注释里提到 <SelectLang /> 不算数
      const src = stripComments(raw);
      const target = r.scope ? (src.match(r.scope) || [''])[0] : src;
      if (r.scope) {
        assert.ok(
          target.length > 0,
          `🔴 在 ${r.file} 里找不到该处应有的作用域（rightContentRender / links 数组）⇒ 尺子失效（不是"没有切换器"）。` +
            `请先核实这个正则是否还对得上当前源码形状；解析不到 ≠ 不存在。`,
        );
      }
      assert.match(
        target,
        // ⚠️ 允许带属性：放在 links 数组里的那一份必须带 key（React 对数组子元素的要求），
        //    所以形状是 `<SelectLang key="langSider" />`。仍然要求"行首 + 自闭合"，
        //    因此注释里提到的 <SelectLang /> 不会算数（注释已被 stripComments 剥掉）。
        /^\s*<SelectLang(\s[^>]*)?\/>/m,
        `🔴 ${r.file} 没有渲染 <SelectLang />。${r.why}。` +
          `⚠️ 注意"组件被编译进产物"不等于"它被渲染"—— v2026.9.6 就是这样发出去的。`,
      );
      assert.match(
        src,
        /^import\s*\{[^}]*\bSelectLang\b[^}]*\}\s*from\s*'umi';/m,
        `🔴 ${r.file} 没有从 'umi' 导入 SelectLang（渲染点存在但导入缺失 ⇒ 运行时是 undefined）。`,
      );
    });
  }

  it('🔴 语言自称不许在本仓库硬编码第二遍（必须来自 umi SelectLang 内置的 defaultLangUConfigMap）', () => {
    // ⚠️ 一个性质只留一处权威口径：语言自称（简体中文/繁體中文/English）由 umi 的
    //    defaultLangUConfigMap 提供；本仓库再抄一份就一定会漂。
    const LABELS = ['简体中文', '繁體中文'];
    for (const r of REQUIRED) {
      const src = stripComments(read(r.file));
      for (const label of LABELS) {
        assert.ok(
          !src.includes(label),
          `🔴 ${r.file} 里硬编码了语言自称「${label}」⇒ 应当复用 SelectLang 内置的标签，` +
            `否则就出现了第二处会漂移的口径。`,
        );
      }
    }
  });

  it('尺子反证：只出现在注释里的 <SelectLang /> 必须**不**算数', () => {
    // 🔴 这条证明上面的 stripComments 是承重的：把渲染点删掉、只在注释里留一份，
    //    守卫必须红。若哪天有人"顺手"把 stripComments 去掉，这条会先红。
    const onlyInComment = [
      "import { SelectLang } from 'umi';",
      'export default function () {',
      '  return (',
      '    <div>',
      '      {/* <SelectLang /> 这里只是注释，不是渲染 */}',
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    const stripped = stripComments(onlyInComment);
    assert.ok(
      !/^\s*<SelectLang\s*\/>/m.test(stripped),
      '🔴 尺子坏了：只写在注释里的 <SelectLang /> 被判成"已渲染" ⇒ stripComments 没生效',
    );
    // 反向：真实渲染的形状必须被认出来（否则上面那条"不红"只是因为正则太严）
    const real = onlyInComment.replace(
      "      {/* <SelectLang /> 这里只是注释，不是渲染 */}",
      '      <SelectLang />',
    );
    assert.match(
      stripComments(real),
      /^\s*<SelectLang\s*\/>/m,
      '🔴 尺子坏了：真实的 <SelectLang /> 渲染点没被认出来 ⇒ 正则需要修，而不是放宽断言',
    );
  });
});

describe('多语言第二期第一块：侧边栏菜单的 locale 接线（routes.js ↔ 三份语言包）', () => {
  /**
   * 🔴 这一组钉的是**方案 (B) 的接线**：`config/routes.js` 保留中文 `name`、另加显式
   * `locale: 'menu.xxx'`，由 ProLayout 的 `formatMessage({ id: locale, defaultMessage: name })`
   * 渲染（权威实现：`@umijs/route-utils` 的 `transformRoute`，`getItemLocaleName` 里
   * `return item.locale || `${parentName}.${name}`` ⇒ 显式 locale 优先）。
   *
   * 🔴 为什么不是把 `name` 改成 key（方案 A）：`defaultMessage` 永远是 `name`，所以
   *   - (B) 漏翻译 ⇒ 用户看到**中文**（与改动前一致）；
   *   - (A) 漏翻译 ⇒ 用户看到**裸 key**（菜单上出现 `article`），而且所有直接读 `name` 的
   *     消费方（面包屑、`document.title`、`attachmentManage.test.js` 的两条断言）全部跟着变。
   * 👉 下面那条「name 必须仍是中文显示文本」钉的**不是文案，而是这个安全前提本身**。
   */
  const routesSrc = stripComments(read('config/routes.js'));

  function parseRouteLocales(src) {
    const out = [];
    const re = /locale:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
  }
  function parseRouteNames(src) {
    const out = [];
    const re = /name:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
  }

  const routeLocales = parseRouteLocales(routesSrc);
  const routeNames = parseRouteNames(routesSrc);
  const menuKeys = Object.keys(packs['zh-CN'])
    .filter((k) => k.startsWith('menu.'))
    .sort();
  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

  it('反空转：routes.js 恰好 15 处 locale，全部 menu. 前缀且互不重复', () => {
    assert.equal(
      routeLocales.length,
      15,
      `抽到 ${routeLocales.length} 处 locale（期望 15）⇒ 要么解析器坏了，要么菜单增删了而这条期望值没跟着改`,
    );
    for (const l of routeLocales) {
      assert.ok(l.startsWith('menu.'), `locale 必须是 menu. 前缀：${l}`);
    }
    assert.equal(new Set(routeLocales).size, routeLocales.length, 'routes.js 里有重复的 locale');
  });

  it('反空转：确实抽到了 name（不是解析器坏了）', () => {
    assert.ok(routeNames.length >= 17, `只抽到 ${routeNames.length} 个 name，疑似解析器坏了`);
  });

  it('每个路由 locale 都在三份语言包里存在', () => {
    const missing = [];
    for (const l of routeLocales) {
      for (const loc of LOCALES) {
        if (!(l in packs[loc])) missing.push(`${l} 缺 ${loc}`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `路由引用了语言包里没有的 key（菜单会静默回落到中文 name，切语言时那一格不变）：\n  ${missing.join('\n  ')}`,
    );
  });

  it('🔴 反向：语言包里的每个 menu.* 都被某个路由用到（不留死条目）', () => {
    const dead = menuKeys.filter((k) => !routeLocales.includes(k));
    assert.deepEqual(
      dead,
      [],
      `语言包里有 ${dead.length} 条 menu.* 没有任何路由引用 ⇒ 死条目，改菜单时必然漂：${dead.join(', ')}`,
    );
  });

  it('🔴 方案 (B) 的安全前提：routes.js 的 name 必须仍是中文显示文本，不是 key', () => {
    const bad = routeNames.filter((n) => !CJK.test(n));
    assert.deepEqual(
      bad,
      [],
      `routes.js 里这些 name 不是中文显示文本：${bad.join(', ')}\n` +
        '🔴 把 name 改成 key 等于把方案从 (B) 退化成 (A)：漏翻译时菜单会显示裸 key，' +
        '而且所有直接读 name 的消费方（面包屑 / document.title / attachmentManage.test.js）都会跟着变。',
    );
    assert.ok(
      routeNames.every((n) => !n.startsWith('menu.')),
      'name 不许是 menu. 开头的 key（同上）',
    );
  });

  it('locale 不许侵占既有命名空间（init. / common. / login.）', () => {
    const clash = routeLocales.filter((l) => /^(init|common|login)\./.test(l));
    assert.deepEqual(clash, [], `locale 用了既有命名空间：${clash.join(', ')}`);
  });

  it('menu.* 的 en-US 值必须与 zh-CN 不同（防拿中文充英文）', () => {
    const same = menuKeys.filter((k) => packs['en-US'][k] === packs['zh-CN'][k]);
    assert.deepEqual(same, [], `这些 menu.* 的 en-US 与 zh-CN 逐字相同：${same.join(', ')}`);
  });

  it('尺子反证：合成"一份包少一个 menu key" ⇒ 必须被上面那条点名', () => {
    const fake = {};
    for (const loc of LOCALES) fake[loc] = { ...packs[loc] };
    delete fake['en-US']['menu.welcome'];
    const missing = [];
    for (const l of routeLocales) {
      for (const loc of LOCALES) if (!(l in fake[loc])) missing.push(`${l} 缺 ${loc}`);
    }
    assert.deepEqual(missing, ['menu.welcome 缺 en-US'], '尺子失效：少一个 key 竟然没被点名');
  });

  it('尺子反证：合成"一个死条目" ⇒ 必须被反向那条点名', () => {
    const fakeLocales = routeLocales.filter((l) => l !== 'menu.about');
    const dead = menuKeys.filter((k) => !fakeLocales.includes(k));
    assert.deepEqual(dead, ['menu.about'], '尺子失效：死条目竟然没被点名');
  });

  it('尺子反证：合成"一个被改成 key 的 name" ⇒ 必须被安全前提那条点名', () => {
    const bad = [...routeNames, 'article'].filter((n) => !CJK.test(n));
    assert.deepEqual(bad, ['article'], '尺子失效：name 被改成 key 竟然没被点名');
  });
});

describe('尺子有效性反证（合成输入，不碰真实语言包）', () => {
  // 🔴 把判定逻辑抽成纯函数，才能用合成输入证明它真的会抓到问题 ——
  //    否则「三份包恰好相等」永远可能只是因为比较器坏了。
  const diffKeys = (a, b) => Object.keys(a).filter((k) => !(k in b)).concat(Object.keys(b).filter((k) => !(k in a)));
  const identicalExcept = (a, b, allow) =>
    Object.keys(a).filter((k) => a[k] === b[k] && !allow.includes(k));

  it('合成：一份包少一个 key ⇒ 必须被点名', () => {
    const good = { 'a.b': 'x', 'a.c': 'y' };
    const missing = { 'a.b': 'x' };
    assert.deepEqual(diffKeys(good, missing), ['a.c']);
    assert.deepEqual(diffKeys(good, { ...good }), [], '两份一致时不应报差异');
  });

  it('合成：zh-TW 出现一条与 zh-CN 相同且不在白名单里的值 ⇒ 必须被点名', () => {
    const cn = { 'a.b': '设置', 'a.c': '取消' };
    const tw = { 'a.b': '設定', 'a.c': '取消' }; // a.c 合法相同
    assert.deepEqual(identicalExcept(cn, tw, ['a.c']), [], '白名单内的相同不算问题');
    assert.deepEqual(identicalExcept(cn, tw, []), ['a.c'], '白名单外漏掉就必须报出来');
  });

  it('合成：简体专用字检测真的会命中，且不会误伤合法繁体', () => {
    assert.ok([...'設定'].some((c) => SIMPLIFIED_ONLY.includes(c)) === false, '合法繁体不该被报');
    assert.ok([...'设置'].some((c) => SIMPLIFIED_ONLY.includes(c)) === true, '简体必须被报');
  });
});
