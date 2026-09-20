import { BackupController } from './backup.controller';

/**
 * `POST /api/admin/backup/jwt/rotate` 的对外契约。
 *
 * ⚠️ 这个入口落在 `/api/admin/backup/**` 下面不是随手放的：该前缀已被划进
 * `SUPER_ADMIN_ONLY_ROUTE_PREFIXES`，所以勾了「所有权限」的协作者**不能**轮换密钥
 * （那等于能把管理员本人和所有外部集成一起踢下线）。权限口径由
 * `provider/access/accessGuard.spec.ts` 钉住，这里只测控制器自己的契约。
 *
 * `rotateJwtSecret` 被打桩：它要连真库，而这里要测的是"控制器怎么把结果说给站长听"。
 * `switchJwtSigningKey` **不打桩**（用真实现）—— 它是不是真的把签发密钥切过去了，
 * 正是 `restartRequired` 这个字段的唯一依据。
 */
jest.mock('src/utils/initJwt', () => {
  const actual = jest.requireActual('src/utils/initJwt');
  return { ...actual, rotateJwtSecret: jest.fn() };
});

const { rotateJwtSecret } = require('src/utils/initJwt') as {
  rotateJwtSecret: jest.Mock;
};

const OLD_SECRET = 'controller-stub-OLD-secret-0123456789abcdef';
const NEW_SECRET = 'rotated-NEW-secret-0123456789abcdef-ffffffff';

function makeController(jwtServiceStub: any) {
  // 前 12 个依赖这条路一个都不用（它只碰 jwtService 与自己的 logger）
  const args: any[] = new Array(12).fill(undefined);
  args.push(jwtServiceStub);
  return new (BackupController as any)(...args);
}

function rotateResult() {
  return {
    kid: 'aaaaaaaaaaaaaaaa',
    previousKid: 'bbbbbbbbbbbbbbbb',
    rotatedAt: '2026-09-20T00:00:00.000Z',
    graceDays: 7,
    apiTokensAffected: 4,
  };
}

beforeEach(() => {
  rotateJwtSecret.mockReset();
  rotateJwtSecret.mockImplementation(async (opts: any) => {
    // 模拟真实行为：把新密钥交给签发侧切换回调
    opts?.onSigningKeySwitched?.(NEW_SECRET);
    return rotateResult();
  });
});

describe('POST /api/admin/backup/jwt/rotate', () => {
  it('graceDays 非法 ⇒ 400，且报错里带上收到的值（可照做）', async () => {
    const controller = makeController({ options: { secret: OLD_SECRET } });
    for (const bad of ['-1', 'abc', '99999', '1e999']) {
      await expect(controller.rotateJwtSecretEndpoint({ graceDays: bad as any })).rejects.toThrow(/0 到 365/);
    }
    // ⚠️ 一次都没真的轮换（校验在动手之前）
    expect(rotateJwtSecret).not.toHaveBeenCalled();
  });

  it('graceDays 合法 ⇒ 原样传下去（数字与数字字符串都认，空值 = 用默认）', async () => {
    const controller = makeController({ options: { secret: OLD_SECRET } });
    await controller.rotateJwtSecretEndpoint({ graceDays: 3 });
    expect(rotateJwtSecret.mock.calls[0][0].graceDays).toBe(3);
    await controller.rotateJwtSecretEndpoint({ graceDays: '0' });
    expect(rotateJwtSecret.mock.calls[1][0].graceDays).toBe(0);
    await controller.rotateJwtSecretEndpoint({});
    expect(rotateJwtSecret.mock.calls[2][0].graceDays).toBeUndefined();
  });

  it('签发侧切成功 ⇒ restartRequired=false，响应说清宽限期与 API Token 的后果', async () => {
    const svc: any = { options: { secret: OLD_SECRET } };
    const controller = makeController(svc);
    const res: any = await controller.rotateJwtSecretEndpoint({ graceDays: 7 });
    expect(res.statusCode).toBe(200);
    expect(res.data.restartRequired).toBe(false);
    expect(res.data.kid).toBe('aaaaaaaaaaaaaaaa');
    expect(res.data.apiTokensAffected).toBe(4);
    // ⚠️ 真的把签发密钥切过去了（这是 restartRequired=false 的唯一依据）
    expect(svc.options.secret).toBe(NEW_SECRET);
    // 站长最关心的后果必须在文案里：API Token 会一起失效
    expect(res.message).toContain('API Token');
    expect(res.message).toContain('7 天宽限期');
  });

  it('⚠️ 签发侧切不动 ⇒ restartRequired=true 并叫站长重启，绝不静默留在旧密钥上', async () => {
    // 形状不对（没有字符串 secret）：模拟升级 @nestjs/jwt 后内部结构变了
    const svc: any = { options: {} };
    const controller = makeController(svc);
    const res: any = await controller.rotateJwtSecretEndpoint({ graceDays: 7 });
    expect(res.statusCode).toBe(200); // 密钥确实换了，不能报失败
    expect(res.data.restartRequired).toBe(true);
    expect(res.message).toContain('重启');
    expect(res.message).toContain('签发侧没能就地切换');
  });

  it('jwtService 压根没注入（DI 形状变了）⇒ 同样是 restartRequired=true，而不是崩', async () => {
    const controller = makeController(undefined);
    const res: any = await controller.rotateJwtSecretEndpoint({});
    expect(res.data.restartRequired).toBe(true);
  });

  it('⚠️ 响应里不含任何密钥本体（它会进后台日志与浏览器历史）', async () => {
    const svc: any = { options: { secret: OLD_SECRET } };
    const controller = makeController(svc);
    const res: any = await controller.rotateJwtSecretEndpoint({ graceDays: 7 });
    const text = JSON.stringify(res);
    expect(text).not.toContain(OLD_SECRET);
    expect(text).not.toContain(NEW_SECRET);
    // 对照：kid 是**可以**出现的（它是公开的，本来就在每个 token 头里）
    expect(text).toContain('aaaaaaaaaaaaaaaa');
  });
});
