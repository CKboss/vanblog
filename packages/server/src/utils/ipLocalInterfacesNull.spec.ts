/**
 * `getLocalIps()` 必须能在"网卡表里出现 undefined 值"时活下来。
 *
 * ## 类型层面 vs 运行时层面（如实区分，别混进"修了 N 个缺陷"的计数）
 * `os.networkInterfaces()` 返回 `NodeJS.Dict<NetworkInterfaceInfo[]>`，即 `{ [k: string]: T | undefined }`
 * ⇒ `interfaces[devName]` 的类型**带 undefined**，这是 strictNullChecks 报 TS18048 的原因。
 * 运行时 `for...in` 枚举到的键必然存在、Node 也不会把值设成 undefined ⇒ **实践上是假阳性**。
 * ⚠️ 但它是 `export` 的，将来被导入就复活；而且跳过空值只要一次 `continue`，
 * 所以按"真缺陷"的标准修，**不用 `iface!`**（非空断言会把"我核实过它非空"从类型系统里抹掉）。
 *
 * ## 可达性（写清楚，免得被误读成匿名 DoS）
 * 本函数目前**没有活的调用方**：唯一引用它的 `getDefaultSubjects()`，其唯一调用点在
 * `provider/caddy/caddy.provider.ts:327` 是**注释掉的**。`provider/auth/login.guard.ts` 从本文件
 * 只导入 CIDR 三件套（`ADMIN_LOGIN_ALLOW_CIDR_ENV` / `isIpAllowedByPolicy` /
 * `resolveAdminLoginCidrPolicy`），**不含** `getLocalIps` ⇒ 登录路径不受影响。
 */
// ⚠️ 必须用 jest.mock 工厂，不能用 jest.spyOn(os, 'networkInterfaces')：
//    `import * as os` 经 __importStar 会得到一个**属性不可重定义**的命名空间副本，
//    spyOn 会抛 `TypeError: Cannot redefine property: networkInterfaces`（实测踩过）。
//    jest.mock 在 import 之前生效，所以是唯一可靠的注入点。
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, networkInterfaces: jest.fn(() => ({})) };
});
import * as os from 'os';
import { getLocalIps } from './ip';

const networkInterfaces = os.networkInterfaces as unknown as jest.Mock;

describe('getLocalIps 对畸形网卡表的容错', () => {
  afterEach(() => networkInterfaces.mockReset().mockReturnValue({}));

  it('正对照：正常网卡表返回全部 IPv4（证明下面几条不是"恒返回空数组"）', () => {
    networkInterfaces.mockReturnValue({
      eth0: [
        { address: '10.0.0.5', family: 'IPv4', netmask: '255.255.255.0', internal: false, cidr: '10.0.0.5/24', mac: '00:00:00:00:00:00' },
        { address: 'fe80::1', family: 'IPv6', netmask: 'ffff:ffff::', internal: false, cidr: 'fe80::1/64', mac: '00:00:00:00:00:00' },
      ],
      lo: [
        { address: '127.0.0.1', family: 'IPv4', netmask: '255.0.0.0', internal: true, cidr: '127.0.0.1/8', mac: '00:00:00:00:00:00' },
      ],
    } as any);
    expect(getLocalIps().sort()).toEqual(['10.0.0.5', '127.0.0.1']);
  });

  it('🔴 某个网卡的值是 undefined 时不抛 TypeError，并跳过它、保留其它网卡', () => {
    networkInterfaces.mockReturnValue({
      broken: undefined,
      eth0: [
        { address: '10.0.0.5', family: 'IPv4', netmask: '255.255.255.0', internal: false, cidr: '10.0.0.5/24', mac: '00:00:00:00:00:00' },
      ],
    } as any);
    expect(() => getLocalIps()).not.toThrow();
    expect(getLocalIps()).toEqual(['10.0.0.5']);
  });

  it('数组里有空洞（undefined 元素）时也不抛', () => {
    networkInterfaces.mockReturnValue({
      eth0: [
        undefined,
        { address: '10.0.0.9', family: 'IPv4', netmask: '255.255.255.0', internal: false, cidr: '10.0.0.9/24', mac: '00:00:00:00:00:00' },
      ],
    } as any);
    expect(() => getLocalIps()).not.toThrow();
    expect(getLocalIps()).toEqual(['10.0.0.9']);
  });

  it('空网卡表返回空数组（不抛）', () => {
    networkInterfaces.mockReturnValue({} as any);
    expect(getLocalIps()).toEqual([]);
  });

  it('⚠️ 尺子有效性反证：改前那两行在同样输入下**确实会抛** TypeError', () => {
    // 这不是产品断言，是证明"上面那条 not.toThrow 量到了东西"：
    // 把修复前的循环体原样重放一遍（`iface.length` 与 `iface[i].family`），必须抛。
    const malformed = { broken: undefined } as any;
    const beforeFix = () => {
      const res: string[] = [];
      for (const devName in malformed) {
        const iface = malformed[devName];
        for (let i = 0; i < iface.length; i++) {
          const alias = iface[i];
          if (alias.family === 'IPv4') res.push(alias.address);
        }
      }
      return res;
    };
    expect(beforeFix).toThrow(TypeError);
  });
});
