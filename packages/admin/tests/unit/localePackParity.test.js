/**
 * 🔴 多语言第一期守卫：三份语言包的 key 集合必须完全相等，且翻译必须真的存在。
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
  const COMPONENTS = ['index.tsx', 'RestoreFromBackup.tsx'].map((f) => `${INIT_DIR}/${f}`);
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
