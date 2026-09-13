import { loadMongoUrl } from 'src/config';
import { MongoClient } from 'mongodb';
import { makeSalt } from './crypto';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const initJwt = async () => {
  const mongoUrl = await loadMongoUrl();
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
  const db = client.db();
  const collection = db.collection('settings');
  const jwtSetting = await collection.findOne({ type: 'jwt' });
  if (jwtSetting) {
    return jwtSetting.value.secret;
  } else {
    const secret = makeSalt();
    await collection.insertOne({ type: 'jwt', value: { secret } });
    return secret;
  }
};
