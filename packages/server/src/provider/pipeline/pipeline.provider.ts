import { envPositiveInt } from 'src/utils/envNumber';

/**
 * 单个流水线的执行上限：超时直接杀进程，避免 await 永久挂起。
 *
 * ⚠️ 以前是裸的 `Number(process.env.X || 30000)`：env 写成 `30s` / `abc` 时得到 **NaN**，
 * 而 `setTimeout(fn, NaN)` 在 Node 里等于 1ms ⇒ 流水线刚 fork 出来就被判"超时"杀掉，
 * 报错信息还印着 `超过 NaNs 未返回结果`（看起来像流水线自己写错了，实际是 env 打错了）。
 */
const PIPELINE_TIMEOUT_MS = envPositiveInt('VANBLOG_PIPELINE_TIMEOUT_MS', 30000, 1000, 3600000);
/** 安装依赖的上限（同样要防 NaN，见上面）。 */
const DEPS_INSTALL_TIMEOUT_MS = envPositiveInt(
  'VANBLOG_DEPS_INSTALL_TIMEOUT_MS',
  300000,
  1000,
  7200000,
);

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as path from 'path';
import { Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PipelineDocument } from 'src/scheme/pipeline.schema';
import { VanblogSystemEvent, VanblogSystemEventNames } from 'src/types/event';
import { CreatePipelineDto, UpdatePipelineDto } from 'src/types/pipeline.dto';
import { sleep } from 'src/utils/sleep';
import { redactAccessSecretDeep } from 'src/utils/accessPassword';
import { spawnSync } from 'child_process';
import { config } from 'src/config/index';
import { writeFileSync, rmSync } from 'fs';
import {fork, spawn} from 'child_process';
import cluster from 'node:cluster';
import { isPrimaryInstance } from 'src/utils/clusterRole';
import { LogProvider } from '../log/log.provider';
import { MigrationProvider } from '../migration/migration.provider';

export interface CodeResult {
  logs: string[];
  output: any;
  status: 'success' | 'error';
}

/**
 * 依赖名的**额外**校验（在"非 `-` 开头 + 字符集"之上）。
 * 返回 `null` = 可以装；返回字符串 = 拒绝原因（进日志，不回显给客户端）。
 *
 * ⚠️ 必须放行的合法形状（最常见的几种，别误伤）：
 *   `pkg`、`pkg@1.2.3`、`pkg@^1.2.3`、`pkg@~1.2`、`@scope/pkg`、`@scope/pkg@^1.2.3`
 * ⚠️ 要拒掉的：
 *   - 以 `/` 开头（容器内绝对路径）
 *   - 含 `..` 路径段（逃出 runnerPath 去装别处的代码）
 *   - `file:` / `link:` / `workspace:` 协议（同样指向本地路径或工作区，而不是 registry）
 */
export function inspectDepSpec(dep: string): string | null {
  // ⚠️ 自己兜类型，不依赖调用方：`String(Symbol())` 会**抛** TypeError，
  //    而 `String({})` 是 `'[object Object]'` —— 一个"看着像包名"的字符串，
  //    后面的规则一条都不命中，于是非字符串输入会被**放行**。这正是本仓库
  //    反复踩的那类坑（"没有值"伪装成"值合法"），所以在第一行就挡掉。
  if (typeof dep !== 'string') return '不是字符串';
  const value = dep;
  if (!value.trim()) return '空值';
  if (value.startsWith('/')) return '以 / 开头，是容器内绝对路径';
  if (value.split('/').some((seg) => seg === '..')) return '含 .. 路径段，会逃出流水线目录';
  // `@scope/pkg` 里 `@` 后面跟的是 scope 名，不会误伤；只有 `@file:` / `pkg@link:` 这种才命中
  if (/(?:^|@)(?:file|link|workspace):/i.test(value)) {
    return 'file:/link:/workspace: 协议指向本地路径或工作区';
  }
  return null;
}

