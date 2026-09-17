const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '../../../..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('安全加固：注入与输入校验', () => {
  it('全局净化中间件会剥掉 $ 操作符键与原型污染键，并在 main.ts 注册', () => {
    const util = read('packages/server/src/utils/sanitizeRequest.ts');
    assert.match(util, /FORBIDDEN_KEY = \/\^\(\\\$\|__proto__\$|\^constructor\$\|\^prototype\$\)/);
    assert.match(util, /export function stripOperatorKeys/);
    assert.match(util, /export function asQueryString/);
    const main = read('packages/server/src/main.ts');
    assert.match(main, /app\.use\(sanitizeRequestPayloads\)/);
  });

  it('所有用户输入进 $regex 前都要转义 + 限长（否则 `(` 直接 500，`(a+)+b` 可 ReDoS）', () => {
    const article = read('packages/server/src/provider/article/article.provider.ts');
    const draft = read('packages/server/src/provider/draft/draft.provider.ts');
    assert.match(article, /export function safeSearchPattern|safeSearchPattern\(/);
    assert.doesNotMatch(article, /\$regex: `\$\{str\}`/);
    assert.doesNotMatch(article, /\$regex: link,/);
    assert.doesNotMatch(draft, /\$regex: `\*\$\{str\}\*`/);
    assert.match(read('packages/server/src/utils/regex.ts'), /MAX_SEARCH_INPUT = 200/);
    // 搜索还加了时间上限，合法但昂贵的正则也不能拖死库
    assert.match(article, /maxTimeMS\(SEARCH_MAX_TIME_MS\)/);
  });

  it('搜索的后置过滤对缺失字段安全（category 可能不存在，以前会 TypeError → 公开搜索 500）', () => {
    const article = read('packages/server/src/provider/article/article.provider.ts');
    assert.match(article, /const text = \(value: unknown\) => String\(value \?\? ''\)/);
    assert.doesNotMatch(article, /each\.category\.toLocaleLowerCase\(\)/);
  });
});

