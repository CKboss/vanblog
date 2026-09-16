import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createViewerDto } from 'src/types/viewer.dto';
import { Viewer, ViewerDocument } from 'src/scheme/viewer.schema';
import dayjs from 'dayjs';
import { buildUpsertOps, chunkArray } from 'src/utils/bulkUpsert';
@Injectable()
export class ViewerProvider {
  private readonly logger = new Logger(ViewerProvider.name);
  constructor(@InjectModel('Viewer') private viewerModel: Model<ViewerDocument>) {}

  async create(createViewerDto: createViewerDto): Promise<Viewer> {
    const createdData = new this.viewerModel(createViewerDto);
    return createdData.save();
  }

  async createOrUpdate(createViewerDto: createViewerDto) {
    const { date, ...rest } = createViewerDto;
    // 一次 upsert 取代「先 findOne 再 create / updateOne」：
    //  - 少一次数据库往返（这个函数在每日 cron 与浏览统计里都会用到）；
    //  - `date` 上有唯一索引（见 statsMaintenance.provider），并发下也不会插出两行同日快照，
    //    而「先查再建」在并发首访时必然会（visits 那张表就是这么攒出重复行的）。
    return this.viewerModel
      .updateOne(
        { date },
        { $set: rest, $setOnInsert: { date, createdAt: new Date() } },
        { upsert: true },
      )
      .exec();
  }

  /**
   * 后台「概览/访问趋势」的每日访客快照（累计 total + 每日增量 each）。
   *
   * ⚠️ 以前这里是标准的 **N+1**：num+1 天逐天串行 `findOne`（后台默认 num=5，
   * 但趋势图可以要 30/90 天 —— 91 次串行往返）。现在一次
   * `find({date:{$in:…}}).sort({date:1})` 全取回来（走 viewers 的 date 唯一索引），
   * 再在 JS 里按天取值。**日期序列、循环方向、缺失天直接跳过的语义与原来逐字一致**，
   * 返回对象逐字段相同（spec 里与旧算法的输出做 deep-equal 对比钉住）。
   */
  async getViewerGrid(num: number) {
    const curDate = dayjs();
    const gridTotal = [];
    const tmpArr = [];
    const today = { viewer: 0, visited: 0 };
    const lastDay = { viewer: 0, visited: 0 };
    // 与旧的逐日循环完全相同的日期序列：num 天前 → 今天（升序）。
    // num 是 NaN / 负数时循环体一次都不执行、$in 是空数组 —— 与旧行为一致。
    const dates: string[] = [];
    for (let i = num; i >= 0; i--) {
      dates.push(curDate.add(-1 * i, 'day').format('YYYY-MM-DD'));
    }
    const byDate = new Map<string, Viewer>();
    if (dates.length) {
      const rows = await this.viewerModel
        .find({ date: { $in: dates } })
        .sort({ date: 1 })
        .exec();
      for (const row of rows) {
        const key = (row as any)?.date;
        // date 上有唯一索引，正常一天最多一行；真有重复时保留第一行
        // （旧的 findOne 无排序，重复时本来也只是"任意一行"，语义没有被收紧也没有被放宽）
        if (typeof key === 'string' && !byDate.has(key)) {
          byDate.set(key, row);
        }
      }
    }
    for (let i = num; i >= 0; i--) {
      const last = curDate.add(-1 * i, 'day').format('YYYY-MM-DD');
      const lastDayData = byDate.get(last);
      if (i == 0) {
        if (lastDayData) {
          today.viewer = lastDayData.viewer;
          today.visited = lastDayData.visited;
        }
      }
      if (i == 1) {
        if (lastDayData) {
          lastDay.viewer = lastDayData.viewer;
          lastDay.visited = lastDayData.visited;
        }
        if (today.viewer == 0) {
          // 如果今天没数据，那今天的就和昨天的一样吧。这样新增就都是 0
          today.viewer = lastDayData?.viewer || 0;
          today.visited = lastDayData?.visited || 0;
        }
      }
      if (lastDayData) {
        tmpArr.push({
          date: last,
          visited: lastDayData.visited,
          viewer: lastDayData.viewer,
        });
        if (i != num + 1) {
          gridTotal.push({
            date: last,
            visited: lastDayData.visited,
            viewer: lastDayData.viewer,
          });
        }
      }
    }

    const gridEachDay = [];
    let pre = tmpArr[0];
    for (let i = 1; i < tmpArr.length; i++) {
      const curObj = tmpArr[i];
      if (curObj) {
        if (pre) {
          gridEachDay.push({
            date: curObj.date,
            visited: curObj.visited - pre.visited,
            viewer: curObj.viewer - pre.viewer,
          });
        } else {
          gridEachDay.push({
            date: curObj.date,
            visited: curObj.visited,
            viewer: curObj.viewer,
          });
        }
      }
      pre = curObj;
    }
    return {
      grid: {
        total: gridTotal,
        each: gridEachDay,
      },
      add: {
        viewer: today.viewer - lastDay.viewer,
        visited: today.visited - lastDay.visited,
      },
      now: {
        viewer: today.viewer,
        visited: today.visited,
      },
    };
  }

  async getAll(): Promise<Viewer[]> {
    return this.viewerModel.find({}).exec();
  }

  async findByDate(date: string): Promise<Viewer> {
    return this.viewerModel.findOne({ date }).exec();
  }
  /**
   * 导入 `viewers`（每日快照）。与 `VisitProvider.import` 同一套改造：
   * 原来是"每条 findOne + updateOne/save"的串行循环（800 天 = 1600 次串行往返），
   * 现在按批 upsert，失败回落到老的逐条写法（幂等，可重复应用）。
   */
  async import(data: Viewer[]) {
    if (!Array.isArray(data) || data.length === 0) {
      return;
    }
    for (const chunk of chunkArray(data)) {
      try {
        await this.viewerModel.bulkWrite(buildUpsertOps(chunk as any[], ['date']), { ordered: true });
      } catch (err) {
        this.logger.warn(
          `批量导入 viewers 失败（${chunk.length} 条），回落到逐条写入：${
            (err as Error)?.message || err
          }`,
        );
        await this.importSequentially(chunk);
      }
    }
  }

  /** 改动前的实现，原样保留，只作为批量失败时的回落路径 */
  private async importSequentially(data: Viewer[]) {
    for (const each of data) {
      const oldData = await this.viewerModel.findOne({
        date: each.date,
      });
      if (oldData) {
        await this.viewerModel.updateOne({ _id: oldData._id }, each);
      } else {
        const newData = new this.viewerModel(each);
        await newData.save();
      }
    }
  }
}