/**
 * 由流水线 id 推出代码文件路径。
 *
 * ⚠️ **运行时**校验，不依赖 TS 类型：`id: number` 只是编译期声明，而这个值可能来自路由参数、
 *    数据库文档或内部调用方（:290 fork、:405 写盘、:414 删除）。controller 侧已有
 *    `parsePipelineId`（`^-?\d+$` + `Number.isSafeInteger`）兜着 HTTP 入口，所以今天不存在
 *    可达的"任意写"；这里是**纵深防御** —— 万一将来新增一个不走那个 helper 的调用方，
 *    或者 DB 里出现畸形 id，也不该把文件写到 runnerPath 之外。
 *
 * 两层：① 只接受安全整数（字符串形式的整数也认，因为 DB/路由都可能是字符串）；
 *      ② 解析后再做一次容器化校验（与 `utils/customPagePath.ts` 的 `resolveCustomPageAbs` 同款判据）。
 *      第 ② 层在 ① 成立时**永远不可能失败**（整数拼不出路径分隔符），留着是为了让
 *      "路径必须落在 runnerPath 内"这件事成为函数自己的契约，而不是调用方的运气。
 */
export function resolvePipelineFilePath(runnerPath: string, id: unknown): string {
  const raw = typeof id === 'string' ? id.trim() : id;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (typeof raw !== 'number' && !/^-?\d+$/.test(String(raw ?? ''))) {
    throw new BadRequestException(`流水线 id 不合法：${String(id).slice(0, 40) || '(空)'}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new BadRequestException(`流水线 id 不合法：${String(id).slice(0, 40) || '(空)'}`);
  }
  const root = path.resolve(String(runnerPath ?? ''));
  const abs = path.resolve(root, `${n}.js`);
  const rel = path.relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ForbiddenException('非法路径');
  }
  return abs;
}

@Injectable()
export class PipelineProvider {
  logger = new Logger(PipelineProvider.name);
  idLock = false;
  runnerPath = config.codeRunnerPath;
  constructor(
    @InjectModel('Pipeline')
    private pipelineModel: Model<PipelineDocument>,
    private readonly logProvider: LogProvider,
    /** 迁移台账（可选注入：单测直接 `new` 时不传；record 永不抛错）。 */
    @Optional() private readonly migration?: MigrationProvider,
  ) {
    // ⚠️ 只由主实例做：`init()` 会跑 `checkAllDeps()`（对每个依赖执行 `pnpm add`，
    // cwd 是共享的 codeRunnerPath）与 `saveAllScripts()`（写同一批 <id>.js 文件）。
    // 多进程时每个 worker 都来一遍 ⇒ N 个 `pnpm add` 同时改同一个 node_modules
    // （pnpm 自己都不保证并发安全），以及 N 份内容相同但互相截断的写文件。
    // 单进程时 isPrimaryInstance() 恒为真，行为与以前完全一致。
    if (isPrimaryInstance(cluster)) {
      this.init();
    } else {
      this.logger.log('cluster worker：跳过流水线的依赖安装与脚本落盘（由主实例负责）');
    }
  }

  checkEvent(eventName: string) {
    if (VanblogSystemEventNames.includes(eventName)) {
      return true;
    }
    return false;
  }

  async checkAllDeps() {
    this.logger.log('初始化流水线代码库，这可能需要一段时间');
    const pipelines = await this.getAll();
    const deps = [];
    for (const pipeline of pipelines) {
      for (const dep of pipeline.deps) {
        if (!deps.includes(dep)) {
          deps.push(dep);
        }
      }
    }
    await this.addDeps(deps);
  }

  async saveAllScripts() {
    const pipelines = await this.getAll();
    for (const pipeline of pipelines) {
      await this.saveOrUpdateScriptToRunnerPath(pipeline.id, pipeline.script);
    }
  }

  async init() {
    // 检查一遍，安装依赖。
    // ⚠️ 以前这里是裸的 `this.checkAllDeps();`（floating promise，reject 只能靠全局
    // unhandledRejection 兜底日志）。现在挂上迁移台账 + 带来源的 WARN：`pnpm add` 失败
    // （离线/超时）会记成 `deps:pipelineStartup` outcome='error'，后台台账页一眼可见。
    const depsStarted = Date.now();
    this.checkAllDeps()
      .then(async () => {
        await this.migration?.record({
          key: 'deps:pipelineStartup',
          kind: 'sync',
          outcome: 'ok',
          durationMs: Date.now() - depsStarted,
          detail: '启动期依赖检查/安装完成',
        });
      })
      .catch(async (err) => {
        this.logger.error(
          `启动期流水线依赖安装失败（已配置的流水线可能跑不起来）：${
            (err as Error)?.message || err
          }`,
        );
        await this.migration?.record({
          key: 'deps:pipelineStartup',
          kind: 'sync',
          outcome: 'error',
          durationMs: Date.now() - depsStarted,
          detail: (err as Error)?.message || String(err),
        });
      });
    // 脚本落盘（库是唯一事实来源）：同步等待，记 `sync:pipelineScripts` 一条
    const scriptsStarted = Date.now();
    try {
      await this.saveAllScripts();
      await this.migration?.record({
        key: 'sync:pipelineScripts',
        kind: 'sync',
        outcome: 'ok',
        durationMs: Date.now() - scriptsStarted,
        detail: '按库重写 <codeRunnerPath>/<id>.js 完成',
      });
    } catch (err) {
      await this.migration?.record({
        key: 'sync:pipelineScripts',
        kind: 'sync',
        outcome: 'error',
        durationMs: Date.now() - scriptsStarted,
        detail: (err as Error)?.message || String(err),
      });
      throw err;
    }
  }

  async getNewId() {
    while (this.idLock) {
      await sleep(10);
    }
    this.idLock = true;
    try {
    const maxObj = await this.pipelineModel.find({}).sort({ id: -1 }).limit(1);
    let res = 1;
    if (maxObj.length) {
      res = maxObj[0].id + 1;
    }
      return res;
    } finally {
      // 一次查询失败就会让 idLock 永远为 true，之后所有新建请求都在 while 里空转，
      // 只能重启进程才能恢复 —— 所以必须放在 finally 里释放
      this.idLock = false;
    }
  }

  async createPipeline(pipeline: CreatePipelineDto) {
    if (!this.checkEvent(pipeline.eventName)) {
      throw new NotFoundException('Event not found in VanblogEventNames');
    }
    const id = await this.getNewId();
    let script = pipeline.script;
    if (!script || !script.trim()) {
      script = `
// 异步任务，请在脚本顶层使用 await，不然会直接被忽略
// 请使用 input 变量获取数据（如果有）
// 直接修改 input 里的内容即可
// 脚本结束后 input 将被返回

`;
    }
    const newPipeline = await this.pipelineModel.create({
      id,
      ...pipeline,
      script,
    });
    await newPipeline.save();
    await this.saveOrUpdateScriptToRunnerPath(id, newPipeline.script);
    await this.addDeps(newPipeline.deps);
  }

  async updatePipelineById(id: number, updateDto: UpdatePipelineDto) {
    await this.pipelineModel.updateOne({ id: id }, updateDto);
    if (updateDto.script) {
      await this.saveOrUpdateScriptToRunnerPath(id, updateDto.script);
    }
    if (updateDto.deps) {
      await this.addDeps(updateDto.deps);
    }
  }

  async deletePipelineById(id: number) {
    await this.pipelineModel.updateOne(
      { id: id },
      {
        deleted: true,
      },
    );
    await this.deleteScriptById(id);
  }
  async getAll() {
    return await this.pipelineModel.find({
      deleted: false,
    });
  }

  async getPipelineById(id: number) {
    return await this.pipelineModel.findOne({ id: id });
  }

  async getPipelinesByEvent(eventName: string) {
    return await this.pipelineModel.find({
      eventName,
      deleted: false,
    });
  }

  async triggerById(id: number, data: any) {
    const result = await this.runCodeByPipelineId(id, data);
    return result;
  }

  async dispatchEvent(eventName: VanblogSystemEvent, data?: any) {
    const pipelines = await this.getPipelinesByEvent(eventName);
    const results: CodeResult[] = [];
    for (const pipeline of pipelines) {
      if (pipeline.enabled) {
        try {
          const result = await this.runCodeByPipelineId(pipeline.id, data);
          results.push(result);
        } catch (e) {
          this.logger.error(e);
        }
      }
    }
    return results;
  }

  getPathById(id: number) {
    return resolvePipelineFilePath(this.runnerPath, id);
  }

  async runCodeByPipelineId(id: number, data: any): Promise<CodeResult> {
    const pipeline = await this.getPipelineById(id);
    if (!pipeline) {
      throw new NotFoundException('Pipeline not found');
    }
    /**
     * 事件 payload 的脱敏副本（G5）。**所有**出口一律用它，绝不用原始 `data`：
     *  ① 下面的 `logger.log(JSON.stringify(...))` —— 服务端日志（有日志聚合器时读者远不止管理员）；
     *  ② `subProcess.send(...)` —— IPC 给用户自己写的流水线脚本；
     *  ③ `logProvider.runPipeline(..., input)` —— **持久化进 logs 集合**，后台「日志管理」直接展示。
     * `beforeUpdateArticle` / `beforeUpdateDraft` 传进来的是客户端 DTO，里面的 `password`
     * 是用户刚敲的**明文**。文章/分类密码哈希化之后，库里存的已经是 scrypt 哈希 ——
     * 日志就会变成明文唯一还活着的地方，一次为了消灭明文的迁移反而把明文留在了日志表里。
     *
     * ⚠️ `redactAccessSecretDeep` 返回**新对象**，`data` 本身一个字节都不动：
     *    控制器还要拿原 DTO 去写库（`updateById(id, updateDto)`）。
     * ⚠️ 行为变更：脚本从此看不到 `password` / `clearPassword`，前置事件改成收到布尔
     *    `submittedPassword`（= 这次请求有没有带新密码）。要判断文章是否加密请读 `private`。
     *    脚本改写 DTO 后密码意图会不会丢，见 `carryAccessSecretFields`（控制器侧透传）。
     */
    const safeData: any = redactAccessSecretDeep(data);
    const traceId = new Date().getTime();
    this.logger.log(`[${traceId}]开始运行流水线: ${id} ${JSON.stringify(safeData, null, 2)}`);
    const run = new Promise<CodeResult>((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean, payload: any) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (ok) {
          resolve(payload);
        } else {
          reject(payload);
        }
      };
      const subProcess = fork(this.getPathById(id));
      // 没有超时和 error/exit 监听时，只要脚本不 postMessage（死循环、await 卡住、
      // 或者 <codeRunner>/<id>.js 已经被删导致子进程起不来），这个 Promise 就永远 pending。
      // 而 dispatchEvent 是被 await 的 —— 结果是**保存任何文章都会永久卡住**。
      const timer = setTimeout(() => {
        try {
          subProcess.kill('SIGKILL');
        } catch {
          // 进程可能已经没了
        }
        finish(false, {
          status: 'error',
          message: `流水线执行超时（超过 ${PIPELINE_TIMEOUT_MS / 1000}s 未返回结果）`,
          output: [],
          logs: [],
        } as CodeResult);
      }, PIPELINE_TIMEOUT_MS);
      try {
        // 脱敏副本，见本函数开头 safeData 的注释（出口 ②）
        subProcess.send(safeData || {});
      } catch (err) {
        finish(false, {
          status: 'error',
          message: `无法向流水线进程发送数据：${(err as Error)?.message || err}`,
          output: [],
          logs: [],
        } as CodeResult);
        return;
      }
      subProcess.on('message', (msg: CodeResult) => {
        if (msg?.status === 'error') {
          try {
            subProcess.kill('SIGINT');
          } catch {
            // ignore
          }
          finish(false, msg);
        } else {
          finish(true, msg);
        }
      });
      subProcess.on('error', (err: Error) => {
        finish(false, {
          status: 'error',
          message: `流水线进程启动失败：${err?.message || err}`,
          output: [],
          logs: [],
        } as CodeResult);
      });
      subProcess.on('exit', (code) => {
        // 正常路径下 message 已经先 settle 了，这里只兜「没发消息就退出」的情况
        finish(false, {
          status: 'error',
          message: `流水线进程退出（code=${code}）且没有返回结果`,
          output: [],
          logs: [],
        } as CodeResult);
      });
    });
    try {
      const result = (await run) as CodeResult;
      this.logger.log(`[${traceId}]运行流水线成功: ${id} ${JSON.stringify(result, null, 2)}`);
      // safeData：日志表里存的 input 也必须是脱敏副本（见本函数开头）
      this.logProvider.runPipeline(pipeline, safeData, result);
      return result;
    } catch (err) {
      this.logger.error(`[${traceId}]运行流水线失败: ${id} ${JSON.stringify(err, null, 2)}`);
      this.logProvider.runPipeline(pipeline, safeData, undefined, err);
      throw err;
    }
  }

  async addDeps(deps: string[]) {
    for (const dep of deps) {
      // 依赖名会作为 argv 传给 pnpm，`-` 开头会被当成参数（参数注入），先挡掉
      if (typeof dep !== 'string' || dep.startsWith('-') || !/^[a-zA-Z0-9@/._^~>-]*$/.test(dep)) {
        this.logger.warn(`跳过不合法的依赖名：${String(dep).slice(0, 80)}`);
        continue;
      }
      // ⚠️ 上面那个字符集**故意**允许 `/ . ~ ^`（scoped 包 `@scope/pkg` 与版本范围 `pkg@^1.2.3`
      //    都要靠它们），代价是 `../../../x` 这种**本地路径**也能通过，于是 pnpm 会从
      //    容器内任意路径安装（而不是从 registry）。管理员才能触发，所以不是权限跨越，
      //    但"能从镜像里任意目录装代码"这件事本身就该收掉 —— 见 inspectDepSpec。
      const unsafeReason = inspectDepSpec(dep);
      if (unsafeReason) {
        this.logger.warn(`跳过不安全的依赖名（${unsafeReason}）：${String(dep).slice(0, 80)}`);
        continue;
      }
      try {
        // 不能用 spawnSync：`pnpm add` 动辄十几秒，同步等待会把整个事件循环卡死，
        // 期间所有 HTTP 请求（包括前台页面）都不响应。和 §7.6 备份的教训一样。
        const output = await new Promise<string>((resolve) => {
          let out = '';
          const child = spawn('pnpm', ['add', dep], {
            cwd: this.runnerPath,
            shell: process.platform === 'win32',
            env: { ...process.env },
          });
          const killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }, DEPS_INSTALL_TIMEOUT_MS);
          child.stdout?.on('data', (d) => (out += String(d)));
          child.stderr?.on('data', (d) => (out += String(d)));
          child.on('error', (err) => {
            clearTimeout(killTimer);
            resolve(`${out}\n${err?.message || err}`);
          });
          child.on('close', () => {
            clearTimeout(killTimer);
            resolve(out);
          });
        });
        this.logger.log(`安装流水线依赖 ${dep}：${output.slice(0, 500)}`);
      } catch (e) {
        this.logger.error(`安装流水线依赖 ${dep} 失败：${(e as Error)?.message || e}`);
      }
    }
  }

  async deleteScriptById(id: number) {
    const filePath = this.getPathById(id);
    try {
      rmSync(filePath);
    } catch (err) {
      this.logger.error(err);
    }
  }

  async saveOrUpdateScriptToRunnerPath(id: number, script: string) {
    const filePath = this.getPathById(id);
    const scriptToSave = `
      let input = {};
      let logs = [];
      const oldLog = console.log;
      console.log = (...args) => {
        const logArr = [];
        for (const each of args) {
          if (typeof each === 'object') {
            logArr.push(JSON.stringify(each,null,2));
          } else {
            logArr.push(each);
          }
        }
        logs.push(logArr.join(" "));
        oldLog(...args);
      };
      process.on('message',async (msg) => {
        input = msg;
        try {
          ${script}
          process.send({
            status: 'success',
            output: input,
            logs,
          });
        } catch(err) {
          process.send({
            status: 'error',
            output: err,
            logs,
          });
        }
      });
    `;
    writeFileSync(filePath, scriptToSave, { encoding: 'utf-8' });
  }
}
