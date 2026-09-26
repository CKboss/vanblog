const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const repoRoot = path.join(adminRoot, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('整站备份：后台页面', () => {
  it('备份恢复页有两块：整站备份 + 原来的 JSON 导入导出', () => {
    const page = read('src/pages/SystemConfig/tabs/Backup.jsx');
    assert.match(page, /整站备份与恢复/);
    assert.match(page, /数据备份（仅数据库记录，JSON）/);
    assert.match(page, /导出整站备份/);
    assert.match(page, /上传备份并恢复/);
    assert.match(page, /刷新列表/);
    // 老的 JSON 导入导出没被弄丢
    assert.match(page, /导入全部数据/);
    assert.match(page, /导出全部数据/);
    assert.match(page, /\/api\/admin\/backup\/import/);
  });

  it('可以选压缩格式，并只列出本机可用的', () => {
    const page = read('src/pages/SystemConfig/tabs/Backup.jsx');
    assert.match(page, /getFullBackupFormats/);
    assert.match(page, /available\.includes\(item\)/);
    assert.match(page, /zstd -19 --long/);
    assert.match(page, /xz -9e/);
    assert.match(page, /gzip -9/);
  });

  it('列表给出体积/格式/内容/时间，并能下载、看清单、恢复、删除', () => {
    const page = read('src/pages/SystemConfig/tabs/Backup.jsx');
    for (const title of ['备份文件', '体积', '格式', '内容', '生成时间', '操作']) {
      // 🔴 期 6 第六批起列标题走 t() ⇒ 锚点从 `title: '中文'` 换成 `title: t('<key>', '中文')`
      //    （性质没放：仍然要求这一列存在、且标题就是这句中文）
      assert.match(page, new RegExp(`title: t\\('[^']+', '${title}'\\)`), `列表缺少列 ${title}`);
    }
    assert.match(page, /handleDownload/);
    assert.match(page, /handleInspect/);
    assert.match(page, /handleRestore/);
    assert.match(page, /handleDelete/);
    // 下载要带 token，所以走 blob 而不是 <a href>
    assert.match(page, /downloadFullBackup/);
    assert.match(page, /URL\.createObjectURL/);
  });

  it('恢复前明确告知会覆盖且需要重新登录', () => {
    const page = read('src/pages/SystemConfig/tabs/Backup.jsx');
    assert.match(page, /确定用这个备份覆盖当前站点吗/);
    assert.match(page, /当前数据会被替换且不可撤销/);
    assert.match(page, /重新登录/);
    assert.match(page, /waline 评论库/);
    // 上传恢复必须带 confirm，否则服务端会拒
    assert.match(page, /data=\{\{ confirm: 'true' \}\}/);
    assert.match(page, /action="\/api\/admin\/backup\/full\/restore"/);
    assert.match(page, /tokenHeader\(\)/);
  });

  it('API 封装对上服务端路由', () => {
    const api = read('src/services/van-blog/api.js');
    const pairs = [
      ['getFullBackupFormats', '/api/admin/backup/full/formats'],
      ['exportFullBackup', '/api/admin/backup/full/export'],
      ['listFullBackups', '/api/admin/backup/full/list'],
      ['inspectFullBackup', '/api/admin/backup/full/inspect'],
      ['restoreFullBackup', '/api/admin/backup/full/restore'],
      ['deleteFullBackup', '/api/admin/backup/full/delete'],
      ['downloadFullBackup', '/api/admin/backup/full/download'],
    ];
    for (const [fn, url] of pairs) {
      assert.match(api, new RegExp(`export async function ${fn}`), `缺少 ${fn}`);
      assert.ok(api.includes(url), `api.js 里找不到 ${url}`);
    }
    // 打包/恢复可能几分钟，别被默认超时掐掉；下载是二进制
    assert.match(api, /timeout: 30 \* 60 \* 1000/);
    assert.match(api, /responseType: 'blob'/);
    assert.match(api, /confirm: 'true'/);
  });
});

describe('整站备份：服务端', () => {
  it('只备份该备份的静态目录，归档不落在静态目录下', () => {
    const util = readRepo('packages/server/src/utils/fullBackup.ts');
    // ⚠️ 这条以前钉的是字面量 `['img', 'file', 'customPage']`，于是新增 `themes/`
    // （后台上传的主题 CSS 就存在那儿）时没人想起来改它 —— 主题文件从此不进归档，
    // 而主题的**元数据**在 settings 集合里照样恢复：结果是"恢复成功、后台显示主题还在、
    // `/api/public/theme.css` 却 404"的**静默数据丢失**。所以改成按语义分类断言：
    // 用户数据目录必须全在清单里，派生/临时目录必须不在 —— 加新目录时这条会自动逼你想清楚。
    const m = /BACKUP_STATIC_FOLDERS = \[([^\]]*)\]/.exec(util);
    assert.ok(m, '找不到 BACKUP_STATIC_FOLDERS');
    const folders = m[1]
      .split(',')
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    for (const need of ['img', 'file', 'customPage', 'themes']) {
      assert.ok(
        folders.includes(need),
        `用户数据目录 ${need} 不在整站备份清单里 —— 恢复后会静默丢文件（themes 就是这么丢过一次）`,
      );
    }
    for (const banned of ['export', 'tmp', 'upload-tmp', 'rss', 'sitemap']) {
      // rss/sitemap 启动时会重新生成，tmp/upload-tmp 是暂存，export 是旧的匿名下载目录（已 403）
      assert.ok(!folders.includes(banned), `${banned} 是派生或临时目录，不该进归档`);
    }

    const config = readRepo('packages/server/src/config/index.ts');
    assert.match(config, /backupPath: string;/);
    assert.match(config, /loadConfig\('backup\.path'/);
    assert.match(config, /vanblog-backups/);
    // 默认放在日志目录下，而不是 staticPath 里
    assert.match(config, /path\.join\(config\.log \|\| '\/var\/log', 'vanblog-backups'\)/);
  });

  it('压缩器优先级是 zstd > xz > gzip，且按扩展名和魔数识别', () => {
    const util = readRepo('packages/server/src/utils/fullBackup.ts');
    assert.match(util, /'--long=27'/);
    assert.match(util, /'-9e'/);
    assert.match(util, /'-9'/);
    assert.match(util, /export function detectFormat/);
    assert.match(util, /0x28 && head\[1\] === 0xb5/);
    assert.match(util, /VANBLOG_BACKUP_ZSTD_LEVEL/);
  });

  it('恢复是「临时集合 + 原子替换 + 重建索引」', () => {
    const util = readRepo('packages/server/src/utils/fullBackup.ts');
    assert.match(util, /RESTORE_SUFFIX = '__vanblog_restore'/);
    assert.match(util, /tmp\.rename\(name, \{ dropTarget: true \}\)/);
    assert.match(util, /createIndex\(index\.key, options\)/);
    // _id_ 索引由 Mongo 自己建，跳过；其余按备份里的定义重建
    assert.match(util, /index\.name === '_id_'/);
    // 导出时不要把上次失败留下的临时集合也打进去
    assert.match(util, /name\.endsWith\(RESTORE_SUFFIX\)/);
    // 静态文件用硬链接进暂存目录，不额外占空间。
    // ⚠️ 源必须是**解析过符号链接的真实路径**：图床是软链时 `cp -al static/img stage/static/img`
    //    产出的归档里只有一个软链成员、零字节图片 ⇒ 写后校验必然失败
    //    （表现为"图床是软链的站点根本备份不了"），而恢复侧一律拒绝软链成员。
    assert.match(util, /fs\.realpathSync\(src\)/);
    assert.match(util, /spawnSync\('cp', \['-al', realSrc, dst\]/);
    // 硬链接失败（跨文件系统）要退化成真实拷贝，不能让整个备份失败
    assert.match(util, /fs\.cpSync\(realSrc, dst, \{ recursive: true/);
  });

  it('数据库导出用 NDJSON + 扩展 JSON，BSON 类型能往返', () => {
    const codec = readRepo('packages/server/src/utils/backupCodec.ts');
    assert.match(codec, /\$oid/);
    assert.match(codec, /\$date/);
    assert.match(codec, /\$binary/);
    assert.match(codec, /\$numberDecimal/);
    assert.match(codec, /_bsontype/);
    assert.match(codec, /export function encodeNdjson/);
    assert.match(codec, /NOT_EXTENDED_JSON/);
    assert.match(codec, /BACKUP_KIND = 'vanblog-full-backup'/);
  });

  it('接口有 confirm 保护、演示站拦截、路径穿越防护和大文件落盘', () => {
    const controller = readRepo('packages/server/src/controller/admin/backup/backup.controller.ts');
    // ⚠️ 这条锚点**升级过**（不是放宽）：以前钉的是 `checkTrue(body?.confirm)`，而 `checkTrue`
    //    的旧实现含 `s == true` 松散比较 ⇒ `confirm:"1"`、`confirm:1`、`confirm:[1]` 都算
    //    "站长已确认" —— 全仓库**最该严格**的一处判定，用的却是**最松**的一套布尔口径。
    //    现在闸门点名 `isTrue`（只认 boolean true 与字符串 'true'），所以锚点改成钉"严格口径"本身：
    //    既要证明用的是 isTrue，也要证明没有退回"只看 truthy"的宽松判定。
    assert.match(controller, /if \(!isTrue\(body\?\.confirm\)\) \{/);
    assert.doesNotMatch(controller, /if \(!body\?\.confirm\) \{/);
    assert.doesNotMatch(controller, /checkTrue\(body\?\.confirm\)/);
    // 负向对照：证明上面两把"不许有"的尺子不是恒真（尺子量得到坏形状，才有资格说"没有坏形状"）
    assert.match('if (!body?.confirm) {', /if \(!body\?\.confirm\) \{/);
    assert.match('if (!checkTrue(body?.confirm)) {', /checkTrue\(body\?\.confirm\)/);
    assert.doesNotMatch('if (!isTrue(body?.confirm)) {', /checkTrue\(body\?\.confirm\)/);
    assert.match(controller, /演示站禁止修改此项/);
    assert.match(controller, /RESTORE_UPLOAD_OPTIONS/);
    // 上传选项（落盘 + 8GB + parts 收紧）从控制器私有搬进了共享模块
    // `utils/restoreUpload.ts`，让「init 页直接上传恢复」复用同一份 ——
    // 两条恢复路径的限额必须完全一致（一边 8GB 一边 200MB 的话，大站会在
    // init 页莫名其妙 413）。所以对着**定义处**断言，并钉住两个控制器都 import 它。
    const upload = readRepo('packages/server/src/utils/restoreUpload.ts');
    assert.match(upload, /diskStorage/);
    assert.match(upload, /fileSize: 8 \* 1024 \* 1024 \* 1024/);
    assert.match(upload, /files: 1/);
    assert.match(upload, /parts: 32/);
    const initController = readRepo('packages/server/src/controller/admin/init/init.controller.ts');
    const sharedImport = /import \{ RESTORE_UPLOAD_OPTIONS \} from 'src\/utils\/restoreUpload'/;
    assert.match(controller, sharedImport);
    assert.match(initController, sharedImport);
    // 上传的临时文件必须删掉
    assert.match(controller, /fs\.rmSync\(archivePath, \{ force: true \}\)/);
    // 老的 JSON 导出以前把 temp.json 写在 cwd 且成功后不删
    assert.match(controller, /os\.tmpdir\(\)/);
    assert.match(controller, /fs\.rmSync\(tmpFile, \{ force: true \}\)/);
    assert.doesNotMatch(controller, /const name = `temp\.json`/);

    const provider = readRepo('packages/server/src/provider/backup/fullBackup.provider.ts');
    assert.match(provider, /path\.basename\(String\(name \|\| ''\)\)/);
    assert.match(provider, /startsWith\('vanblog-full-'\)/);
    assert.match(provider, /备份文件名不合法/);
    assert.match(provider, /connection\.getClient\(\)/);
    assert.match(provider, /config\.walineDB/);
  });

  it('备份目录即使在静态目录下也拦掉匿名访问', () => {
    const main = readRepo('packages/server/src/main.ts');
    const guard = readRepo('packages/server/src/utils/staticGuard.ts');
    // 判定走共享的 staticGuard（不是在中间件里比字面前缀）
    assert.match(main, /isGuardedStaticPath\(req\.path, backupSegment\)/);
    assert.match(main, /backupFirstSegmentUnderStatic\(/);
    assert.match(main, /statusCode = 403/);
    // 匿名一律 403 的静态子目录：导出归档 + 上传/导出/整站恢复的临时目录
    // （tmp 里可能是恢复暂存的 NDJSON —— 含密码哈希与 jwt 密钥）
    assert.match(guard, /GUARDED_STATIC_SEGMENTS = new Set\(\['export', 'tmp', 'upload-tmp'\]\)/);
    // 按"解码 + 合并重复斜杠 + posix 归一化"之后的**第一个路径段**判定
    assert.match(guard, /decodeURIComponent\(p\)/);
    assert.match(guard, /path\.posix\.normalize\(p\)/);
    // 归一化后逃出 /static/ 的写法（%2e%2e 之类）也按受控处理，不把判断权交给 serve-static
    assert.match(guard, /export const ESCAPED/);
    // ⚠️ 反证：不许退回字面前缀比较。`req.path` 是未解码、未归一化的原始路径，
    //    而 serve-static 打开文件前会解码归一化 ⇒ `%65xport` / `export%2f` / `./export` /
    //    `//export` 全能绕过（活体验证过：早先那次"已修"其实是装饰性的）
    assert.doesNotMatch(main, /req\.path\.startsWith\(['"`]\/static\/export\//);
    assert.doesNotMatch(main, /req\.url\.startsWith\(['"`]\/static\/export\//);
  });
});

describe('整站备份：文档', () => {
  it('写清了包含什么、压缩格式、存放位置与恢复注意事项', () => {
    const doc = readRepo('docs/advanced/backup.md');
    assert.match(doc, /## 整站备份（推荐）/);
    assert.match(doc, /waline 评论库/);
    assert.match(doc, /zstd -19 --long=27 -T0/);
    assert.match(doc, /\`<日志目录>\/vanblog-backups\`/);
    assert.match(doc, /VAN_BLOG_BACKUP_PATH/);
    assert.match(doc, /恢复会覆盖当前站点/);
    assert.match(doc, /需要重新登录/);
    assert.match(doc, /__vanblog_restore/);
    // 这一节的标题改过：现在讲的是「后台 / 一键脚本 / 目录快照」三者怎么选
    assert.match(doc, /三种备份怎么选|与一键脚本备份的区别/);
    // 体积实测数据留着，方便别人判断该选哪个格式
    assert.match(doc, /65\.91 MB/);

    const guide = readRepo('docs/guide/backup.md');
    assert.match(guide, /后台整站备份/);
    assert.match(guide, /上传备份并恢复/);

    const dir = readRepo('docs/reference/dir.md');
    assert.match(dir, /vanblog-backups/);
  });
});
