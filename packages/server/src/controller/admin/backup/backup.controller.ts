import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  BACKUP_SIG_EXT,
  SIGNING_KEY_ENV,
  SIGNING_KEY_FILE_ENV,
  VERIFY_KEY_ENV,
  VERIFY_KEY_FILE_ENV,
  describeSigningKey,
  generateSigningKeyPair,
  resolveSigningKey,
  resolveVerifyKey,
} from 'src/utils/backupSigning';
import { Response } from 'express';
import { ArticleProvider } from 'src/provider/article/article.provider';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { CategoryProvider } from 'src/provider/category/category.provider';
import { DraftProvider } from 'src/provider/draft/draft.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { TagProvider } from 'src/provider/tag/tag.provider';
import { UserProvider } from 'src/provider/user/user.provider';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dayjs from 'dayjs';
import { FileInterceptor } from '@nestjs/platform-express';
import { JSON_IMPORT_UPLOAD_OPTIONS } from 'src/utils/uploadLimits';
import { removeID } from 'src/utils/removeId';
import { ViewerProvider } from 'src/provider/viewer/viewer.provider';
import { VisitProvider } from 'src/provider/visit/visit.provider';
import { StaticProvider } from 'src/provider/static/static.provider';
import { SettingProvider } from 'src/provider/setting/setting.provider';
import { config } from 'src/config';
import { ApiToken } from 'src/provider/swagger/token';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { collectCategoriesFromBackup, toExportCategory } from 'src/utils/backupCategories';

// 恢复用的 multer 上传选项搬到了 `src/utils/restoreUpload.ts`：
// 初始化页的 `POST /api/admin/init/restore`（匿名可达，仅未初始化时开放）要用**同一份**限额，
// 两边各写一份迟早会漂（一边 8GB 一边 200MB，大站就会在初始化页莫名其妙地 413）。
import { RESTORE_UPLOAD_OPTIONS } from 'src/utils/restoreUpload';
import { FullBackupProvider } from 'src/provider/backup/fullBackup.provider';
import { availableFormats, pickSpec, takeRestoreSignatureWarning } from 'src/utils/fullBackup';
import { checkTrue } from 'src/utils/checkTrue';
import { isTrue } from 'src/utils/isTrue';
import { JwtService } from '@nestjs/jwt';
import { rotateJwtSecret, switchJwtSigningKey } from 'src/utils/initJwt';

/**
 * 签名功能的信任边界，原样返回给调用方（后台会显示它）。
 * ⚠️ 之所以放在响应里而不只放文档：这个功能最危险的失败模式是**被高估** ——
 * 站长以为"备份签了名就万无一失"，于是把归档和公钥一起扔进同一个网盘。
 */
const SIGNING_TRUST_BOUNDARY =
  '签名能证明的是「这份归档离开主机之后没有被改过」。验签材料（公钥）必须存在主机之外：' +
  '只存在本机时，拿到主机 root 的人可以连公钥一起换掉。它**不防**已经有主机 root 的攻击者' +
  '（私钥必须在主机上才能签名），防的是对象存储/网盘/U 盘/异地副本这些路径上的篡改。';

