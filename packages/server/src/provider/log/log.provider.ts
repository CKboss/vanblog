import { Injectable, Logger } from '@nestjs/common';
import pino from 'pino';
import fs from 'fs';
import { EventType } from './types';
import { Request } from 'express';
import { getNetIp, getPlatform } from './utils';
import { config } from 'src/config';
import path from 'path';
import { checkOrCreate } from 'src/utils/checkFolder';
import { sanitizePagination } from 'src/utils/pagination';
import { readLogTailLines } from 'src/utils/logTail';
import { Pipeline } from 'src/scheme/pipeline.schema';
import { CodeResult } from '../pipeline/pipeline.provider';

/**
 * 一次「看日志」最多往回扫多少行 / 多少字节。
 *
 * ⚠️ 以前是把整个事件日志从头读到尾、每行 JSON.parse 一次，只为取出最近 page*pageSize 条：
 * 日志只增不减，于是后台每翻一页日志的代价都随运行时间线性上涨（几 MB = 几万次 JSON.parse，
 * 全压在事件循环上）。现在从文件尾部往前读，凑够就停（`utils/logTail.ts`）。
 * 代价是 `total` 只在扫过的范围内统计：日志比 20000 行还长时它是个下界，
 * 深翻页会翻不到最老的那些——事件日志本来也没人会翻到几万条之前。
 */
function envPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

export const LOG_SCAN_MAX_LINES = envPositiveInt('VANBLOG_LOG_SCAN_MAX_LINES', 20000);
export const LOG_SCAN_MAX_BYTES = envPositiveInt('VANBLOG_LOG_SCAN_MAX_BYTES', 8 * 1024 * 1024);

// 模块级 Logger：searchLog 的调用方（含单测）可能是 `Object.create(prototype)` 出来的裸对象，
// 拿不到实例字段；而且这里也不能用 this.logger（那是往同一个文件里写事件的 pino）
const scanLogger = new Logger('LogProvider');
@Injectable()
export class LogProvider {
  logger = null;
  logPath = path.join(config.log, 'vanblog-event.log');
  systemLogPath = path.join('/var/log/', 'vanblog-stdio.log');
  constructor() {
    checkOrCreate(config.log);
    const streams = [
      {
        stream: fs.createWriteStream(this.logPath, {
          flags: 'a+',
        }),
      },
      { stream: process.stdout },
    ];
    this.logger = pino({ level: 'debug' }, pino.multistream(streams));
    this.logger.info({ event: 'start' });
  }
  async runPipeline(
    pipeline: Pipeline,
    input: any,
    result?: CodeResult,
    error?: Error,
  ) {
    this.logger.info({
      event: EventType.RUN_PIPELINE,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      eventName: pipeline.eventName,
      success: result?.status == 'success' ? true : false,
      logs: result?.logs || [],
      output: result?.output || [],
      serverError: error?.message || '',
      input,
    });
  }
  async login(req: Request, success: boolean) {
    const logger = this.logger;
    const { address, ip } = await getNetIp(req);
    const platform = getPlatform(req.headers['user-agent']);
    logger.info({
      address,
      ip,
      platform,
      event: EventType.LOGIN,
      success,
    });
  }
  async searchLog(page: number, pageSize: number, eventType: EventType) {
    const paging = sanitizePagination(page, pageSize, { defaultPageSize: 10 });
    const skip = paging.skip;
    // 需要从新到旧凑够这么多条（页码 * 每页条数）
    const all = paging.page * paging.pageSize;
    const filePath = eventType == EventType.SYSTEM ? this.systemLogPath : this.logPath;
    const tail = await readLogTailLines(filePath, LOG_SCAN_MAX_LINES, {
      maxBytes: LOG_SCAN_MAX_BYTES,
    });
    if (tail.truncated) {
      scanLogger.warn(
        `日志文件超过扫描上限（只读了尾部 ${tail.lines.length} 行 / ${tail.bytes} 字节），` +
          `total 是下界；需要看更早的日志请直接读文件：${filePath}`,
      );
    }
    const matched: any[] = [];
    let total = 0;
    // 从最新的一行往回走：老实现是正着读完整个文件、用一个滑动窗口留住最后 all 条再 reverse，
    // 结果一样，但要付整份文件的读取与解析代价
    for (let i = tail.lines.length - 1; i >= 0; i -= 1) {
      const line = tail.lines[i];
      // 空行直接跳过：老实现遇到空行会 resolve，等于把后面的日志全部丢掉
      if (!line || !line.trim()) continue;
      let data: any = line;
      if (eventType !== EventType.SYSTEM) {
        try {
          data = JSON.parse(line);
        } catch {
          // 半行/被截断的日志不该让整页 500，跳过就行
          continue;
        }
      }
      if (eventType === EventType.SYSTEM || data?.event == eventType) {
        total = total + 1;
        if (matched.length < all) {
          matched.push(data);
        }
      }
    }
    // matched 已经是从新到旧（等价于老实现的 data.reverse()）
    if (matched.length <= skip) {
      return { data: [], total };
    }
    return {
      data: matched.slice(skip),
      total,
    };
  }
}
