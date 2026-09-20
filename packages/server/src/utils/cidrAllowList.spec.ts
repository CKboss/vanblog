import {
  ADMIN_LOGIN_ALLOW_CIDR_ENV,
  isIpAllowedByPolicy,
  parseCidrPolicy,
  resetCidrPolicyCacheForTest,
  resolveAdminLoginCidrPolicy,
} from './ip';

/**
 * 后台登录的网段白名单（`VANBLOG_ADMIN_LOGIN_ALLOW_CIDR`）。
 *
 * ## 这三条性质任何一条被改坏都算回归
 *
 *  1. **没配 = 不限制**：默认行为必须与本轮之前逐字节一致，否则升级就把所有站长锁在门外；
 *  2. **配了但配错 = 全部拒绝（失败关闭）**：静默忽略非法项会让站长以为锁好了其实没锁，
 *     那是发现不了的故障；全拒是当场能发现的故障；
 *  3. **证明不了来源 = 拒绝**：`'unknown'`、空串、不是 IP 字面量的东西一律不放行。
 *
 * ⚠️ 还有一条容易猜错、猜错就静默失效的实现事实：`net.BlockList.check()` 的 family
 *    参数**默认是 `'ipv4'`**，所以拿 IPv6 地址去 check 会恒为 false（不是"匹配不上规则"，
 *    是根本没按 IPv6 判）。下面有专门的用例钉住 IPv6 网段真的能命中。
 */
describe('parseCidrPolicy：把环境变量解析成策略', () => {
  it('未设置 / 空串 / 全空白 ⇒ disabled（= 不限制，与本轮之前行为一致）', () => {
    for (const raw of [undefined, '', '   ', '\t\n', null]) {
      expect(parseCidrPolicy(raw).kind).toBe('disabled');
    }
  });

  it('只有逗号和空白（",, ,"）⇒ 仍然算 disabled，不算"配错"', () => {
    // ⚠️ 这条区分很重要：把"没写东西"判成 invalid 会让一个手滑的逗号锁死整个后台
    expect(parseCidrPolicy(',, ,').kind).toBe('disabled');
  });

  it('单个 IPv4 网段 ⇒ allow，且 ranges 里是规范化后的写法', () => {
    const policy = parseCidrPolicy('203.0.113.0/24');
    expect(policy.kind).toBe('allow');
    expect(policy.kind === 'allow' && policy.ranges).toEqual(['203.0.113.0/24']);
  });

  it('裸 IP ⇒ 当作 /32（IPv6 裸地址 ⇒ /128）', () => {
    const v4 = parseCidrPolicy('198.51.100.7');
    expect(v4.kind === 'allow' && v4.ranges).toEqual(['198.51.100.7/32']);
    const v6 = parseCidrPolicy('2001:db8::1');
    expect(v6.kind === 'allow' && v6.ranges).toEqual(['2001:db8::1/128']);
  });

  it('逗号分隔多项、带空格、带尾随逗号 ⇒ 全部收进来', () => {
    const policy = parseCidrPolicy(' 203.0.113.0/24 , 198.51.100.7/32, 2001:db8::/32, ');
    expect(policy.kind).toBe('allow');
    expect(policy.kind === 'allow' && policy.ranges).toEqual([
      '203.0.113.0/24',
      '198.51.100.7/32',
      '2001:db8::/32',
    ]);
  });

  it('/0 ⇒ 合法（等于"放行一切"，虽然没意义，但那是站长的明确意图）', () => {
    expect(parseCidrPolicy('0.0.0.0/0').kind).toBe('allow');
    expect(isIpAllowedByPolicy(parseCidrPolicy('0.0.0.0/0'), '8.8.8.8')).toBe(true);
  });
});

describe('parseCidrPolicy：非法配置一律失败关闭', () => {
  // ⚠️ 不要用 `as const`：那会让元组变成 readonly，与 `it.each` 期望的可变元组类型不兼容，
  //    整个套件会**加载失败**（表现为 `Tests: 0 total`，很容易被误读成"没有用例失败"）。
  const bad: Array<[string, string]> = [
    ['不是 IP', 'example.com'],
    ['IPv4 段写错', '203.0.113.0/255.255.255.0'],
    ['IPv4 前缀越界', '203.0.113.0/33'],
    ['IPv6 前缀越界', '2001:db8::/129'],
    ['前缀不是数字', '203.0.113.0/abc'],
    ['负前缀', '203.0.113.0/-1'],
    ['八位组越界', '999.0.113.0/24'],
    ['五段 IPv4', '203.0.113.0.5/24'],
    ['空的 base', '/24'],
    ['两个斜杠', '203.0.113.0/24/8'],
    ['十六进制前缀', '203.0.113.0/0x18'],
    ['一项合法一项非法', '203.0.113.0/24,not-an-ip'],
  ];

  it.each(bad)('%s ⇒ invalid（不是 allow，也不是 disabled）', (_label, raw) => {
    const policy = parseCidrPolicy(raw);
    expect(policy.kind).toBe('invalid');
    // invalid 必须带上"具体哪几项非法"，否则站长只看到"进不去"却没有可照做的线索
    expect(policy.kind === 'invalid' && policy.invalid.length).toBeGreaterThan(0);
  });

  it('失败关闭：invalid 策略下**任何** IP 都被拒（包括网段内的）', () => {
    const policy = parseCidrPolicy('203.0.113.0/24,not-an-ip');
    expect(policy.kind).toBe('invalid');
    expect(isIpAllowedByPolicy(policy, '203.0.113.9')).toBe(false);
    expect(isIpAllowedByPolicy(policy, '127.0.0.1')).toBe(false);
  });

  it('超过 64 项 ⇒ 也算 invalid（静默截断会让"我配了 100 条"变成"只有前 64 条生效"）', () => {
    const many = Array.from({ length: 70 }, (_unused, i) => `203.0.${i}.0/24`).join(',');
    const policy = parseCidrPolicy(many);
    expect(policy.kind).toBe('invalid');
  });

  it('负向对照：合法的 64 项不会被误判', () => {
    const ok = Array.from({ length: 64 }, (_unused, i) => `203.0.${i}.0/24`).join(',');
    expect(parseCidrPolicy(ok).kind).toBe('allow');
  });
});

