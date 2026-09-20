const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  MIN_ACCOUNT_PASSWORD_LENGTH,
  ACCOUNT_PASSWORD_MIN_MESSAGE,
  accountPasswordMinRule,
} = require('../../src/services/van-blog/passwordPolicy');

/**
 * 「账号口令 ≥10」的强制点守卫。
 *
 * 为什么值得单独一个测试文件：服务端在后台路径上**数学上判不了**口令强度 ——
 * 浏览器先把口令 sha256 派生成恒 64 位十六进制摘要（`services/van-blog/encryptPwd.js`）
 * 再发出去，摘要长度与原始口令无关且不可逆。所以真正的强制点只有两处：
 *   ① 后台的四个口令表单（本文件钉住）；
 *   ② `provider/init/envBootstrap.ts` 的零接触初始化（那里是原始口令，服务端判得了，
 *      由 `packages/server/src/provider/init/envBootstrap.spec.ts` 钉住）。
 * 这两处只要有一处漂移成"没有下限"，弱口令就能重新进得来，而且**不会有任何报错**。
 *
 * ⚠️ 断言的是**规则形状与接线**，不是"文件里出现了 10 这个数字"：
 *    后者会被注释、被无关代码、甚至被这行说明本身满足（本仓库已踩过 8 次
 *    "断言匹配到解释性注释"）。
 */

const ADMIN_SRC = path.resolve(__dirname, '../../src');
const SERVER_SRC = path.resolve(__dirname, '../../../server/src');

/** 四个后台口令表单（相对 packages/admin/src）。新增口令表单时必须加进这张表。 */
const ACCOUNT_PASSWORD_FORMS = [
  'pages/InitPage/index.tsx',
  'components/CollaboratorModal/index.tsx',
  'pages/user/Restore/index.jsx',
  'pages/SystemConfig/tabs/User.jsx',
];

const read = (...parts) => readFileSync(path.resolve(...parts), 'utf-8');

/**
 * 剥掉整行注释（`//`、`/*`、`*`）。
 *
 * ⚠️ 只剥**整行**注释，不剥行尾注释：行尾剥离会把 `https://…` 之类的内容一起啃掉。
 * 也**不要**去用 server 那个 `stripCommentsForAnchor`（TS 剥注释器）—— 那是 TS 别名路径，
 * 这里的 `node --test` 解析不到，而且它对 shell/JSX 语料并不安全。
 */
function stripWholeLineComments(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/**
 * 抽出文件里所有 `<ProFormText.Password …>` 元素的属性区。
 * 返回 [{ attrs, hasRule }]，只关心 `name="password"` 的那些。
 */
function extractPasswordFields(source) {
  const out = [];
  const re = /<ProFormText\.Password\b([\s\S]*?)(?:\/>|><\/ProFormText\.Password>)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push({ attrs: m[1], hasRule: /accountPasswordMinRule\(\s*\)/.test(m[1]) });
  }
  return out;
}

