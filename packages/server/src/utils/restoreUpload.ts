import * as fs from 'fs';
import * as path from 'path';
import { diskStorage } from 'multer';
import { config } from 'src/config';

/**
 * 整站备份**恢复**用的 multer 上传选项（落盘存储 + 8GB 上限 + part 数量收紧）。
 *
 * ⚠️ 这份常量以前是 `controller/admin/backup/backup.controller.ts` 的**模块私有**变量，
 * 于是"初始化页直接上传备份恢复整站"（`POST /api/admin/init/restore`）没法复用它 ——
 * 而两条路径的限额必须**完全一致**：一边 8GB、另一边 200MB 的话，
 * 大站在初始化页就会莫名其妙地 413（而且报错信息看不出来是限额问题）。
 * 所以搬到这里，两个控制器 import 同一份。
 *
 * 为什么必须落盘：备份可能有几百 MB，multer 默认的内存存储会把整个归档读进堆
 * （而且 `file.path` 为空，`restoreFullBackup` 需要一个真实路径）。
 * 装饰器在类实例化之前求值，所以它必须是模块级常量。
 */
export const RESTORE_UPLOAD_OPTIONS = {
  storage: diskStorage({
    destination: (_req: any, _file: any, cb: (err: Error | null, dir?: string) => void) => {
      try {
        // 不能放在 staticPath 下面：<static>/tmp/ 是匿名可下载的，而这里暂存的
        // 是整站备份（含密码哈希与 jwt 密钥）。放到备份目录（不在静态目录内）。
        const dir = path.join(config.backupPath, 'upload-tmp');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err as Error);
      }
    },
    filename: (_req: any, file: any, cb: (err: Error | null, name?: string) => void) => {
      const matched = String(file?.originalname || '').match(/\.(tar\.(zst|xz|gz)|tgz)$/i);
      cb(
        null,
        `restore-upload-${Date.now()}-${Math.round(Math.random() * 1e6)}${
          matched ? matched[0] : '.tar'
        }`,
      );
    },
  }),
  // fileSize 放宽到 8GB 是因为整站备份（含图床）可能很大；但**其它维度必须收紧**：
  // multer 的主要 DoS 面是"不限数量的 parts/fields/files"，一个恶意 multipart
  // 请求能用几十万个空 part 把事件循环和内存打满。
  // ⚠️ 后台那条恢复接口在 AdminGuard 后面，而 `/api/admin/init/restore` 是**匿名可达**的
  // （只在"站点还没初始化"时开放），所以那边另外有三道闸：
  // 全局/初始化限流（每 IP 10 分钟 5 次）、`checkHasInited()`、以及单飞互斥量。
  limits: {
    fileSize: 8 * 1024 * 1024 * 1024,
    files: 1,
    fields: 8,
    parts: 32,
    headerPairs: 64,
  },
};