@ApiTags('backup')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/backup')
export class BackupController {
  private readonly logger = new Logger(BackupController.name);
  constructor(
    private readonly articleProvider: ArticleProvider,
    private readonly categoryProvider: CategoryProvider,
    private readonly tagProvider: TagProvider,
    private readonly metaProvider: MetaProvider,
    private readonly draftProvider: DraftProvider,
    private readonly userProvider: UserProvider,
    private readonly viewerProvider: ViewerProvider,
    private readonly visitProvider: VisitProvider,
    private readonly settingProvider: SettingProvider,
    private readonly staticProvider: StaticProvider,
    private readonly isrProvider: ISRProvider,
    private readonly fullBackupProvider: FullBackupProvider,
    // ⚠️ 追加在参数表**最后**：这个构造器在测试里是按位置 new 出来的（两处），
    //    插在中间会让既有用例把参数喂错位而不报错。
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 轮换 JWT 签名密钥 —— "怀疑整站备份归档已经泄露"时的补救入口。
   *
   * 为什么落在这个控制器下：归档里就有 `settings{type:'jwt'}` 的这份密钥，
   * 而 `/api/admin/backup/**` 本轮已经被划进**只有超管能过**的路由前缀
   * （`SUPER_ADMIN_ONLY_ROUTE_PREFIXES`），所以这个入口自动继承了正确的权限口径 ——
   * 勾了「所有权限」的协作者**不能**轮换密钥（那等于能把管理员全部登出）。
   * 语义上它也确实属于"备份泄露之后的处置"，与 export/restore/verify 是一组。
   *
   * 后果（响应里会原样告诉调用方）：
   *  - 所有用旧密钥签发的登录会话在**宽限期内**仍可验签，期满即失效；
   *  - ⚠️ **API Token 也是同一份密钥签的**（`tokens` 集合、`userId=666666`），
   *    所以宽限期一过它们**全部**失效，外部集成必须在后台重新签发；
   *  - 当前登录的管理员自己不会立刻掉线（宽限期），但下次登录用的是新密钥。
   */
  @Post('jwt/rotate')
  async rotateJwtSecretEndpoint(@Body() body: { graceDays?: number | string }) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    // 宽限期：不传就用 env/默认值；传了就要是个 0..365 的数（0 = 立刻作废旧密钥）
    let graceDays: number | undefined;
    if (body?.graceDays !== undefined && body?.graceDays !== null && `${body.graceDays}` !== '') {
      const parsed = Number(body.graceDays);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 365) {
        throw new BadRequestException(
          `graceDays 必须是 0 到 365 之间的数字（0 = 旧密钥立即失效），收到：${String(body.graceDays).slice(0, 40)}`,
        );
      }
      graceDays = parsed;
    }
    let signingSwitched = false;
    const result = await rotateJwtSecret({
      graceDays,
      onSigningKeySwitched: (secret) => {
        signingSwitched = switchJwtSigningKey(this.jwtService, secret);
      },
      logger: {
        log: (message) => this.logger.log(message),
        warn: (message) => this.logger.warn(message),
      },
    });
    // ⚠️ 签发侧没切成功时必须说出来：此时验签已用新密钥、签发还在用旧密钥，
    //    宽限期一过这段时间里登录的用户会提前掉线。补救办法是重启容器（重启后
    //    JwtModule 的工厂会重新读库拿到新密钥）。静默忽略正是本功能要防的失败模式。
    const restartRequired = !signingSwitched;
    return {
      statusCode: 200,
      message: restartRequired
        ? `JWT 密钥已轮换（新 kid ${result.kid}），但**签发侧没能就地切换**：请重启容器完成切换，` +
          `否则在重启之前新签发的令牌仍用旧密钥，宽限期结束后会提前失效。`
        : `JWT 密钥已轮换（新 kid ${result.kid}）：旧 kid ${result.previousKid} 进入 ${result.graceDays} 天宽限期，` +
          `期满后所有用旧密钥签发的登录会话与 API Token 一律失效。`,
      data: { ...result, restartRequired },
    };
  }

  /**
   * 备份**签名**密钥的状态与公钥导出。
   *
   * ⚠️ 只返回公钥与指纹，**私钥一个字节都不出去**（有守卫钉住这一点）：
   * 私钥一旦经 HTTP 走出去，就会留在浏览器历史、反代日志与任何中间件里，
   * 而"备份可以被证明"的全部价值就没了。要换密钥请走 POST（它把私钥直接落盘 0600）。
   *
   * 🔴 信任边界（响应里也照实说）：验签材料（公钥）**必须存在主机之外**，
   * 否则拿到主机 root 的人可以连公钥一起换掉。这个功能防的是"归档**离开主机之后**被篡改"
   * （对象存储、网盘、U 盘、异地副本），**不防**已经有主机 root 的攻击者。
   */
  @Get('signing/key')
  async getSigningKey() {
    const backupDir = this.fullBackupProvider.backupDir();
    let signing = null as ReturnType<typeof resolveSigningKey>;
    let verify = null as ReturnType<typeof resolveVerifyKey>;
    try {
      signing = resolveSigningKey(backupDir);
    } catch (err) {
      return {
        statusCode: 200,
        data: {
          signingConfigured: false,
          signingError: `${(err as Error)?.message || err}`,
          verifyConfigured: false,
          trustBoundary: SIGNING_TRUST_BOUNDARY,
        },
      };
    }
    try {
      verify = resolveVerifyKey(backupDir);
    } catch (err) {
      return {
        statusCode: 200,
        data: {
          signingConfigured: Boolean(signing),
          signingFingerprint: signing?.fingerprint ?? null,
          signingSource: signing?.source ?? null,
          verifyConfigured: false,
          verifyError: `${(err as Error)?.message || err}`,
          trustBoundary: SIGNING_TRUST_BOUNDARY,
        },
      };
    }
    return {
      statusCode: 200,
      data: {
        signingConfigured: Boolean(signing),
        signingSource: signing?.source ?? null,
        signingFingerprint: signing?.fingerprint ?? null,
        signingDescribe: describeSigningKey(signing),
        verifyConfigured: Boolean(verify),
        verifySource: verify?.source ?? null,
        verifyFingerprint: verify?.fingerprint ?? null,
        // 公钥可以公开（它就是用来分发给验签方的）；⚠️ 私钥绝不返回
        publicKey: verify?.publicKeyPem ?? signing?.publicKeyPem ?? null,
        envNames: {
          signingKey: SIGNING_KEY_ENV,
          signingKeyFile: SIGNING_KEY_FILE_ENV,
          verifyKey: VERIFY_KEY_ENV,
          verifyKeyFile: VERIFY_KEY_FILE_ENV,
        },
        trustBoundary: SIGNING_TRUST_BOUNDARY,
      },
    };
  }

  /**
   * 生成一对新的 ed25519 备份签名密钥。
   *
   * ⚠️ 私钥**直接落盘**（`<备份目录>/signing/`，目录 0700、文件 0600），**不经 HTTP 返回**；
   * 响应里只有公钥、指纹与私钥的**路径**。想让私钥离开备份目录（例如用 Docker secret），
   * 改用 `VANBLOG_BACKUP_SIGNING_KEY_FILE`。
   *
   * ⚠️ 覆盖已有密钥会让**所有已签名归档的 `.sig` 永久无法验证**（旧私钥被删掉），
   * 所以覆盖需要与破坏性恢复同一口径的显式确认（`confirm=true`，只认字面 true）。
   */
  @Post('signing/key')
  async createSigningKey(@Body() body: { confirm?: string; overwrite?: string }) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const backupDir = this.fullBackupProvider.backupDir();
    // overwrite 与 confirm 是同一个意思的两种写法，都只认字面 true
    const overwrite = isTrue(body?.overwrite) || isTrue(body?.confirm);
    const result = generateSigningKeyPair(backupDir, { overwrite });
    this.logger.warn(
      `已${result.replaced ? '覆盖' : '生成'}备份签名密钥（指纹 ${result.fingerprint}）：` +
        `私钥 ${result.privatePath}（0600，不经接口返回）。` +
        `⚠️ 请把公钥离线保存一份 —— 验签材料只存在本机时，拿到主机 root 的人可以连公钥一起换掉。`,
    );
    return {
      statusCode: 200,
      message: result.replaced
        ? `已覆盖备份签名密钥（新指纹 ${result.fingerprint}）。⚠️ 用旧密钥签过的归档现在**无法再验签**，` +
          `除非你还留着旧公钥（而旧私钥已被覆盖，旧 .sig 也就无法再产生新的了）。`
        : `已生成备份签名密钥（指纹 ${result.fingerprint}）。从现在起的整站备份会自动写出 .sig；` +
          `已有归档不会追溯签名（可以重新备份一次）。`,
      data: {
        fingerprint: result.fingerprint,
        publicKey: result.publicKeyPem,
        privatePath: result.privatePath,
        publicPath: result.publicPath,
        replaced: result.replaced,
        trustBoundary: SIGNING_TRUST_BOUNDARY,
      },
    };
  }

  @Get('export')
  async getAll(@Res() res: Response) {
    // 导出会打包整站数据
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    // ⚠️ 必须用 getAllForExport()（`toObject()` 原样文档）而不是 getAll('admin')：
    // ArticleSchema 挂了 toJSON transform 把 password 换成布尔 hasPassword，
    // 而下面最后一句是 `JSON.stringify(data)` —— 用文档的话导出的 JSON 里就没有密码了，
    // 再导入到另一套站点时 create() 走"留空=不加密"，加密文章会**静默变成公开文章**。
    // 分类那边不需要改：toExportCategory() 是属性访问，不走 toJSON。
    const articles = await this.articleProvider.getAllForExport(true);
    const categoryDocs = await this.categoryProvider.getAllCategories(true);
    const categories = (categoryDocs || []).map((item) => toExportCategory(item));
    const tags = await this.tagProvider.getAllTags(true);
    const meta = await this.metaProvider.getAll();
    const drafts = await this.draftProvider.getAll();
    const user = await this.userProvider.getUser();
    // 访客记录
    const viewer = await this.viewerProvider.getAll();
    const visit = await this.visitProvider.getAll();
    // 设置表
    const staticSetting = await this.settingProvider.getStaticSetting();
    const staticItems = await this.staticProvider.exportAll();
    const data = {
      articles,
      tags,
      meta,
      drafts,
      categories,
      user,
      viewer,
      visit,
      static: staticItems,
      setting: { static: staticSetting },
    };
    // 临时文件放系统 tmp 目录：以前写在进程 cwd（packages/server/temp.json），
    // 而且只有出错时才删，成功下载就把整站数据留在了代码目录里。
    const tmpFile = path.join(os.tmpdir(), `vanblog-backup-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    res.download(tmpFile, 'vanblog-backup.json', (err) => {
      if (err) {
        this.logger.error(err.stack);
      } else {
        this.logger.log('success', 'download');
      }
      fs.rmSync(tmpFile, { force: true });
    });
  }

  // ---------------------------------------------------------------------------
  // 整站备份：数据库（含 waline 评论库）+ 本地静态文件 -> 一个高压缩归档，可整体恢复
  // ---------------------------------------------------------------------------

  /** 本机可用的压缩格式（zstd > xz > gzip，按可用性排序）。 */
  @Get('full/formats')
  async fullFormats() {
    const formats = availableFormats();
    return {
      statusCode: 200,
      data: {
        available: formats,
        default: pickSpec('auto')?.format || null,
        note: 'zstd -19 --long 体积最小且最快；没有 zstd 时用 xz -9e；都没有就退回 gzip -9',
      },
    };
  }

  @Post('full/export')
  async exportFull(@Body() body: { format?: string }) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    // 导出成功返回时**必然已通过写后校验**（校验失败会抛 400，见 FullBackupProvider.doExport）
    const result = await this.fullBackupProvider.export(body?.format);
    return {
      statusCode: 200,
      data: {
        name: result.name,
        // 归档不在静态目录下，只能走这个鉴权接口下载
        downloadUrl: `/api/admin/backup/full/download?name=${encodeURIComponent(result.name)}`,
        bytes: result.bytes,
        size: result.sizeText,
        format: result.format,
        compressor: result.compressor,
        seconds: Number((result.ms / 1000).toFixed(1)),
        // P2 写后校验结果（手动与 cron 走的都是这条路）
        verified: result.verification?.ok === true,
        verifySeconds: Number(((result.verification?.ms || 0) / 1000).toFixed(1)),
        // P1 防损坏：整归档 sha256（同名 `.sha256` sidecar 与 backup-status.json 里都有）、
        // 成员数、merkle root，以及这次是否做了成员级哈希
        sha256: result.archiveSha256 || null,
        memberCount: result.memberCount ?? null,
        merkleRoot: result.manifest?.integrity?.merkleRoot || null,
        membersHashed: result.verification?.integrity?.membersChecked ?? null,
        integrity: result.verification?.integrity
          ? {
              available: result.verification.integrity.available,
              merkleRootOk: result.verification.integrity.merkleRootOk,
              memberCountOk: result.verification.integrity.memberCountOk,
              manifestCopyOk: result.verification.integrity.manifestCopyOk,
              archiveSha256Ok: result.verification.integrity.archiveSha256Ok,
              frameChecksumOk: result.verification.integrity.frameChecksumOk,
              notes: result.verification.integrity.notes,
            }
          : null,
        totals: result.manifest.totals,
        databases: Object.fromEntries(
          Object.entries(result.manifest.databases).map(([name, item]) => [
            name,
            Object.keys(item.collections).length,
          ]),
        ),
        static: result.manifest.static,
        // P6：这次有没有把 caddy 的 TLS 材料打进去
        caddy: result.manifest.caddy || null,
      },
    };
  }

  /**
   * 备份健康状态（P2）：最近一次成功/失败、连续失败次数、陈旧判定。
   * **只在 AdminGuard 后面**：它暴露运维状态（备份节奏、失败原因），绝不上公开接口。
   * cron 备份（vanblog.sh backup）失败时，这里是"不翻日志也能看见"的地方：
   * consecutiveFailures > 0 且 lastFailureStage/lastFailureMessage 直接说明哪一步坏了。
   */
  @Get('full/status')
  async fullStatus() {
    return { statusCode: 200, data: this.fullBackupProvider.status() };
  }

  @Get('full/list')
  async listFull() {
    const items = this.fullBackupProvider.list();
    return {
      statusCode: 200,
      data: items.map((item) => ({
        name: item.name,
        bytes: item.bytes,
        size: item.sizeText,
        format: item.format,
        createdAt: item.createdAt,
        downloadUrl: `/api/admin/backup/full/download?name=${encodeURIComponent(item.name)}`,
        totals: item.manifest?.totals || null,
        // P1：清单里记的整归档 sha256（老归档没有 => null；`.sha256` sidecar 是另一个来源）
        sha256: item.manifest?.totals?.archiveSha256 || null,
        memberCount: item.manifest?.integrity?.memberCount ?? null,
        hasIntegrity: Boolean(item.manifest?.integrity),
      })),
    };
  }

  /**
   * 按需复验一份归档（P1/P4）。
   *
   * 与后台"备份健康状态"里的定期巡检用的是**同一个校验器**，区别只是这里默认做到
   * 成员级（`deep`）：把归档整份解压一遍（**不落盘**）、逐个成员与清单里的 sha256 对比，
   * 报告**具体是哪个成员坏了**（路径 + 期望 vs 实际），而不是笼统一句"归档损坏"。
   * ⚠️ 只读：既不修也不删任何东西 —— "哪份归档该扔"是人的决定。
   */
  @Post('full/verify')
  async verifyFull(@Body() body: { name?: string; deep?: string }) {
    const deep = body?.deep === undefined ? true : checkTrue(body.deep);
    const result = await this.fullBackupProvider.verifyArchive(body?.name || '', deep);
    return {
      statusCode: 200,
      data: {
        name: body?.name || '',
        ok: result.ok,
        deep,
        seconds: Number((result.ms / 1000).toFixed(2)),
        bytes: result.archiveBytes,
        members: result.members,
        format: result.format,
        checks: result.checks,
        integrity: result.integrity,
        issues: result.issues,
      },
    };
  }

  @Post('full/inspect')
  async inspectFull(@Body() body: { name?: string }) {
    const manifest = await this.fullBackupProvider.inspect(body?.name || '');
    if (!manifest) {
      throw new BadRequestException('读不出这个备份的清单：文件损坏，或不是本功能导出的整站备份');
    }
    return { statusCode: 200, data: manifest };
  }

  /**
   * 从整站备份恢复：`name` 用服务器上已有的备份，或直接上传一个备份文件。
   * 会覆盖当前数据库与静态文件，所以必须显式带 `confirm=true`。
   */
  @Post('full/restore')
  @UseInterceptors(FileInterceptor('file', RESTORE_UPLOAD_OPTIONS))
  async restoreFull(
    @UploadedFile() file: any,
    // ⚠️ `passphrase` 只从 body 取（multer 的文本字段或 JSON 都行），**不接受 query**：
    //    query 会进 caddy 访问日志。⚠️ 也绝不要把它写进任何 logger 调用。
    // ⚠️ `skipSignatureCheck` 与 `confirm` 同一个口径：**只认字面 true**（见下面 `isTrue`）。
    //    它是"我知道这份归档验不过签/没有公钥，仍然要恢复"的显式逃生口，不是默认路径。
    @Body()
    body: {
      name?: string;
      confirm?: string;
      withStatic?: string;
      passphrase?: string;
      skipSignatureCheck?: string;
    },
  ) {
    // 整个方法体都要在 try 里：演示站/confirm 校验提前 return/throw 时，
    // multer 已经把上传的归档（几百 MB）落到磁盘了，不清理就永久泄漏
    const uploadedPath = file?.path;
    try {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    // ⚠️ 这道闸门**必须**用最严的布尔口径（`isTrue`：只认 boolean true 与字符串 'true'），
    //    不能用曾经宽松的 `checkTrue`（旧实现 `s == true` 会让 `confirm:"1"`、`confirm:1`、
    //    `confirm:[1]` 都算"站长已确认"）。破坏性操作的确认闸门是全仓库最不该宽松的一处判定。
    //    两个助手现在语义一致，但这里刻意点名 `isTrue`：万一将来有人把 `checkTrue` 改回松散比较，
    //    这道闸门也不会跟着松（有守卫钉住 `confirm:'1'`/`1`/`[1]` 一律不算确认）。
    if (!isTrue(body?.confirm)) {
      throw new BadRequestException(
        '恢复会覆盖当前全部数据，请带 confirm=true 再调用一次（只接受字面量 true 或字符串 "true"；' +
          '"1"/"yes"/"TRUE" 都不算确认）',
      );
    }
    let archivePath = uploadedPath;
    const uploaded = Boolean(uploadedPath);
    if (!archivePath) {
      if (!body?.name) {
        throw new BadRequestException('请指定要恢复的备份（name），或直接上传备份文件');
      }
      archivePath = this.fullBackupProvider.resolveArchive(body.name);
    }
    {
      const result = await this.fullBackupProvider.restore(
        archivePath,
        body?.withStatic === undefined ? true : checkTrue(body.withStatic),
        typeof body?.passphrase === 'string' && body.passphrase.length > 0 ? body.passphrase : null,
        // ⚠️ 用 isTrue（只认字面 true），不用 checkTrue：跳过一道**安全校验**的开关
        //    必须与破坏性操作的确认闸门同样严格，否则 `skipSignatureCheck:"1"` 就能绕过验签。
        isTrue(body?.skipSignatureCheck),
      );
      // ⚠️ delay 必须给：`activeAll` 会把它转交给 RSS 与 sitemap 两个生成器，
      // 不传就是"RSS 3 分钟 / sitemap 1 分钟"之后才写文件（且会被后续任何一次 activeAll 重置），
      // 恢复完立刻去看 /feed.xml 会 404。`main.ts` 启动时传的也是 1000。
      this.isrProvider.activeAll('整站恢复触发全量渲染！', 1000);
      return {
        statusCode: 200,
        data: {
          restoredAt: new Date().toISOString(),
          seconds: Number((result.ms / 1000).toFixed(1)),
          databases: result.databases,
          static: result.static,
          backupCreatedAt: result.manifest.createdAt,
          notes: result.notes,
          uploaded,
          // P3（100% 保真）：修剪掉多少"归档里没有的文件"、以及哪些表是归档里没有的
          // （后者留着不删 = 站点处于混合状态，必须让前台能显示出来）
          prunedStatic: (result.pruned || []).map((item) => ({
            folder: item.folder,
            removedFiles: item.removedFiles,
            removedDirs: item.removedDirs,
            removedBytes: item.removedBytes,
            names: item.names,
            skipped: item.skipped,
            errors: item.errors,
          })),
          absentCollections: result.absentCollections || [],
          caddy: result.caddy || null,
          // 流水线依赖只在启动时装（不在请求路径上跑 pnpm add），前台据此提示"重启一次"
          needsRestartForPipelineDeps: Boolean(result.needsRestartForPipelineDeps),
          // 签名校验的降级提示（没验签/跳过验签时非 null）。
          // ⚠️ 必须回到**响应体**里，不能只进容器日志：灾难现场站长未必看得见日志，
          //    而"这次恢复没有验证归档真实性"是他必须知道的一件事。
          signatureWarning: takeRestoreSignatureWarning(),
        },
      };
    }
    } finally {
      if (uploadedPath) {
        fs.rmSync(uploadedPath, { force: true });
      }
    }
  }

  /** 删掉一个备份归档（含三个 sidecar：清单、整归档校验和、签名）。 */
  @Post('full/delete')
  async deleteFull(@Body() body: { name?: string }) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const archivePath = this.fullBackupProvider.resolveArchive(body?.name || '');
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(`${archivePath}.manifest.json`, { force: true });
    // P1 新增的 `.sha256` sidecar：不删就变成孤儿（`vanblog.sh verify` 会拿它去比一个不存在的归档）
    fs.rmSync(`${archivePath}.sha256`, { force: true });
    // ⚠️ `.sig` 同样要删：一份没有归档的签名是纯噪音，而且它会让人误以为"这里还有一份备份"。
    //    （`vanblog.sh` 侧的 prune glob 也已带上 `.enc`/`.sig`，两边口径要一致。）
    fs.rmSync(`${archivePath}${BACKUP_SIG_EXT}`, { force: true });
    return { statusCode: 200, data: '已删除' };
  }

  /** 鉴权下载：归档不在静态目录下（含数据库内容），只能走这个接口。 */
  @Get('full/download')
  async downloadFull(@Query('name') name: string, @Res() res: Response) {
    const archivePath = this.fullBackupProvider.resolveArchive(name);
    res.download(archivePath, path.basename(archivePath), (err) => {
      if (err) {
        this.logger.error(err.stack);
      }
    });
  }

  /**
   * 下载一份归档的 `.sig`（离线签名）。
   *
   * 为什么需要这个接口：归档本身只能走 `full/download`（不在静态目录下），
   * 如果签名拿不到，那么"只有后台权限的人"就永远无法把归档与签名一起带走 ⇒
   * 异地验签这条路径等于不存在。⚠️ `.sig` 里**没有机密**（只有公钥指纹、sha256 与签名本身），
   * 但它仍然走鉴权接口而不是静态目录：备份目录整体在静态目录之外，不该为它开一个匿名口子。
   */
  @Get('full/download-sig')
  async downloadSignature(@Query('name') name: string, @Res() res: Response) {
    const archivePath = this.fullBackupProvider.resolveArchive(name || '');
    const sigPath = `${archivePath}${BACKUP_SIG_EXT}`;
    if (!fs.existsSync(sigPath)) {
      // ⚠️ 明确 404 而不是返回空文件：空文件会被 `readSignatureSidecar` 判成 malformed，
      //    于是站长看到的是"签名坏了"，而真相是"这份归档从没被签过"。
      throw new NotFoundException(
        `这份归档没有 ${BACKUP_SIG_EXT}（${path.basename(archivePath)}）：它可能早于签名功能，` +
          `或备份时没有配签名密钥。用 GET /api/admin/backup/signing/key 看当前签名配置。`,
      );
    }
    res.download(sigPath, path.basename(sigPath), (err) => {
      if (err) {
        this.logger.error(err.stack);
      }
    });
  }

  @Post('/import')
  @UseInterceptors(FileInterceptor('file', JSON_IMPORT_UPLOAD_OPTIONS))
  async importAll(@UploadedFile() file: Express.Multer.File) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const json = file.buffer.toString();
    const data = JSON.parse(json);
    const { meta, setting, categories } = data;
    let { articles, drafts, viewer, visit, static: staticItems } = data;
    // 去掉 id
    articles = removeID(articles);
    drafts = removeID(drafts);
    viewer = removeID(viewer);
    visit = removeID(visit);
    if (staticItems) {
      staticItems = removeID(staticItems);
    }
    if (setting && setting.static) {
      setting.static = { ...setting.static, _id: undefined, __v: undefined };
    }
    if (meta) {
      delete meta._id;
    }

    const toImportCategories = collectCategoriesFromBackup({
      categories,
      articles,
      drafts,
      meta,
    });
    await this.categoryProvider.importCategories(toImportCategories);
    if (toImportCategories.length && meta) {
      meta.categories = toImportCategories.map((item) => item.name);
    }

    await this.articleProvider.importArticles(articles);
    await this.draftProvider.importDrafts(drafts);
    // 新机器必须先初始化后台账号才能打开导入页。覆盖 user 会把刚配好的登录顶掉，
    // 甚至把备份里已哈希的密码再哈希一次，两边账号都登不进去。账号改走设置页。
    if (data.user) {
      this.logger.log('导入备份时保留当前后台账号，未覆盖用户数据');
    }
    await this.metaProvider.update(meta);
    await this.settingProvider.importSetting(setting);
    await this.staticProvider.importItems(staticItems);
    if (visit) {
      await this.visitProvider.import(visit);
    }
    if (viewer) {
      await this.viewerProvider.import(viewer);
    }
    this.isrProvider.activeAll('导入备份触发增量渲染！');
    return {
      statusCode: 200,
      data: '导入成功！',
    };
  }
}
