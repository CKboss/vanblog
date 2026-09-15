import { loadMongoUrl } from 'src/config';
import { MongoClient } from 'mongodb';
import { makeSalt } from './crypto';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 读（或第一次生成）后台会话用的 jwt 密钥。
 *
 * ⚠️ 这个函数在启动时会被调用**两次**：一次来自 `main.ts`（要塞进 `global.jwtSecret`，
 * 而它必须早于 NestFactory.create），一次来自 `app.module.ts` 里 `JwtModule.registerAsync`
 * 的工厂。以前两次各建一个 `MongoClient`、连上、查一行、**然后都不 close** ——
 * 每个泄漏的 client 都带着自己的连接池与 SDAM 心跳定时器（serverSelection/monitoring），
 * 白白占着 fd、内存和一份每 10 秒一次的 hello 轮询。
 *
 * 现在：结果按 Promise 记忆化（两次调用只会真的连一次），且用完 `finally` 里关掉 client。
 * 失败时把记忆清掉，让下一次调用还能重试（否则一次网络抖动就把整个启动钉死在同一个
 * rejected promise 上）。
 */
let cached: Promise<string> | null = null;

export const initJwt = (): Promise<string> => {
  if (!cached) {
    cached = readOrCreateJwtSecret().catch((err) => {
      cached = null;
      throw err;
    });
  } else {
    // eslint-disable-next-line no-console
    console.log('[initJwt] 复用已读取的 jwt 密钥（不再新建 MongoClient）');
  }
  return cached;
};

const readOrCreateJwtSecret = async (): Promise<string> => {
  const mongoUrl = await loadMongoUrl();
  // eslint-disable-next-line no-console
  console.log('[initJwt] 连接 MongoDB 读取 jwt 密钥');
  const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 10000 });
  // ⚠️ 这是 server 启动后**第一次**碰数据库，而且发生在 unhandledRejection 兜底装上之前。
  // compose 的 depends_on 只保证"先启动 mongo 容器"，不保证 mongod 已经能接受连接
  // （首次初始化数据目录、慢磁盘都要几秒到几十秒）。以前这里只连一次，连不上就抛出
  // 未捕获的 rejection → 进程退出 → 容器 restart → 再退出，用户看到的是崩溃循环。
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await client.connect();
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 10) {
        // eslint-disable-next-line no-console
        console.log(
          `[initJwt] 第 ${attempt} 次连接 MongoDB 失败（${(err as Error)?.message}），3 秒后重试`,
        );
        await sleep(3000);
      }
    }
  }
  if (lastError) {
    throw lastError;
  }
  try {
    const db = client.db();
    const collection = db.collection('settings');
    // ⚠️ 必须是**原子**的 upsert，不能"先 findOne、没有就 insertOne"：
    // 两个 server 进程同时启动（cluster 的多个 worker、或者 watch 重启留下的孤儿进程，
    // AGENTS §7.38.3 里实测到过两个进程同时在跑）会各自生成一个 secret 并各插一行，
    // 于是不同进程用不同密钥签 token —— 后台会话随机失效，而且极难复现。
    // `settings.type` 上有唯一索引（type_1），所以 $setOnInsert + upsert 天然互斥。
    const secret = makeSalt();
    try {
      const doc = await collection.findOneAndUpdate(
        { type: 'jwt' },
        { $setOnInsert: { type: 'jwt', value: { secret } } },
        { upsert: true, returnDocument: 'after' },
      );
      const existing = (doc?.value ?? doc) as any;
      if (existing?.value?.secret) {
        return existing.value.secret;
      }
    } catch (err) {
      // 全新库上唯一索引可能还没建好（mongoose 的 autoIndex 在 Nest 启动时才跑），
      // 撞车了就退回读一遍：谁先写进去就用谁的
      if ((err as any)?.code !== 11000) throw err;
    }
    const fallback = await collection.findOne({ type: 'jwt' });
    if (fallback?.value?.secret) {
      return fallback.value.secret;
    }
    return secret;
  } finally {
    // ⚠️ 一定要关：不关就漏一个 MongoClient（连接池 + SDAM 定时器）
    await client.close().catch((err) => {
      // eslint-disable-next-line no-console
      console.log(`[initJwt] 关闭 MongoDB 连接失败：${(err as Error)?.message || err}`);
    });
  }
};
