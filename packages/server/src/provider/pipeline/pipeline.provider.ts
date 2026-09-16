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

import { Injectable, NotFoundException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PipelineDocument } from 'src/scheme/pipeline.schema';
import { VanblogSystemEvent, VanblogSystemEventNames } from 'src/types/event';
import { CreatePipelineDto, UpdatePipelineDto } from 'src/types/pipeline.dto';
import { sleep } from 'src/utils/sleep';
import { spawnSync } from 'child_process';
import { config } from 'src/config/index';
import { writeFileSync, rmSync } from 'fs';
import {fork, spawn} from 'child_process';
import cluster from 'node:cluster';
import { isPrimaryInstance } from 'src/utils/clusterRole';
import { LogProvider } from '../log/log.provider';

export interface CodeResult {
  logs: string[];
  output: any;
  status: 'success' | 'error';
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
    // 检查一遍，安装依赖
    this.checkAllDeps();
    await this.saveAllScripts();
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
    return `${this.runnerPath}/${id}.js`;
  }

  async runCodeByPipelineId(id: number, data: any): Promise<CodeResult> {
    const pipeline = await this.getPipelineById(id);
    if (!pipeline) {
      throw new NotFoundException('Pipeline not found');
    }
    const traceId = new Date().getTime();
    this.logger.log(`[${traceId}]开始运行流水线: ${id} ${JSON.stringify(data, null, 2)}`);
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
        subProcess.send(data || {});
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
      this.logProvider.runPipeline(pipeline, data, result);
      return result;
    } catch (err) {
      this.logger.error(`[${traceId}]运行流水线失败: ${id} ${JSON.stringify(err, null, 2)}`);
      this.logProvider.runPipeline(pipeline, data, undefined, err);
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
