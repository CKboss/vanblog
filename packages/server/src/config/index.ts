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
};

if (!config.backupPath) {
  config.backupPath = path.join(config.log || '/var/log', 'vanblog-backups');
}
