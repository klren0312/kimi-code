import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'pathe';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { ExportSessionManifest } from '#/rpc/core-api';
import { ZipFile } from 'yazl';

export async function collectFilesRecursive(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export type ExtraZipEntry =
  | {
      /** 磁盘上的绝对路径。 */
      readonly source: string;
      /** zip 内相对目标路径。 */
      readonly target: string;
    }
  | {
      readonly data: Buffer;
      /** zip 内相对目标路径。 */
      readonly target: string;
    };

export async function writeExportZip(args: {
  readonly outputPath: string;
  readonly manifest: ExportSessionManifest;
  readonly sessionDir: string;
  readonly sessionFiles: readonly string[];
  readonly extraEntries?: readonly ExtraZipEntry[];
}): Promise<readonly string[]> {
  await mkdir(dirname(args.outputPath), { recursive: true });

  const entries: string[] = ['manifest.json'];
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(args.manifest, null, 2), 'utf-8'), 'manifest.json');

  for (const abs of args.sessionFiles) {
    const rel = relative(args.sessionDir, abs).split(/[\\/]/).join('/');
    const data = await readFile(abs);
    zip.addBuffer(data, rel);
    entries.push(rel);
  }

  for (const extra of args.extraEntries ?? []) {
    try {
      const data = 'data' in extra ? extra.data : await readFile(extra.source);
      zip.addBuffer(data, extra.target);
      entries.push(extra.target);
    } catch {
      // 源文件缺失不是致命错误——调用方已决定将其作为可选项；
      // 不应中止整个导出过程。
    }
  }

  zip.end();
  await pipeline(zip.outputStream as unknown as Readable, createWriteStream(args.outputPath));
  return entries;
}
