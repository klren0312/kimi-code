/**
 * 底层 POSIX 持久化原语。
 *
 * 每次持久化写入需要处理两个问题：
 *   1. 文件*内容*——通过写入后调用 `fh.sync()` 解决
 *   2. 目录*条目*——通过打开父目录并在目录句柄上调用 `fh.sync()` 解决
 *
 * 在文件上调用 `fh.sync()` 并不保证指向该文件的目录条目已被提交。
 * 在 POSIX 上，文件内容 fsync 和父目录 fsync 之间的崩溃可能导致
 * 文件字节已写入磁盘但没有可见名称。主要持久化路径是 POSIX；
 * Windows 采用尽力而为策略——NTFS 的 MoveFileEx 在文件 fsync 内
 * 提交目录条目，因此单独的目录 fsync 是空操作
 *（且 `open(dir, 'r')` 会 EISDIR 失败）。
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'pathe';

/**
 * 以只读方式打开目录并 fsync，然后关闭。用于使新创建或重命名的
 * 文件的目录条目持久化。
 *
 * Windows：空操作。`open(dir, 'r')` 抛出 EISDIR，且 NTFS 在文件
 * fsync 内提交目录条目事务——即使我们能发出单独的目录 fsync 也不会有额外收益。
 */
export async function syncDir(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dirFh = await open(dirPath, 'r');
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}
/**
 * `syncDir` 的同步变体。用于批量排空路径，需要单次定时器触发
 * 作为一个原子事件循环步骤。Windows 与异步变体一致——空操作。
 */
export function syncDirSync(dirPath: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/**
 * 将 `content` 原子且持久化地写入 `filePath`：
 *   1. 将内容写入 `<filePath>.tmp`，fsync，关闭。
 *   2. 重命名 `<filePath>.tmp` → `filePath`（POSIX 上原子操作）。
 *   3. fsync 父目录使重命名持久化。
 *
 * 重命名前的任何失败都会删除 `.tmp` 文件，避免调用方目录留下
 * 写了一半的残留。重命名*之后*的失败（即父目录 fsync 中的失败）
 * 会向调用方报出——内容已就位，但持久化不保证。
 */
export async function writeFileAtomicDurable(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const tmpPath = filePath + '.tmp';
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // Windows 预先删除以与 MoveFileEx 行为一致。
    if (process.platform === 'win32') {
      try {
        await unlink(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
    }
    await rename(tmpPath, filePath);
    renamed = true;
    await syncDir(dirname(filePath));
  } finally {
    if (!renamed) {
      // 如果从未到达重命名步骤，则尽力清理 `.tmp` 文件。
      // 吞掉 ENOENT，因为文件可能不存在（open 本身失败）或已被删除。
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * atomicWrite — 跨平台原子文件替换。
 *
 * 保证读取者不会看到写了一半的文件：
 *   1. 将内容写入同一目录中唯一命名的临时文件。
 *   2. fsync 临时文件使字节持久化。
 *   3. rename(tmp, target)——POSIX 上原子操作。
 *   4. 重命名前的任何失败都删除临时文件（尽力而为）。
 *
 * 不会 fsync 父目录；需要完整 POSIX 崩溃持久化的调用方应在此调用后
 * `await syncDir(dirname(path))`。
 *
 * 不适用于追加写入路径（wire.jsonl）。那些使用 `JournalWriter.append()`
 * 在当前文件位置写入。
 */

/**
 * 使用基于回调的 `fs.fsync` 进行 fsync。我们通过模块命名空间
 * （`nodeFs.fsync`）而非 `FileHandle.sync()`，以便 vitest 的
 * `vi.spyOn(fs, 'fsync')` 能拦截调用进行故障注入测试。
 */
function syncFd(fd: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    nodeFs.fsync(fd, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * 将 `content` 原子写入 `filePath`。如果目标已存在则替换；
 * 如果不存在则创建。
 *
 * @param filePath — 目标文件的绝对或相对路径。
 * @param content  — 要写入的字符串或二进制数据。
 * @param _syncOverride — 测试接口：覆盖 fsync 实现用于故障注入。
 *   生产调用方绝不能提供此参数。
 */
export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
  _syncOverride?: (fd: number) => Promise<void>,
): Promise<void> {
  const hex = randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${hex}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await (_syncOverride ?? syncFd)(fh.fd);
    } finally {
      await fh.close();
    }
    // Windows 的 `fs.rename` 映射到 MoveFileEx，如果目标被另一个句柄
    // 持有则以 EPERM 失败。重命名前预先删除使其变为 POSIX 风格的"替换"情况。
    if (process.platform === 'win32') {
      try {
        await unlink(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
    }
    await rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
        /* 忽略——如果 open 本身失败，文件可能不存在 */
      }
    }
  }
}
