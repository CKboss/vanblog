import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 恢复过程的**断点日志**（P5：恢复被打断必须看得见）。
 *
 * 现状：恢复是**逐集合原子**的（先写 `<coll>__vanblog_restore`，再 `rename(dropTarget:true)`），
 * 但**跨集合不是原子的** —— 进程在两张表之间被杀（OOM、`docker stop`、断电），
 * 库里就是"一半是归档内容、一半是恢复前内容"的混合状态，而且**没有任何痕迹**：
 * 接口没返回、日志只到"恢复 vanBlog.articles ..."那一行，运维看不出到底换了几张表。
 *
 * 所以每换完一张表就落一次 journal（tmp + rename，原子写），成功后删掉，失败/被打断就留着。
 * 启动时（仅主实例）看到它就打一条**点名归档与进度**的 WARN，并把它塞进
 * `backup-status.json`，让后台与 `vanblog.sh backup-status` 不翻日志也能看见。
 *
 * ⚠️ 这是**检测**，不是修复：journal 绝不触发任何自动回滚（回滚需要另一份数据，
 * 而"另一份"就是恢复前的库，它已经被 rename 覆盖掉了）。它只保证"混合状态不会被静默"。
 *
 * ⚠️ journal 写在 `config.backupPath` 而**不是**数据库里 —— 与 `backup-status.json` 同理：
 * 恢复会把整库换成归档内容，状态跟着回退就等于抹掉最需要看的现场。
 */

export const RESTORE_JOURNAL_FILE = 'restore-journal.json';
export const RESTORE_JOURNAL_VERSION = 1;

export type RestorePhase =
  | 'unpack'
  | 'collections'
  | 'static'
  | 'prune'
  | 'caddy'
  | 'finished'
  | 'failed';

export interface RestoreJournalCollection {
  db: string;
  collection: string;
  documents: number;
  at: string;
}

export interface RestoreJournal {
  version: number;
  startedAt: string;
  updatedAt: string;
  /** 归档的绝对路径与文件名（跨机器恢复上传件时路径是临时目录，名字更有用） */
  archivePath: string;
  archiveName: string;
  /** 归档清单里的 createdAt（恢复的是哪一刻的站点） */
  archiveCreatedAt: string | null;
  hostname: string;
  pid: number;
  phase: RestorePhase;
  /** 计划要换的集合：dbName -> 集合名 */
  planned: Record<string, string[]>;
  /** 已经换好的集合（按完成顺序） */
  done: RestoreJournalCollection[];
  error: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * journal 写入器。
 *
 * **任何一次写失败都只 warn、不抛**：journal 是可观测性设施，
 * 它写不进去（磁盘满 / 只读）不该把一次本来会成功的恢复变成失败。
 */
export class RestoreJournalWriter {
  private journal: RestoreJournal;
  private closed = false;

  private constructor(
    private readonly file: string,
    journal: RestoreJournal,
    private readonly warn: (message: string) => void,
  ) {
    this.journal = journal;
  }

  /** 打开（并立刻落一次盘）；写不进去就返回 null，调用方照常恢复。 */
  static open(
    file: string,
    info: { archivePath: string; archiveCreatedAt?: string | null },
    warn: (message: string) => void = () => undefined,
  ): RestoreJournalWriter | null {
    if (!file) {
      return null;
    }
    const journal: RestoreJournal = {
      version: RESTORE_JOURNAL_VERSION,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      archivePath: info.archivePath,
      archiveName: path.basename(info.archivePath || ''),
      archiveCreatedAt: info.archiveCreatedAt ?? null,
      hostname: safeHostname(),
      pid: process.pid,
      phase: 'unpack',
      planned: {},
      done: [],
      error: null,
    };
    const writer = new RestoreJournalWriter(file, journal, warn);
    if (!writer.persist()) {
      return null;
    }
    return writer;
  }

  /** 计划要换哪些集合（解包读到清单之后就能确定） */
  setPlanned(planned: Record<string, string[]>): void {
    this.journal.planned = planned || {};
    this.persist();
  }

  setPhase(phase: RestorePhase): void {
    this.journal.phase = phase;
    this.persist();
  }

