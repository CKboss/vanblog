import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import dayjs from 'dayjs';
import { Model } from 'mongoose';
import { createVisitDto } from 'src/types/visit.dto';
import { Visit } from 'src/scheme/visit.schema';
import { VisitDocument } from 'src/scheme/visit.schema';

@Injectable()
export class VisitProvider {
  constructor(@InjectModel('Visit') private visitModel: Model<VisitDocument>) {}

  /**
   * 记一次「某条路径今天被访问了一下」。
   *
   * ⚠️ 这**不再是浏览热路径**：每次页面浏览现在走
   * `provider/stats/viewStats.provider.ts`（进程内攒一批，一轮 flush 一次 bulkWrite），
   * 一次浏览从 8 次 Mongo 命令降到 ~0.2 次。这里保留的是"单次、立刻落库"的写法，
   * 语义与批量那条路一致（当天没有行时从最近一天的累计值 +1 建新行），
   * 也是 `test/stats-maintenance.e2e-spec.ts` 用来复现并发首访重复行的入口。
   *
   * 下面那段 catch 重复键的兜底**依赖 `{date,pathname}` 上的唯一索引**
   * （由 `provider/stats/statsMaintenance.provider.ts` 在启动时去重后建）。
   * 索引不存在时它永远不会触发 —— 那正是改动前的状态：并发首访静默产生重复行
   * （本机线上实测到 2 组），之后 `findOneAndUpdate({date,pathname})` 只更新其中一行。
   * 实测：没有唯一索引时 8 个并发首访 = 8 行；有了唯一索引 = 1 行且 viewer 正好是 8（一次不丢）。
   */
  async add(createViewerDto: createVisitDto): Promise<any> {
    // 先找一下有没有今天的，有的话就在今天的基础上加1。
    const { isNew, pathname } = createViewerDto;
    // 这里的 isNew 代表是对于这个文章来说有没有访问过。
    const today = dayjs().format('YYYY-MM-DD');
    // 先试**原子**自增：原来「先查再写回」在并发下会互相覆盖（同一天同一页面的
    // 两个访客同时进来，只记一次）。命中当天记录时一条 $inc 就够了。
    const inc: Record<string, number> = { viewer: 1 };
    if (isNew) {
      inc.visited = 1;
    }
    const bumped = await this.visitModel
      .findOneAndUpdate(
        { date: today, pathname },
        { $inc: inc, $set: { lastVisitedTime: new Date() } },
        { new: true },
      )
      .exec();
    if (bumped) {
      return bumped;
    }
    {
      // 今天还没有记录：沿用上一天的累计值 +1 建一条新的。
      // 并发首次访问可能同时走到这里，第二条 create 会撞唯一性/产生重复行，
      // 所以捕获后回退到上面的原子 $inc。
      const lastData = await this.getLastData(pathname);
      const lastVisit = lastData?.visited || 0;
      const lastViewer = lastData?.viewer || 0;
      const createdData = new this.visitModel({
        date: today,
        viewer: lastViewer + 1,
        visited: isNew ? lastVisit + 1 : lastVisit,
        pathname: pathname,
        lastVisitedTime: new Date(),
      });
      try {
        return await createdData.save();
      } catch (err) {
        const retry = await this.visitModel
          .findOneAndUpdate(
            { date: today, pathname },
            { $inc: inc, $set: { lastVisitedTime: new Date() } },
            { new: true },
          )
          .exec();
        if (retry) {
          return retry;
        }
        throw err;
      }
    }
  }

  async rewriteToday(pathname: string, viewer: number, visited: number) {
    const today = dayjs().format('YYYY-MM-DD');
    const todayData = await this.findByDateAndPath(today, pathname);
    if (todayData) {
      await this.visitModel.updateOne({ _id: todayData.id }, { viewer, visited });
    } else {
      await this.visitModel.create({
        date: today,
        viewer,
        visited,
        pathname,
      });
    }
  }

  async getLastData(pathname: string) {
    const lastData = await this.visitModel.find({ pathname }).sort({ date: -1 }).limit(1);
    if (lastData && lastData.length > 0) {
      return lastData[0];
    }
    return null;
  }

  async getAll(): Promise<Visit[]> {
    return this.visitModel.find({}).exec();
  }

  async findByDateAndPath(date: string, pathname: string): Promise<Visit> {
    return this.visitModel.findOne({ date, pathname }).exec();
  }
  async getByArticleId(id: number | string) {
    const pathname = id == 0 ? `/about` : `/post/${id}`;
    const result = await this.visitModel
      .find({
        pathname,
      })
      .sort({ date: -1 })
      .limit(1);
    if (result && result.length) {
      return result[0];
    }
    return null;
  }
  async getLastVisitItem() {
    const result = await this.visitModel
      .find({
        lastVisitedTime: { $exists: true },
      })
      .sort({ lastVisitedTime: -1 })
      .limit(1);
    if (result && result.length) {
      return result[0];
    }
    return null;
  }

  async import(data: Visit[]) {
    for (const each of data) {
      const oldData = await this.visitModel.findOne({
        pathname: each.pathname,
        date: each.date,
      });
      if (oldData) {
        await this.visitModel.updateOne({ _id: oldData._id }, each);
      } else {
        const newData = new this.visitModel(each);
        await newData.save();
      }
    }
  }
}