describe('isIpAllowedByPolicy：判定本身', () => {
  const policy = parseCidrPolicy('203.0.113.0/24,198.51.100.7/32,2001:db8::/32');

  it('网段内 / 网段外', () => {
    expect(isIpAllowedByPolicy(policy, '203.0.113.9')).toBe(true);
    expect(isIpAllowedByPolicy(policy, '203.0.113.254')).toBe(true);
    expect(isIpAllowedByPolicy(policy, '203.0.114.9')).toBe(false);
    expect(isIpAllowedByPolicy(policy, '8.8.8.8')).toBe(false);
  });

  it('裸 IP 只精确匹配那一个地址（相邻地址不放行）', () => {
    expect(isIpAllowedByPolicy(policy, '198.51.100.7')).toBe(true);
    expect(isIpAllowedByPolicy(policy, '198.51.100.8')).toBe(false);
    expect(isIpAllowedByPolicy(policy, '198.51.100.6')).toBe(false);
  });

  it('IPv6 网段真的能命中（BlockList.check 的 family 默认是 ipv4，猜错就恒 false）', () => {
    expect(isIpAllowedByPolicy(policy, '2001:db8::1')).toBe(true);
    expect(isIpAllowedByPolicy(policy, '2001:db8:0:1::9')).toBe(true);
    expect(isIpAllowedByPolicy(policy, '2001:db9::1')).toBe(false);
    expect(isIpAllowedByPolicy(policy, '::1')).toBe(false);
  });

  it('IPv4-mapped 形式按 IPv4 规则判（Node 在容器里常把对端报成 ::ffff:x.x.x.x）', () => {
    expect(isIpAllowedByPolicy(policy, '::ffff:203.0.113.9')).toBe(true);
    expect(isIpAllowedByPolicy(policy, '::ffff:203.0.114.9')).toBe(false);
  });

  it('证明不了来源 ⇒ 拒绝（unknown / 空 / 垃圾 / 非字符串）', () => {
    for (const ip of ['unknown', '', '   ', 'not-an-ip', null, undefined, 12345, {}]) {
      expect(isIpAllowedByPolicy(policy, ip)).toBe(false);
    }
  });

  it('disabled 策略下**任何**值都放行（包括垃圾值 —— 没配就是没配，不要顺手加校验）', () => {
    const disabled = parseCidrPolicy('');
    expect(disabled.kind).toBe('disabled');
    for (const ip of ['unknown', '', 'not-an-ip', '8.8.8.8', null]) {
      expect(isIpAllowedByPolicy(disabled, ip)).toBe(true);
    }
  });

  it('前后空白不影响判定（IP 来源可能是拼接出来的）', () => {
    expect(isIpAllowedByPolicy(policy, '  203.0.113.9  ')).toBe(true);
  });
});

describe('resolveAdminLoginCidrPolicy：读环境变量 + 单槽记忆化', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    resetCidrPolicyCacheForTest();
    delete process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV];
  });

  afterEach(() => {
    process.env = saved;
    resetCidrPolicyCacheForTest();
  });

  it('未设置 ⇒ disabled', () => {
    expect(resolveAdminLoginCidrPolicy({} as any).kind).toBe('disabled');
  });

  it('设了合法值 ⇒ allow，且同一个值重复调用返回同一个对象（记忆化生效）', () => {
    const env = { [ADMIN_LOGIN_ALLOW_CIDR_ENV]: '203.0.113.0/24' } as any;
    const first = resolveAdminLoginCidrPolicy(env);
    const second = resolveAdminLoginCidrPolicy(env);
    expect(first.kind).toBe('allow');
    expect(second).toBe(first); // 同一引用 ⇒ 没有每次重建 BlockList
  });

  it('值变了 ⇒ 换掉整槽（不是叠加，所以状态不可能无界增长）', () => {
    const first = resolveAdminLoginCidrPolicy({ [ADMIN_LOGIN_ALLOW_CIDR_ENV]: '203.0.113.0/24' } as any);
    const second = resolveAdminLoginCidrPolicy({ [ADMIN_LOGIN_ALLOW_CIDR_ENV]: '198.51.100.0/24' } as any);
    expect(second).not.toBe(first);
    expect(isIpAllowedByPolicy(second, '203.0.113.9')).toBe(false);
    expect(isIpAllowedByPolicy(second, '198.51.100.9')).toBe(true);
  });

  it('环境变量名就是文档里那个（改名会让"配了不生效"静默发生）', () => {
    expect(ADMIN_LOGIN_ALLOW_CIDR_ENV).toBe('VANBLOG_ADMIN_LOGIN_ALLOW_CIDR');
  });
});
