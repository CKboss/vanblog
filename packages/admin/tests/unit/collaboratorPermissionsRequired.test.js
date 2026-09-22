const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '../../../..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * 钉住「后台新建/编辑协作者时，**一项权限都不勾**必须被表单校验拦下」。
 *
 * ## 为什么要有这条守卫
 *
 * 2026-09-22 的一次调查里，"零权限协作者"这个状态被怀疑可以从后台直接创建出来，推理是：
 * `CollaboratorModal` 的 `permissions` 字段用了 `ProFormSelect` + `mode:'multiple'` +
 * `rules:[{ required: true }]`，但**没有声明 `type:'array'`**，而 async-validator 的
 * `isEmptyValue(value, type)` 只在 `type === 'array'` 时才把空数组算作"空"
 * ⇒ 推断"`[]` 会被当成有值而放行"。
 *
 * 🔴 **这个推理经实测被推翻**（async-validator **4.2.5**，即 antd 4.x / rc-field-form 实际用的那个版本）：
 * 当规则对象去掉 `message` 之后**只剩 `required` 一个键**时，`getValidationMethod` 会路由到
 * **专用的 required 校验器**，而它自己推断类型 ——
 * `dist-node/index.js:882` 是 `var type = Array.isArray(value) ? 'array' : typeof value;`
 * ⇒ 值是数组时 type 被推成 `'array'` ⇒ `isEmptyValue([], 'array')` 为 **true** ⇒ required 报错。
 * 实测六种规则形状（`{required}`、`{required,type:'array'}`、`{required,whitespace}`、
 * `{required,type:'string'}`、`{required,min:1}`、`{required,validator}`）**全部拦住 `[]`**。
 *
 * 👉 所以"UI 能创建出零权限协作者"这条**不成立**。但**当前没有任何守卫钉住它** ——
 * 将来有人把那条 rules 改掉（例如换成自定义 validator 而忘了处理空数组），保护就会静默消失，
 * 而"能创建出一个只能看到后台外壳的账号"这件事在测试里看不出来。这条守卫就是补这个缺口。
 *
 * ⚠️ 另一层事实（不在这条守卫的范围，但读的人应当知道）：**服务端并不拒绝空权限** ——
 * `pickPermissions` 对空/非数组返回 `[]`、只留一条 warn、不 400。所以 UI 校验是**唯一**那道拦截，
 * 而 UI 校验可以被绕过（直接打 API）。🔴 但绕过之后不再有安全后果：`AccessGuard` 已把免权限路由表
 * 拆成两层（`types/access/access.ts` 的 `bootstrapRoutes` 4 条 + `publicRoutes` 20 条），
 * 零权限账号只能命中引导层 ⇒ 拿不到任何正文、导出、上传或回收站能力。
 */

/**
 * 尽力解析出 admin 实际会用的那个 async-validator（antd 4.x 经 rc-field-form 依赖它）。
 * ⚠️ pnpm 严格隔离 + 路径里带版本号 ⇒ **不硬编码路径**，而是按优先级探测：
 *   1) rc-field-form 自己的 node_modules（那才是表单真正用的实例）
 *   2) 仓库根 .pnpm 存储里的 async-validator
 * 解析不到就返回 null，由调用方**如实打 NOTE 并跳过行为级断言**（不做假的绿）。
 */
function resolveAsyncValidator() {
  const candidates = [];
  const pnpmDir = path.join(repoRoot, 'node_modules/.pnpm');
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith('rc-field-form@')) continue;
      candidates.push(path.join(pnpmDir, entry, 'node_modules/async-validator'));
    }
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith('async-validator@')) continue;
      candidates.push(path.join(pnpmDir, entry, 'node_modules/async-validator'));
    }
  }
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      // eslint-disable-next-line import/no-dynamic-require
      const mod = require(dir);
      const Schema = mod && (mod.default || mod);
      if (typeof Schema === 'function') return { Schema, dir };
    } catch (_e) {
      /* 解析不到就换下一个候选；全部失败时由调用方打 NOTE */
    }
  }
  return null;
}

const MODAL_REL = 'packages/admin/src/components/CollaboratorModal/index.tsx';

