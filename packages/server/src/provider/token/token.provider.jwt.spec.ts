import { JwtModule, JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { TokenProvider } from './token.provider';
import { SettingProvider } from '../setting/setting.provider';

/**
 * `@nestjs/jwt` 10 → 11 的回归钉子：**登录 token 与 API token 还能签出来、还能验回去**。
 *
 * 为什么值得单独钉：这两条路都在"没有它就登不进后台"的关键位置
 * （`TokenProvider.createToken` 是登录，`createAPIToken` 是后台的 API Token），
 * 而它们**无法用公开接口验证** —— 登录要密码（本机没有），API Token 要先登录才能建。
 * 也就是说升级 @nestjs/jwt 之后，"签 token"这条链在常规验收里是完全测不到的，
 * 坏掉只会在用户下次登录时暴露。这里用与 `app.module.ts` **同一形状**的
 * `JwtModule.registerAsync({ useFactory })` 起一个真模块，接真的 `JwtService`，
 * 只把 Mongo 模型和 SettingProvider 换成桩。
 */
const SECRET = 'spec-only-secret-not-used-anywhere-else';

function b64urlDecode(part: string): any {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function createFakeTokenModel(created: any[]) {
  return {
    create: jest.fn(async (doc: any) => {
      created.push(doc);
      return doc;
    }),
    find: jest.fn(() => ({ exec: async () => created })),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
    updateMany: jest.fn(async () => ({ modifiedCount: 0 })),
  };
}

async function buildModule(loginSetting: any) {
  const created: any[] = [];
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      // 与 app.module.ts 里完全同形状的异步注册（那边是 secret: await initJwt()）
      JwtModule.registerAsync({
        useFactory: async () => ({
          secret: SECRET,
          signOptions: { expiresIn: 3600 * 24 * 7 },
        }),
      }),
    ],
    providers: [
      TokenProvider,
      { provide: getModelToken('Token'), useValue: createFakeTokenModel(created) },
      { provide: SettingProvider, useValue: { getLoginSetting: jest.fn(async () => loginSetting) } },
    ],
  }).compile();
  await moduleRef.init();
  return {
    moduleRef,
    created,
    provider: moduleRef.get(TokenProvider),
    jwt: moduleRef.get(JwtService),
  };
}

describe('@nestjs/jwt 11：登录 token 与 API token 的签发/校验', () => {
  jest.setTimeout(30000);

  it('登录 token：HS256 三段式，claims 与 expiresIn 都对，且能用同一个密钥验回去', async () => {
    const ctx = await buildModule({ expiresIn: 3600 * 24 * 7 });
    try {
      const token = await ctx.provider.createToken({ sub: 0, username: 'spec-admin' });
      expect(typeof token).toBe('string');
      const parts = token.split('.');
      expect(parts).toHaveLength(3);

      const header = b64urlDecode(parts[0]);
      expect(header.alg).toBe('HS256');
      expect(header.typ).toBe('JWT');

      const payload = b64urlDecode(parts[1]);
      expect(payload.sub).toBe(0);
      expect(payload.username).toBe('spec-admin');
      // 数字型 expiresIn 是"秒"，不是毫秒（jsonwebtoken 的语义，@nestjs/jwt 只是转发）
      expect(Number(payload.exp) - Number(payload.iat)).toBe(3600 * 24 * 7);

      // 用 JwtService 验签（passport-jwt 走的是同一个密钥与同一个算法）
      const verified: any = ctx.jwt.verify(token);
      expect(verified.username).toBe('spec-admin');
      expect(verified.sub).toBe(0);

      // 签出来的 token 确实落库了（TokenGuard 会查这张表，光有 JWT 不够）
      expect(ctx.created.length).toBe(1);
      expect(ctx.created[0]).toMatchObject({ userId: 0, token, expiresIn: 3600 * 24 * 7 });
    } finally {
      await ctx.moduleRef.close();
    }
  });

  it('后台的登录过期设置会覆盖默认值（expiresIn=60 秒）', async () => {
    const ctx = await buildModule({ expiresIn: 60 });
    try {
      const token = await ctx.provider.createToken({ sub: 3, username: 'collab' });
      const payload = b64urlDecode(token.split('.')[1]);
      expect(Number(payload.exp) - Number(payload.iat)).toBe(60);
      expect(ctx.created[0].expiresIn).toBe(60);
    } finally {
      await ctx.moduleRef.close();
    }
  });

  it('没有登录设置时用默认的 7 天', async () => {
    const ctx = await buildModule(undefined);
    try {
      const token = await ctx.provider.createToken({ sub: 0, username: 'spec-admin' });
      const payload = b64urlDecode(token.split('.')[1]);
      expect(Number(payload.exp) - Number(payload.iat)).toBe(3600 * 24 * 7);
    } finally {
      await ctx.moduleRef.close();
    }
  });

  it('API token：默认 TTL 365 天，userId 固定 666666', async () => {
    const ctx = await buildModule(undefined);
    try {
      const token = await ctx.provider.createAPIToken('spec-api-token');
      const payload = b64urlDecode(token.split('.')[1]);
      expect(payload.sub).toBe(0);
      expect(payload.username).toBe('spec-api-token');
      expect(payload.role).toBe('admin');
      expect(Number(payload.exp) - Number(payload.iat)).toBe(3600 * 24 * 365);
      expect(ctx.created[0]).toMatchObject({ userId: 666666, name: 'spec-api-token' });
      expect(ctx.jwt.verify(token).role).toBe('admin');
    } finally {
      await ctx.moduleRef.close();
    }
  });

  it('换一把密钥就验不过（证明 secret 真的生效，而不是"随便什么都能过"）', async () => {
    const ctx = await buildModule(undefined);
    try {
      const token = await ctx.provider.createToken({ sub: 0, username: 'spec-admin' });
      const other = await Test.createTestingModule({
        imports: [JwtModule.register({ secret: 'a-completely-different-secret' })],
      }).compile();
      try {
        expect(() => other.get(JwtService).verify(token)).toThrow();
      } finally {
        await other.close();
      }
      // 篡改 payload 也验不过
      const parts = token.split('.');
      const tampered = [
        parts[0],
        Buffer.from(JSON.stringify({ ...b64urlDecode(parts[1]), role: 'admin' })).toString('base64url'),
        parts[2],
      ].join('.');
      expect(() => ctx.jwt.verify(tampered)).toThrow();
    } finally {
      await ctx.moduleRef.close();
    }
  });
});