describe('passwordPolicy：规则本身的形状（行为级，不是读源码文本）', () => {
  it('accountPasswordMinRule() 返回的规则带 min，且值等于导出常量', () => {
    const rule = accountPasswordMinRule();
    assert.equal(typeof rule.min, 'number');
    assert.equal(rule.min, MIN_ACCOUNT_PASSWORD_LENGTH);
    assert.equal(MIN_ACCOUNT_PASSWORD_LENGTH, 10);
  });

  it('规则带可照做的提示：说明最少多少个字符，并给出理由（不是"格式错误"这种废话）', () => {
    const rule = accountPasswordMinRule();
    assert.equal(typeof rule.message, 'string');
    assert.ok(rule.message.includes(String(MIN_ACCOUNT_PASSWORD_LENGTH)), '提示里要点名最小长度');
    assert.ok(rule.message.includes('字符'), '计数单位要说清是"字符"，不是字节');
    assert.ok(rule.message.length > 20, '提示要解释为什么，不能只有一个数字');
    assert.equal(rule.message, ACCOUNT_PASSWORD_MIN_MESSAGE);
  });

  it('每次调用返回**新对象**（antd/async-validator 会往规则对象上挂字段，共享实例会互相污染）', () => {
    const a = accountPasswordMinRule();
    const b = accountPasswordMinRule();
    assert.notEqual(a, b, '两次调用必须是不同对象');
    a.field = 'polluted';
    assert.equal(b.field, undefined, '污染一个不能影响另一个');
  });

  it('负向对照：把 min 改成 1 时上面的断言必须抓得到（证明它不是空断言）', () => {
    const weakened = { min: 1, message: ACCOUNT_PASSWORD_MIN_MESSAGE };
    assert.notEqual(weakened.min, MIN_ACCOUNT_PASSWORD_LENGTH);
    // 尺子本身要能量出旧形状：如果有人把常量改成 1，"min === 常量"这条会照样通过，
    // 所以还有一条**绝对值**断言（上面的 `assert.equal(MIN_ACCOUNT_PASSWORD_LENGTH, 10)`）。
    assert.ok(
      extractPasswordFields('<ProFormText.Password name="password" rules={[{ min: 1 }]} />').every(
        (f) => f.hasRule === false,
      ),
      '只写 min:1 而不接线到工厂函数，必须被判为"没有这条规则"',
    );
  });
});

describe('四个后台口令表单都接上了这条规则（接线级断言）', () => {
  for (const rel of ACCOUNT_PASSWORD_FORMS) {
    it(`${rel}：name="password" 的字段挂了 accountPasswordMinRule()`, () => {
      const source = read(ADMIN_SRC, rel);
      const fields = extractPasswordFields(source);
      const passwordFields = fields.filter((f) => /name="password"/.test(f.attrs));

      // ⚠️ 防空转：这个文件里必须真的扫到了 password 字段，否则"全都没违规"是假绿
      assert.ok(passwordFields.length >= 1, `${rel} 里没扫到 name="password" 字段（抽取器失效？）`);
      for (const f of passwordFields) {
        assert.equal(f.hasRule, true, `${rel} 的 password 字段没有挂 accountPasswordMinRule()`);
      }
    });

    it(`${rel}：确实 import 了 passwordPolicy（不是靠巧合的同名函数）`, () => {
      const source = read(ADMIN_SRC, rel);
      assert.match(source, /from\s+'@\/services\/van-blog\/passwordPolicy'/);
      assert.match(source, /accountPasswordMinRule/);
    });
  }

  it('抽取器本身有效：漏掉规则的写法必须被判为缺失（负向对照）', () => {
    const withoutRule = `
      <ProFormText.Password
        name="password"
        rules={[{ required: true, message: '这是必填项' }]}
      />`;
    const fields = extractPasswordFields(withoutRule);
    assert.equal(fields.length, 1, '要能扫到这个元素');
    assert.equal(fields[0].hasRule, false, '旧写法（只有 required）必须被判为"没有 min 规则"');
  });

  it('登录表单**不许**加长度下限（否则历史弱口令账号会被永久锁在门外）', () => {
    // 这条是"防止有人好心办坏事"的守卫：登录时必须接受库里已有的任何口令，
    // 强度校验属于**设置**口令的时刻，不属于**证明**口令的时刻。
    // 已经存在的短口令账号（本次改动之前设的）一旦被登录表单拦下，就再也登不进来，
    // 只能走「忘记密码」+ 恢复密钥，而恢复密钥每次重启都会变。
    const source = read(ADMIN_SRC, 'pages/user/Login/index.jsx');
    assert.ok(source.includes('encryptPwd'), '确认这真的是登录页（它也做派生）');
    const passwordFields = extractPasswordFields(source).filter((f) => /name="password"/.test(f.attrs));
    assert.ok(passwordFields.length >= 1, '登录页应当有 password 字段（抽取器失效？）');
    for (const f of passwordFields) {
      assert.equal(f.hasRule, false, '登录表单不该有最小长度规则');
    }
  });
});

