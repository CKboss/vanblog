import { Injectable } from '@nestjs/common';

@Injectable()
export class CacheProvider {
  data: Record<string, any> = {};

  /**
   * ⚠️ **键缺失时返回 `{}` 而不是 `undefined`** —— 这是历史行为，`login.guard.ts` 的
   * 防爆破窗口逻辑依赖它（拿到空对象后按"没有字段"处理），所以不改。
   *
   * 但它对**任何拿返回值做相等比较**的调用方都是陷阱：`"[object Object]" != {}` 在 JS 里是
   * **false**（对象先转原始值），于是"缓存里没有密钥"会变成"密钥校验通过"。
   * `/api/admin/auth/restore` 曾经就是这样被匿名绕过的（详见
   * `init.provider.ts` 的 `getRestoreKeyForVerification` 注释）。
   *
   * ⇒ 要取字符串类的值（密钥、令牌、路径…）请用下面的 `getString()`，它会做类型与长度校验，
   *   拿不到就返回 `null`，让调用方**失败关闭**。
   */
  get(key: string) {
    return this.data?.[key] || {};
  }

  /**
   * 取一个字符串值；不是字符串、或长度不足 `minLength` 时返回 `null`（不返回 `{}`、不返回空串）。
   * 用途：凭据/密钥类比较。`null` 的语义是"没有这个值"，调用方必须拒绝请求而不是继续比。
   */
  getString(key: string, minLength = 32): string | null {
    const v = this.data?.[key];
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    if (trimmed.length < minLength) return null;
    return trimmed;
  }

  set(key: string, value: any) {
    this.data[key] = value;
  }
}