describe('协作者权限必填：一项都不勾必须被拦下', () => {
  it('源码级：permissions 字段是 multiple 选择器，且带 required 规则', () => {
    const src = read(MODAL_REL);

    // 反空转：文件真的读到了、而且里面确实有这个字段（否则下面的断言可能在空串上恒真）
    assert.ok(src.length > 500, 'CollaboratorModal 源码短得可疑，可能读错了文件');
    assert.match(src, /name="permissions"/, 'permissions 字段不见了');

    // 取出 permissions 那个 ProFormSelect 的整块（到它的闭合标签），只在这块里断言
    const start = src.indexOf('name="permissions"');
    assert.ok(start > 0, '定位不到 permissions 字段');
    const blockStart = src.lastIndexOf('<ProFormSelect', start);
    assert.ok(blockStart >= 0 && start - blockStart < 400, 'permissions 字段不在一个 ProFormSelect 里');
    const blockEnd = src.indexOf('/>', start);
    assert.ok(blockEnd > start, 'permissions 那个 ProFormSelect 没有闭合');
    const block = src.slice(blockStart, blockEnd);

    assert.match(block, /mode:\s*'multiple'/, 'permissions 不再是多选，规则的前提变了');
    assert.match(block, /required:\s*true/, '🔴 permissions 的 required 规则被去掉了 ⇒ 可以创建零权限协作者');

    // 🔴 尺子有效性反证：这块里确实**没有**声明 type:'array'。
    //    这不是"缺陷"，而是把"保护来自 required 而不是来自 type"这个事实钉住 ——
    //    如果将来有人加了 type:'array'，这条会红，提示他同时更新本文件顶部的说明。
    assert.ok(!/type:\s*'array'/.test(block), '已声明 type:array，请更新本文件顶部关于 required 推断类型的说明');
  });

  it('行为级：async-validator 对 permissions=[] 报 required 错（真的调库，不是推理）', async (t) => {
    const found = resolveAsyncValidator();
    if (!found) {
      // ⚠️ 如实跳过而不是假绿：解析不到库时，这条无法证明任何事。
      //    源码级那条仍然在跑，所以"required 规则存在"这件事始终有守卫。
      t.diagnostic(
        'NOTE: 未能解析到 async-validator（pnpm 存储布局变化？）⇒ 行为级断言本次未执行，' +
          '只有源码级断言在保护这条性质。',
      );
      return;
    }
    const { Schema, dir } = found;
    t.diagnostic(`使用 ${path.relative(repoRoot, dir)}`);

    const run = async (rule, value) => {
      try {
        await new Schema({ permissions: [rule] }).validate({ permissions: value });
        return null;
      } catch (e) {
        return (e && e.errors ? e.errors : []).map((x) => x.message).join('|') || 'error';
      }
    };

    // 与 CollaboratorModal 里逐字同形的规则
    const asWritten = { required: true, message: '这是必填项' };

    // 🔴 核心：空数组必须被拦（这就是"一项权限都不勾"）
    assert.ok(await run(asWritten, []), '🔴 permissions=[] 竟然通过了校验 ⇒ 能创建零权限协作者');
    // undefined / null 也必须被拦（字段从没碰过）
    assert.ok(await run(asWritten, undefined), 'permissions=undefined 竟然通过了校验');
    assert.ok(await run(asWritten, null), 'permissions=null 竟然通过了校验');

    // 🔴 反方向：勾了权限必须放行（否则这条守卫会靠"什么都拦"来恒真）
    assert.equal(await run(asWritten, ['article:create']), null, '勾了权限却被拦下 ⇒ 规则过严');
    assert.equal(await run(asWritten, ['all']), null, "勾了 'all' 却被拦下 ⇒ 规则过严");

    // ⚠️ 显式声明 type:'array' 后行为不变（证明当前形状不是侥幸）
    assert.ok(await run({ required: true, type: 'array', message: '这是必填项' }, []), 'type:array 下 [] 反而通过了');
    assert.equal(
      await run({ required: true, type: 'array', message: '这是必填项' }, ['article:create']),
      null,
      'type:array 下勾了权限却被拦下',
    );
  });
});
