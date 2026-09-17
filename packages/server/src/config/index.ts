import * as path from 'path';
import { loadConfig } from 'src/utils/loadConfig';

export interface Config {
  mongoUrl: string;
  staticPath: string;
  codeRunnerPath: string;
  pluginRunnerPath: string;
  walineDB: string;
  demo: boolean | string;
  log: string;
  /** Nest listen host. Empty = all interfaces (same as `app.listen(3000)`). */
  serverHost: string;
  /**
   * 整站备份归档目录。默认 `<log>/vanblog-backups`（Docker 里 /var/log 是映射卷，能持久化）。
   * **故意不放在 staticPath 里**：静态目录会被 web 层直接服务出去，而备份含密码哈希、jwt 密钥。
   */
  backupPath: string;
  /**
   * caddy 的数据目录（TLS 证书与私钥）。默认 `/root/.local/share/caddy`，
   * 与 Dockerfile 里 `VOLUME /root/.local/share/caddy` 声明的是同一个目录。
   *
   * 只有整站备份的**可选项** `VANBLOG_BACKUP_INCLUDE_CADDY`（默认关）会用到它：
   * 打开后归档里多一段 `./caddy`，恢复时写回这里。
   * ⚠️ 另一个卷 `/root/.config/caddy` 是 caddy 的**配置**（由 `scripts/start.js`
   * 按模板生成，可离线重造），故意不备份 —— 证书才是唯一"离线造不出来"的那部分。
   */
  caddyDataPath: string;
}

export const loadMongoUrl = () => {
  return loadConfig('database.url', () => {
    const db = {
      host: loadConfig('database.host', 'mongo'),
      port: loadConfig('database.port', '27017'),
      user: loadConfig('database.user', ''),
      passwd: loadConfig('database.passwd', ''),
      name: loadConfig('database.name', 'vanBlog'),
    };

    let authInfo = '';
    if (db.user !== '' && db.passwd === '') authInfo = `${db.user}@`;
    if (db.user !== '' && db.passwd !== '') authInfo = `${db.user}:${db.passwd}@`;

    return `mongodb://${authInfo}${db.host}:${db.port}/${db.name}?authSource=admin`;
  });
};

export const config: Config = {
  mongoUrl: loadMongoUrl(),
  staticPath: loadConfig('static.path', '/app/static'),
  demo: loadConfig('demo', false),
  walineDB: loadConfig('waline.db', 'waline'),
  log: loadConfig('log', '/var/log'),
  codeRunnerPath: loadConfig('codeRunner.path', '/app/codeRunner'),
  pluginRunnerPath: loadConfig('pluginRunner.path', '/app/pluginRunner'),
  serverHost: loadConfig('server.host', ''),
  backupPath: loadConfig('backup.path', ''),
  // env 名：VAN_BLOG_CADDY_DATA_PATH（loadConfig 把 'caddy.data.path' 拼成它）
  caddyDataPath: loadConfig('caddy.data.path', '/root/.local/share/caddy'),
};

if (!config.backupPath) {
  config.backupPath = path.join(config.log || '/var/log', 'vanblog-backups');
}
