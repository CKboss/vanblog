import { consumeAttempt, resetAttempts } from './attemptLimit';

describe('attemptLimit（加密文章解锁的防爆破）', () => {
  it('窗口内超过次数就拒绝，并给出还要等多久', () => {
    const key = `t1-${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      expect(consumeAttempt(key, { max: 3, windowMs: 60000 }).allowed).toBe(true);
    }
    const blocked = consumeAttempt(key, { max: 3, windowMs: 60000 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('成功后 reset 就能继续（正常用户不会被自己锁住）', () => {
    const key = `t2-${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      consumeAttempt(key, { max: 3, windowMs: 60000 });
    }
    expect(consumeAttempt(key, { max: 3, windowMs: 60000 }).allowed).toBe(false);
    resetAttempts(key);
    expect(consumeAttempt(key, { max: 3, windowMs: 60000 }).allowed).toBe(true);
  });

  it('窗口过期后自动放行', async () => {
    const key = `t3-${Date.now()}`;
    for (let i = 0; i < 2; i += 1) {
      consumeAttempt(key, { max: 2, windowMs: 20 });
    }
    expect(consumeAttempt(key, { max: 2, windowMs: 20 }).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(consumeAttempt(key, { max: 2, windowMs: 20 }).allowed).toBe(true);
  });

  it('不同 key 互不影响', () => {
    const stamp = Date.now();
    for (let i = 0; i < 5; i += 1) {
      consumeAttempt(`a-${stamp}`, { max: 5, windowMs: 60000 });
    }
    expect(consumeAttempt(`a-${stamp}`, { max: 5, windowMs: 60000 }).allowed).toBe(false);
    expect(consumeAttempt(`b-${stamp}`, { max: 5, windowMs: 60000 }).allowed).toBe(true);
  });
});