describe('安全加固：SSRF', () => {
  it('远程抓取逐跳重新校验，不用 axios 的自动重定向', () => {
    const safe = read('packages/server/src/utils/safeFetch.ts');
    assert.match(safe, /maxRedirects: 0/);
    assert.match(safe, /current = await assertSafeRemoteUrl\(next\.toString\(\)\)/);
    assert.match(safe, /export function assertImageBuffer/);
  });

  it('导出与「转移外链图片」都走这套安全抓取，且要求内容真的是图片', () => {
    const exp = read('packages/server/src/provider/export/markdownExport.provider.ts');
    assert.match(exp, /fetchRemoteSafely\(/);
    assert.match(exp, /assertImageBuffer\(/);
    assert.doesNotMatch(exp, /maxRedirects: 3,\n\s+maxContentLength/);
    const stat = read('packages/server/src/provider/static/static.provider.ts');
    assert.match(stat, /fetchRemoteSafely\(/);
    assert.match(stat, /assertImageBuffer\(/);
    assert.match(stat, /MAX_REMOTE_IMAGE_BYTES/);
  });
});

describe('安全加固：上传与静态文件', () => {
  it('图片上传按内容校验，SVG / 非图片一律拒（否则同源 text/html = 存储型 XSS）', () => {
    const stat = read('packages/server/src/provider/static/static.provider.ts');
    assert.match(stat, /assertUploadedImage\(buffer, originalName\)/);
    assert.match(stat, /safeImageExtension\(fileType, verified\.type\)/);
    const limits = read('packages/server/src/utils/uploadLimits.ts');
    assert.match(limits, /不支持的图片类型/);
    assert.match(limits, /MAX_IMAGE_PIXELS/);
    const allowed = limits.match(/ALLOWED_IMAGE_TYPES = \[([\s\S]*?)\] as const/)[1];
    assert.doesNotMatch(allowed, /'svg'/);
  });

  it('每个上传接口都有体积上限', () => {
    const img = read('packages/server/src/controller/admin/img/img.controller.ts');
    assert.equal(img.match(/FileInterceptor\('file', IMAGE_UPLOAD_OPTIONS\)/g).length, 3);
    assert.match(
      read('packages/server/src/controller/admin/customPage/customPage.controller.ts'),
      /CUSTOM_PAGE_UPLOAD_OPTIONS/,
    );
    assert.match(
      read('packages/server/src/controller/admin/backup/backup.controller.ts'),
      /JSON_IMPORT_UPLOAD_OPTIONS/,
    );
  });

  it('整个静态目录都带 nosniff，可执行文本类型一律强制下载', () => {
    const headers = read('packages/server/src/utils/imgCompress.ts');
    assert.match(headers, /setHeader\('X-Content-Type-Options', 'nosniff'\)/);
    assert.match(headers, /isDangerousInlinePath\(filePath\)/);
  });

  it('导出归档不再放静态目录，下载走鉴权接口', () => {
    const local = read('packages/server/src/provider/static/local.provider.ts');
    assert.match(local, /config\.backupPath, 'export'/);
    assert.doesNotMatch(local, /`\/static\/export\//);
    const exp = read('packages/server/src/controller/admin/export/export.controller.ts');
    assert.match(exp, /@Get\('archive'\)/);
    assert.match(exp, /base !== path\.basename\(base\)/);
    // 旧的 <static>/export/ 兜底现在走共享守卫（比字面前缀更严：req.path 未解码未归一化，
    // `%65xport` / `export%2f` / `./export` 都能绕过字面前缀 —— 详见 staticGuard.ts）
    const main = read('packages/server/src/main.ts');
    assert.match(main, /isGuardedStaticPath\(req\.path, backupSegment\)/);
    assert.match(read('packages/server/src/utils/staticGuard.ts'), /'export', 'tmp', 'upload-tmp'/);
    assert.match(read('packages/admin/src/services/van-blog/downloadArchive.ts'), /downloadExportArchive/);
  });

  it('cwebp 的临时文件用随机目录 + finally 清理（以前失败就把整块 buffer 永久留在 /tmp）', () => {
    const webp = read('packages/server/src/utils/webp.ts');
    assert.match(webp, /mkdtempSync\(join\(tmpdir\(\), 'vanblog-webp-'\)\)/);
    assert.match(webp, /\} finally \{/);
    assert.match(webp, /rmSync\(dir, \{ recursive: true, force: true \}\)/);
  });
});

describe('安全加固：认证与权限', () => {
  it('登录限流只统计失败、用套接字地址、阈值来自设置、默认开启', () => {
    const guard = read('packages/server/src/provider/auth/login.guard.ts');
    assert.match(guard, /pickSocketIp/);
    // 只允许从 log/utils 引入 pickSocketIp（注释里提到 pickClientIp 不算）
    assert.match(guard, /import \{ pickSocketIp \} from '\.\.\/log\/utils'/);
    assert.doesNotMatch(guard, /import \{[^}]*pickClientIp[^}]*\} from/);
    assert.match(guard, /export async function|async recordFailure/);
    assert.match(guard, /setting\.enableMaxLoginRetry !== false/);
    assert.match(guard, /DEFAULT_MAX_LOGIN_RETRY/);
    const controller = read('packages/server/src/controller/admin/auth/auth.controller.ts');
    assert.match(controller, /await this\.loginGuard\.recordFailure\(request\)/);
    assert.match(controller, /await this\.loginGuard\.reset\(request\)/);
  });

  it('权限判定失败要关门（以前 !user 和 catch 都 return true）', () => {
    const guard = read('packages/server/src/provider/access/access.guard.ts');
    assert.doesNotMatch(guard, /\n\s*return true;\s*\n\s*\}\s*\n\s*if \(user\.id == 0\)/);
    assert.match(guard, /判定过程出错时也要关门[\s\S]{0,120}return false;/);
  });

  it('改密码/建协作者都要校验空值，且只写白名单字段', () => {
    const user = read('packages/server/src/provider/user/user.provider.ts');
    assert.match(user, /密码不合法/);
    assert.doesNotMatch(user, /\.\.\.updateUserDto,\n\s*password:/);
    assert.doesNotMatch(user, /type: 'collaborator',\n\s*\.\.\.collaboratorDto/);
    // 口令校验走统一入口：scrypt（新）与 sha256（旧）都认，登录成功后自动升级
    assert.match(user, /verifyUserPassword\(user\.password, name, password, user\.salt\)/);
    assert.match(user, /hashSecret\(passwordInput\)/);
    // 不再「算出哈希再去 Mongo 里查」——那样只能支持一种存储格式
    assert.doesNotMatch(user, /findOne\(\{ name, password: encrypted \}\)/);
    // 空口令一律拒绝（空哈希曾经等于空密码可登录）
    assert.match(user, /typeof password !== 'string' \|\| !password/);
    assert.match(user, /pickPermissions/);
  });

  it('协作者看不到分类加密密码；caddy on-demand TLS 只认本站域名', () => {
    assert.match(
      read('packages/server/src/controller/admin/category/category.controller.ts'),
      /delete plain\.password/,
    );
    const caddy = read('packages/server/src/controller/admin/caddy/caddy.controller.ts');
    assert.match(caddy, /getAllowedAskDomains/);
    assert.match(caddy, /未授权的域名/);
  });

  it('演示站禁止管线（fork 执行任意 JS）等写操作', () => {
    const pipeline = read('packages/server/src/controller/admin/pipeline/pipeline.controller.ts');
    assert.ok((pipeline.match(/演示站禁止修改此项/g) || []).length >= 4);
    for (const rel of [
      'packages/server/src/controller/admin/draft/draft.controller.ts',
      'packages/server/src/controller/admin/isr/isr.controller.ts',
      'packages/server/src/controller/admin/customPage/customPage.controller.ts',
    ]) {
      assert.match(read(rel), /config\.demo/);
    }
  });

  it('日志不再打印 JWT 密钥 / 数据库口令 / SMTP 密码；第三方 IP 查询有超时', () => {
    const waline = read('packages/server/src/provider/waline/waline.provider.ts');
    assert.match(waline, /SECRET_ENV_KEYS/);
    assert.match(waline, /'\[REDACTED\]'/);
    const logUtils = read('packages/server/src/provider/log/utils.ts');
    assert.match(logUtils, /export const IP_GEO_TIMEOUT_MS/);
    assert.match(logUtils, /timeout: IP_GEO_TIMEOUT_MS/);
    assert.match(logUtils, /VANBLOG_DISABLE_IP_GEO/);
    assert.match(logUtils, /encodeURIComponent\(ip\)/);
  });

  it('未鉴权接口不再因为缺 Referer 而 500；删除接口按类型限定且空值可读报错', () => {
    assert.match(
      read('packages/server/src/controller/public/public.controller.ts'),
      /referer 可能缺失|try \{\n\s+if \(refer\)/i,
    );
    const stat = read('packages/server/src/provider/static/static.provider.ts');
    assert.match(stat, /deleteOneBySign\(sign: string, staticType\?: string\)/);
    assert.match(stat, /找不到该文件（可能已经被删除）/);
    assert.match(stat, /getOneBySignAndType\(currentSign, 'img'\)/);
  });

  it('进程级兜底：未处理的 rejection 不再直接带走整个 server', () => {
    assert.match(read('packages/server/src/main.ts'), /process\.on\('unhandledRejection'/);
    const backup = read('packages/server/src/utils/fullBackup.ts');
    assert.match(backup, /compressor\.stdin\.on\('error'/);
    assert.match(backup, /tar\.stdin\.on\('error'/);
  });
});

describe('安全加固：口令哈希 / 限流 / 响应头 / 全量拉取', () => {
  it('口令存 scrypt，且校验兼容旧格式（否则升级会把所有人锁在门外）', () => {
    const crypto = read('packages/server/src/utils/crypto.ts');
    assert.match(crypto, /scryptSync/);
    assert.match(crypto, /timingSafeEqual/);
    assert.match(crypto, /export function verifyUserPassword/);
    assert.match(crypto, /export function verifyAccessPassword/);
    // 存储格式自描述，便于以后调参数或换 KDF
    assert.match(crypto, /scrypt\$/);
    // 参数上限：库被改过也不能构造出让进程 OOM 的哈希
    assert.match(crypto, /N > 1048576/);
    // 空口令不能被哈希成空串（空哈希曾经等于空密码可登录）
    assert.match(crypto, /if \(!value\) \{\n    return '';/);
    // 初始化管理员也走 scrypt
    assert.match(read('packages/server/src/provider/init/init.provider.ts'), /hashSecret\(user\.password\)/);
  });

  it('全局限流：分档、回环放行必须要求「无转发头」、出错放行', () => {
    const rl = read('packages/server/src/utils/rateLimit.ts');
    assert.match(rl, /VANBLOG_RATE_LIMIT_PER_MIN/);
    assert.match(rl, /VANBLOG_PUBLIC_WRITE_LIMIT_PER_MIN/);
    assert.match(rl, /VANBLOG_INIT_LIMIT_PER_10MIN/);
    assert.match(rl, /Retry-After/);
    // 只看 socket 会出事：一体式镜像里 caddy 转发来的请求 socket 全是 127.0.0.1
    assert.match(rl, /x-forwarded-for/);
    assert.match(rl, /x-real-ip/);
    // fail-open：限流组件自己出错时放行，不拿可用性换防护
    assert.match(rl, /return next\(\);\n  \}\n\}/);
    assert.match(read('packages/server/src/app.module.ts'), /securityHeadersMiddleware, rateLimitMiddleware/);
  });

  it('安全响应头下发，但没有半成品 CSP；X-Frame-Options 是 SAMEORIGIN 不是 DENY', () => {
    const rl = read('packages/server/src/utils/rateLimit.ts');
    assert.match(rl, /X-Content-Type-Options', 'nosniff'/);
    assert.match(rl, /X-Frame-Options', 'SAMEORIGIN'/);
    assert.match(rl, /Referrer-Policy/);
    assert.match(rl, /Permissions-Policy/);
    // 后台要 iframe 同源的 waline /ui，DENY 会直接白屏
    assert.doesNotMatch(rl, /X-Frame-Options', 'DENY'/);
    assert.doesNotMatch(rl, /Content-Security-Policy/);
    const caddy = read('CaddyfileTemplate');
    assert.match(caddy, /X-Content-Type-Options "nosniff"/);
    assert.doesNotMatch(caddy, /Content-Security-Policy/);
  });

  it('pageSize=-1 只给内部调用；API Token 不再是 100 年', () => {
    const pub = read('packages/server/src/controller/public/public.controller.ts');
    assert.match(pub, /const unlimited = isInternalRequest\(req\);/);
    assert.match(pub, /allowUnlimited: unlimited/);
    assert.doesNotMatch(pub, /allowUnlimited: true,/);
    const rl = read('packages/server/src/utils/rateLimit.ts');
    assert.match(rl, /VAN_BLOG_INTERNAL_TOKEN/);
    const token = read('packages/server/src/provider/token/token.provider.ts');
    assert.doesNotMatch(token, /365 \* 100/);
    assert.match(token, /VANBLOG_API_TOKEN_TTL_DAYS/);
  });

  it('没有偷偷打开 CORS（那会让任意站点带着用户 token 调后台接口）', () => {
    assert.doesNotMatch(read('packages/server/src/main.ts'), /enableCors/);
  });
});

describe('安全加固：加密内容与恢复', () => {
  it('加密文章不会通过搜索/POST 解锁接口/RSS 泄露', () => {
    const article = read('packages/server/src/provider/article/article.provider.ts');
    assert.match(article, /getPrivateCategoryNames/);
    assert.match(article, /category: \{ \$nin: privateCategories \}/);
    assert.match(article, /const isPrivate = !!article\.private \|\| categoryPrivate;/);
    // 访问密码改成常量时间比较（原来的 !== 会因短路泄露长度/前缀），且兼容历史明文与 scrypt
    assert.match(article, /verifyAccessPassword\(targetPassword, supplied\)/);
    assert.doesNotMatch(article, /String\(targetPassword\) !== supplied/);
    assert.match(read('packages/server/src/provider/rss/rss.provider.ts'), /privateCategories\.has/);
  });

  it('恢复空集合也要建临时表；失败要清临时表并给可读错误', () => {
    const backup = read('packages/server/src/utils/fullBackup.ts');
    assert.match(backup, /await db\.createCollection\(tmpName\)/);
    assert.match(backup, /await tmp\.drop\(\)/);
    assert.match(backup, /恢复集合 \$\{name\} 失败/);
    // 失败留下的半成品归档必须删掉，否则列表里会出现一个坏备份
    assert.match(backup, /fs\.rmSync\(outFile, \{ force: true \}\)/);
    assert.match(backup, /code !== 1/);
    assert.match(
      read('packages/server/src/provider/backup/fullBackup.provider.ts'),
      /private serialize<T>/,
    );
  });

  it('customPage 目录删除走统一的路径规范化（以前能 ../ 递归删到静态目录外）', () => {
    assert.match(
      read('packages/server/src/provider/static/static.provider.ts'),
      /const folderName = normalizeCustomPageRel\(path\)/,
    );
  });

  it('自定义页面接口不再吐 mongoose 内部结构，非法 path 返回 404', () => {
    const pub = read('packages/server/src/controller/public/public.controller.ts');
    assert.match(pub, /asQueryString\(path\)/);
    assert.match(pub, /name: data\?\.name/);
    assert.doesNotMatch(pub, /\.\.\.data,\n\s*html:/);
  });
});

describe('功能修复：渲染与后台交互', () => {
  it('<pre> 里没有 <code> 时不再让整篇文章 SSR 崩掉', () => {
    const code = read('packages/website/components/Markdown/codeBlock.tsx');
    assert.match(code, /if \(!codeNode\) \{/);
  });

  it('front matter 只在「每行都像 YAML」时才剥（否则会吃掉正文）', () => {
    for (const rel of [
      'packages/website/utils/frontMatter.ts',
      'packages/server/src/utils/frontMatter.ts',
    ]) {
      assert.match(read(rel), /looksLikeYaml/);
    }
  });

  it('编辑按钮用数字 id（别名会让后台打开一个空编辑器）', () => {
    assert.match(
      read('packages/website/components/PostCard/title.tsx'),
      /props\.numericId \?\? props\.id/,
    );
    for (const rel of ['pages/index.tsx', 'pages/page/[p].tsx', 'pages/post/[id].tsx']) {
      assert.match(read(`packages/website/${rel}`), /numericId=\{/);
    }
  });

  it('checkLogin 不再恒为 true（匿名访客不该看到编辑按钮）', () => {
    const auth = read('packages/website/utils/auth.ts');
    assert.doesNotMatch(auth, /return true;\n\s*if \(typeof window/);
    assert.match(auth, /localStorage\?\.getItem\("token"\)/);
  });

  it('批量删除失败不再报成功', () => {
    const batch = read('packages/admin/src/services/van-blog/batch.ts');
    assert.match(batch, /Promise\.allSettled/);
    assert.doesNotMatch(batch, /\.finally\(\(\) => \{\n\s*cnt = cnt \+ 1/);
  });

  it('标签/分类/打赏的重命名与删除都编码了名字', () => {
    const api = read('packages/admin/src/services/van-blog/api.js');
    assert.equal((api.match(/encodeQuerystring\(name\)/g) || []).length >= 4, true);
    assert.match(api, /\/api\/admin\/meta\/reward\/\$\{encodeQuerystring\(name\)\}/);
  });

  it('列表排序带唯一 tiebreaker（否则翻页会重复/漏行）', () => {
    const article = read('packages/server/src/provider/article/article.provider.ts');
    assert.match(article, /sort = \{ viewer: -1, id: -1 \}/);
    assert.match(article, /sort = \{ top: -1, id: -1 \}/);
  });

  it('图片上传文件名按 latin1 正确解码（图片这条老路径以前没修）', () => {
    assert.match(
      read('packages/server/src/provider/static/static.provider.ts'),
      /const originalName = decodeUploadFileName\(file\.originalname\)/,
    );
  });
});
