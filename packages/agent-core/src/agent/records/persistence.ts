/**
 * Agent 记录的持久化后端。
 *
 * 提供两种 {@link AgentRecordPersistence} 实现：
 * - {@link FileSystemAgentRecordPersistence} — 以换行分隔的 JSON（`wire.jsonl`）写入记录，
 *   支持原子刷盘、目录同步和 blob 卸载。
 * - {@link InMemoryAgentRecordPersistence} — 将记录保存在普通数组中，
 *   适用于测试和不需要持久性的临时会话。
 *
 * @module records/persistence
 */
import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'pathe';

import { syncDir } from '../../utils/fs';
import type { BlobStore } from './blobref';
import { type AgentRecord, type AgentRecordPersistence } from './types';

/**
 * {@link FileSystemAgentRecordPersistence} 的配置选项。
 */
export interface FileSystemAgentRecordPersistenceOptions {
  /**
   * 刷盘操作失败时调用。错误仍会在下一次
   * {@link FileSystemAgentRecordPersistence.append} 或
   * {@link FileSystemAgentRecordPersistence.flush} 调用时重新抛出，
   * 但此回调允许调用方立即记录或上报失败。
   */
  readonly onError?: ((error: unknown) => void) | undefined;
  /**
   * 可选的 {@link BlobStore}，用于将大型 base64 媒体载荷卸载到单独文件，
   * 保持 wire.jsonl 紧凑。
   */
  readonly blobStore?: BlobStore | undefined;
}

/**
 * {@link InMemoryAgentRecordPersistence} 的配置选项。
 */
export interface InMemoryAgentRecordPersistenceOptions {
  /**
   * 每条记录追加后调用，便于在测试中断言记录序列。
   */
  readonly onRecord?: ((record: AgentRecord) => void) | undefined;
}

/**
 * {@link AgentRecordPersistence} 的内存实现。
 *
 * 将所有记录存储在普通数组中。主要用于单元测试
 * 和不需要文件系统持久性的临时会话。
 * {@link flush} 和 {@link close} 为空操作。
 */
export class InMemoryAgentRecordPersistence implements AgentRecordPersistence {
  /**
   * 底层数组。直接暴露以便测试无需通过持久化 API 即可检查或操作。
   */
  readonly records: AgentRecord[] = [];

  /**
   * @param records - 用于初始化存储的可选初始记录。
   * @param options - 配置选项。
   */
  constructor(
    records: readonly AgentRecord[] = [],
    private readonly options: InMemoryAgentRecordPersistenceOptions = {},
  ) {
    this.records.push(...records);
  }

  /** 按插入顺序返回所有存储的记录。 */
  async *read(): AsyncIterable<AgentRecord> {
    for (const record of this.records) {
      yield record;
    }
  }

  /** 追加一条记录，并可选地通知 `onRecord` 监听器。 */
  append(input: AgentRecord): void {
    this.records.push(input);
    this.options.onRecord?.(input);
  }

  /** 用提供的列表替换所有存储的记录。 */
  rewrite(records: readonly AgentRecord[]): void {
    this.records.splice(0, this.records.length, ...records);
  }

  /** 空操作——内存记录按定义已处于持久化状态。 */
  async flush(): Promise<void> {}

  /** 空操作——无需释放资源。 */
  async close(): Promise<void> {}
}

/**
 * 基于文件系统的 {@link AgentRecordPersistence} 实现。
 *
 * 记录以换行分隔的 JSON 写入单个 `wire.jsonl` 文件。
 * 写入批量异步刷盘，对文件及其父目录执行 `fsync` 以保证崩溃后的持久性。
 *
 * 特性：
 * - **原子重写**：当 {@link rewrite} 被调用时，文件在单个刷盘周期内被截断并重写。
 * - **崩溃容错**：刷盘中途崩溃导致的截断尾行在下次读取时被静默跳过。
 * - **Blob 卸载**：如果提供了 {@link BlobStore}，大型 base64 载荷在写入前会被替换为 `blobref:` URL。
 */
export class FileSystemAgentRecordPersistence implements AgentRecordPersistence {
  private readonly pendingRecords: AgentRecord[] = [];
  private shouldClear = false;
  private directorySynced = false;
  private flushPromise: Promise<void> | undefined;
  private error: unknown;

  /**
   * @param filePath - `wire.jsonl` 文件的绝对路径。父目录在首次写入时自动创建。
   * @param options - 配置选项。
   */
  constructor(
    private readonly filePath: string,
    private readonly options: FileSystemAgentRecordPersistenceOptions = {},
  ) {}