  /** 每换完一张表就调一次：这是"崩溃之后能说出换了几张表"的唯一来源 */
  recordCollection(db: string, collection: string, documents: number): void {
    this.journal.done.push({ db, collection, documents, at: nowIso() });
    this.persist();
  }

  /** 成功：删掉 journal（没有断点了） */
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.journal.phase = 'finished';
    this.journal.updatedAt = nowIso();
    try {
      fs.rmSync(this.file, { force: true });
    } catch (err) {
      this.warn(`删除恢复日志失败（${this.file}）：${(err as Error)?.message || err}`);
    }
  }

  /** 失败：留下 journal 与错误原因（这是"混合状态"的现场） */
  fail(error: string): void {
    if (this.closed) return;
    this.journal.phase = 'failed';
    this.journal.error = String(error || '').slice(0, 2000);
    // ⚠️ 必须**先落盘再置 closed**：persist() 对已关闭的 writer 是 no-op，
    // 顺序写反了就会"失败现场一个字都没写下来"（这条正是被单测抓出来的）
    this.persist();
    this.closed = true;
  }

  snapshot(): RestoreJournal {
    return JSON.parse(JSON.stringify(this.journal));
  }

  private persist(): boolean {
    if (this.closed) {
      return false;
    }
    this.journal.updatedAt = nowIso();
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.journal, null, 2));
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
      // 只 warn 一次，别在每张表上都刷一行
      if (!(this as any).__warnedPersist) {
        (this as any).__warnedPersist = true;
        this.warn(`写恢复日志失败（不影响恢复本身，但崩溃后将无法说出换了几张表）：${(err as Error)?.message || err}`);
      }
      return false;
    }
  }
}

function safeHostname(): string {
  try {
    return os.hostname();
  } catch {
    return 'unknown';
  }
}

/** 读 journal；不存在 / 损坏 / 版本不认识一律返回 null（绝不让它把启动带崩）。 */
export function readRestoreJournal(backupDir: string): RestoreJournal | null {
  try {
    const file = path.join(backupDir, RESTORE_JOURNAL_FILE);
    if (!fs.existsSync(file)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== RESTORE_JOURNAL_VERSION) {
      return null;
    }
    return parsed as RestoreJournal;
  } catch {
    return null;
  }
}

/** 计划里换了几张表、已经换完几张（journal 缺失字段时按 0 处理） */
export function journalProgress(journal: RestoreJournal): { planned: number; done: number } {
  const planned = Object.values(journal?.planned || {}).reduce(
    (sum: number, list) => sum + (Array.isArray(list) ? list.length : 0),
    0,
  );
  const done = Array.isArray(journal?.done) ? journal.done.length : 0;
  return { planned, done };
}

/**
 * 把 journal 变成一句人话（启动时的 WARN 与 `backup-status.json` 都用它）。
 * 必须点名归档、进度与最后一个动作 —— "有东西坏了"这种话等于没说。
 */
export function describeRestoreJournal(journal: RestoreJournal): string {
  const { planned, done } = journalProgress(journal);
  const last = Array.isArray(journal?.done) && journal.done.length ? journal.done[journal.done.length - 1] : null;
  const names = (journal?.done || []).map((item) => `${item.db}.${item.collection}`).join(', ');
  const parts = [
    `上一次整站恢复没有正常结束（阶段 ${journal?.phase}，开始于 ${journal?.startedAt}，最后更新 ${journal?.updatedAt}）`,
    `归档 ${journal?.archiveName || journal?.archivePath || '?'}` +
      (journal?.archiveCreatedAt ? `（备份时刻 ${journal.archiveCreatedAt}）` : ''),
    `已换完 ${done}/${planned} 张表` + (last ? `，最后一张是 ${last.db}.${last.collection}（${last.documents} 条）` : ''),
  ];
  if (journal?.error) {
    parts.push(`错误：${journal.error}`);
  }
  parts.push(
    '当前数据库可能是「归档内容 + 恢复前内容」的混合状态：请核对上面列出的表，' +
      '必要时重跑一次恢复（恢复是逐集合原子的，重跑安全）',
  );
  if (names) {
    parts.push(`已换的表：${names}`);
  }
  return parts.join('；');
}