describe('跨包对账：三处的"10"必须是同一个数（两个包无法互相 import，只能对账）', () => {
  it('服务端 user.provider.ts 的 MIN_ACCOUNT_PASSWORD_LENGTH 与后台常量相等', () => {
    const source = read(SERVER_SRC, 'provider/user/user.provider.ts');
    const m = source.match(/export\s+const\s+MIN_ACCOUNT_PASSWORD_LENGTH\s*=\s*(\d+)\s*;/);
    // ⚠️ 防空转：正则必须真的匹配到，否则 null 会让后面的断言变成"没有发现不一致"的假绿
    assert.ok(m, '没在服务端找到 MIN_ACCOUNT_PASSWORD_LENGTH 的定义（改名了？请同步这里）');
    assert.equal(
      Number(m[1]),
      MIN_ACCOUNT_PASSWORD_LENGTH,
      '服务端与后台的口令最小长度漂移了：两边必须一起改',
    );
  });

  it('服务端 envBootstrap.ts **复用**那个常量，而不是自己写一个字面量 10', () => {
    const code = stripWholeLineComments(read(SERVER_SRC, 'provider/init/envBootstrap.ts'));
    assert.match(
      code,
      /import\s*\{[^}]*\bMIN_ACCOUNT_PASSWORD_LENGTH\b[^}]*\}\s*from\s*'src\/provider\/user\/user\.provider'/,
      'envBootstrap 应当从 user.provider import 这个常量',
    );
    // ⚠️ 用正则而不是 `includes('password.length < …')`：变量叫什么名字是实现细节
    //    （它一度就叫 `password.length`，后来为了按码点计数改成 `passwordLength`），
    //    钉死拼写会让这条守卫在实现改名后**静默失效**（本仓库踩过多次）。
    assert.match(
      code,
      /\bpassword(?:Length|\.length)\s*<\s*MIN_ACCOUNT_PASSWORD_LENGTH\b/,
      '长度判定要用常量，不要用字面量',
    );
    // ⚠️ 剥注释之后再断言"不存在"：这个文件的注释里必然写着 10 与常量名，
    //    不剥就会匹配到解释性注释（本仓库踩过 8 次）。
    // 两种拼写都要挡住，否则改个变量名就能绕过这条守卫
    assert.equal(
      /\bpassword(?:Length|\.length)\s*<\s*\d+/.test(code),
      false,
      '不许出现写死的数字下限（例如 `passwordLength < 10`）：那就是第二个真相源',
    );
  });

  it('负向对照：写死字面量的旧形状必须被上一条抓出来', () => {
    const re = /\bpassword(?:Length|\.length)\s*<\s*\d+/;
    assert.equal(re.test('if (password.length < 10) {'), true, '旧拼写 + 字面量要能抓到');
    assert.equal(re.test('if (passwordLength < 10) {'), true, '新拼写 + 字面量也要能抓到');
    assert.equal(re.test('if (passwordLength < MIN_ACCOUNT_PASSWORD_LENGTH) {'), false, '用常量时必须放行');
  });

  it('envBootstrap 的拒绝文案里不回显口令本身（只允许出现长度）', () => {
    const code = read(SERVER_SRC, 'provider/init/envBootstrap.ts');
    // 错误对象里能用的是 password.length / Array.from(password).length 与常量，
    // 不许把 ${password} 直接拼进文案。
    assert.equal(
      /\$\{password\}/.test(stripWholeLineComments(code)),
      false,
      '拒绝文案里出现了 ${password}：口令会进容器日志',
    );
    assert.match(code, /Array\.from\(password\)\.length/, '长度应按码点计，与后台表单同口径');
  });
});