  /**
   * 从文件中按插入顺序读取所有持久化的记录。
   *
   * 先刷新所有待写入以确保读取者看到最新状态。
   * 逐条返回记录，将每行解析为 JSON。
   * 截断的尾行（来自写入中途的崩溃）被静默跳过。
   */
  async *read(): AsyncIterable<AgentRecord> {
    await this.flush();

    let line = '';
    let lineNumber = 0;
    const stream = createReadStream(this.filePath, { encoding: 'utf8' });
    try {
      for await (const chunk of stream) {
        line += chunk;
        let newlineIndex = line.indexOf('\n');
        while (newlineIndex !== -1) {
          const rawLine = line.slice(0, newlineIndex);
          line = line.slice(newlineIndex + 1);
          lineNumber++;

          const record = parseRecordLine(
            rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine,
            lineNumber,
            this.filePath,
            false,
          );
          if (record !== undefined) yield record;

          newlineIndex = line.indexOf('\n');
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw error;
    }

    if (line.length > 0) {
      lineNumber++;
      const record = parseRecordLine(line, lineNumber, this.filePath, true);
      if (record !== undefined) yield record;
    }
  }

  /**
   * 缓冲一条待异步写入的记录。记录将在下一次刷盘周期刷入磁盘。
   * 如果上次刷盘已失败则立即抛出错误。
   */
  append(input: AgentRecord): void {
    this.throwIfError();
    this.pendingRecords.push(input);
    this.scheduleFlush();
  }

  /**
   * 在下一次刷盘周期用提供的记录替换整个记录文件。文件使用截断模式（`'w'`）而非追加模式，
   * 确保原子替换。
   */
  rewrite(records: readonly AgentRecord[]): void {
    this.throwIfError();
    this.shouldClear = true;
    this.pendingRecords.splice(0, this.pendingRecords.length, ...records);
    this.scheduleFlush();
  }

  /**
   * 等待所有待写入（包括正在进行的刷盘）持久化完成。
   * 重新抛出之前失败刷盘的错误。
   */
  async flush(): Promise<void> {
    this.throwIfError();
    while (
      this.flushPromise !== undefined ||
      this.shouldClear ||
      this.pendingRecords.length > 0
    ) {
      await this.ensureFlush();
      this.throwIfError();
    }
  }

  /** 刷新所有待写入并释放资源。 */
  async close(): Promise<void> {
    await this.flush();
  }

  /** 如果没有正在进行的刷盘则调度一次刷盘周期。 */
  private scheduleFlush(): void {
    void this.ensureFlush().catch((error) => {
      this.options.onError?.(error);
    });
  }

  /**
   * 如果已有正在进行的刷盘则返回其 promise，否则启动新的排空周期并跟踪其 promise。
   */
  private ensureFlush(): Promise<void> {
    if (this.flushPromise !== undefined) return this.flushPromise;

    const promise = this.drainPendingRecords()
      .catch((error: unknown) => {
        this.error = error;
        // oxlint-disable-next-line typescript-eslint/only-throw-error
        throw error;
      })
      .finally(() => {
        if (this.flushPromise === promise) {
          this.flushPromise = undefined;
        }
        if (
          this.error === undefined &&
          (this.shouldClear || this.pendingRecords.length > 0)
        ) {
          this.scheduleFlush();
        }
      });
    this.flushPromise = promise;
    return promise;
  }

  /** 重新抛出之前失败刷盘的存储错误。 */
  private throwIfError(): void {
    // oxlint-disable-next-line typescript-eslint/only-throw-error
    if (this.error !== undefined) throw this.error;
  }

  /** 排空所有待处理批次，直到没有更多记录或清空操作排队。 */
  private async drainPendingRecords(): Promise<void> {
    while (this.shouldClear || this.pendingRecords.length > 0) {
      await this.drainBatch();
    }
  }

  /**
   * 将单批待写入记录写入磁盘。如果设置了 `shouldClear`，写入前先截断文件。
   * 在序列化前可选地通过 {@link BlobStore} 卸载大型媒体载荷。
   *
   * 写入后对文件及其父目录执行 `fsync` 以保证持久性——
   * 不同步目录的话，文件的目录条目在断电后可能不会被持久化。
   */
  private async drainBatch(): Promise<void> {
    const shouldClear = this.shouldClear;
    const batch = this.pendingRecords.splice(0);
    this.shouldClear = false;

    const writable = this.options.blobStore !== undefined
      ? await Promise.all(
          batch.map((record) => this.options.blobStore!.offload(record)),
        )
      : batch;

    const content = writable.map((e) => JSON.stringify(e) + '\n').join('');
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });

    const fh = await open(this.filePath, shouldClear ? 'w' : 'a');
    try {
      if (content.length > 0) {
        await fh.writeFile(content, 'utf8');
      }
      await fh.sync();
    } finally {
      await fh.close();
    }

    if (!this.directorySynced) {
      await syncDir(directory);
      this.directorySynced = true;
    }
  }
}

/**
 * 将 wire.jsonl 文件中的单行 JSON 解析为 {@link AgentRecord}。
 *
 * 对空行或截断的尾行（当 `allowTruncated` 为 `true` 时）返回 `undefined`。
 * 截断的尾行可能在刷盘中途崩溃时出现；其之前的所有内容仍然是完整的。
 *
 * @param line - 原始行内容（不含尾部换行符）。
 * @param lineNumber - 从 1 开始的行号，用于错误报告。
 * @param filePath - 正在解析的文件路径，用于错误报告。
 * @param allowTruncated - 是否容忍最后一行的解析错误。
 * @returns 解析后的记录，对于空行/截断行返回 `undefined`。
 * @throws 如果行是格式错误的 JSON 且 `allowTruncated` 为 `false`。
 */
function parseRecordLine(
  line: string,
  lineNumber: number,
  filePath: string,
  allowTruncated: boolean,
): AgentRecord | undefined {
  if (line.length === 0) return undefined;
  try {
    return JSON.parse(line) as AgentRecord;
  } catch (parseError) {
    // 容忍截断的尾行——上次写入可能在刷盘中途崩溃；
    // 其之前的所有内容仍然是完整的。
    if (allowTruncated) return undefined;
    throw new Error(
      `wire.jsonl: corrupted line ${lineNumber} in ${filePath}: ${String(parseError)}`,
      { cause: parseError },
    );
  }
}
