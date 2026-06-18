/**
 * MCP OAuth 提供方使用的小型原子 JSON 文件存储，用于在
 * `<KIMI_CODE_HOME>/credentials/mcp/`（默认 `~/.kimi-code/credentials/mcp/`）
 * 下持久化 token、注册的客户端信息和发现状态。
 *
 * 写入语义：写入 `<file>.tmp.<pid>.<rand>` → fsync → 重命名。
 * 在 POSIX 上原子操作；在 Windows 上尽力而为。文件模式为 0600（父目录 0700），
 * 以防止其他本地用户读取 token。
 *
 * 读取语义：文件不存在 → undefined。损坏的 JSON / 错误的形状 → undefined（不抛出异常）。
 * 提供方将 undefined 视为"未存储"。
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'pathe';

export function mcpCredentialsDir(kimiHomeDir: string): string {
  return join(kimiHomeDir, 'credentials', 'mcp');
}

export function defaultMcpCredentialsDir(): string {
  return mcpCredentialsDir(join(homedir(), '.kimi-code'));
}

export function sanitizeStoreKey(name: string): string {
  // 删除路径遍历段。token 存储在 `<key>-<suffix>.json` 下，
  // 因此清理后的值也必须是单个文件名组件。
  const safe = basename(name).replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
  if (safe.length === 0 || safe.startsWith('.')) {
    throw new Error(`Invalid MCP OAuth store key: "${name}"`);
  }
  return safe;
}

export function canonicalMcpOAuthResource(serverUrl: string | URL): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return url.toString();
}

export function mcpOAuthStoreKey(serverName: string, serverUrl: string | URL): string {
  const safeName = sanitizeStoreKey(serverName);
  const resource = canonicalMcpOAuthResource(serverUrl);
  const digest = createHash('sha256')
    .update(serverName)
    .update('\0')
    .update(resource)
    .digest('hex')
    .slice(0, 24);
  return `${safeName}-${digest}`;
}

export class JsonFileStore {
  private readonly dir: string;

  constructor(dir: string = defaultMcpCredentialsDir()) {
    this.dir = dir;
  }

  read<T>(file: string): T | undefined {
    const path = join(this.dir, file);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  write(file: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // 尽力而为；Windows / 只读文件系统可能拒绝
    }
    const target = join(this.dir, file);
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    const buf = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    const fd = openSync(tmp, 'w', 0o600);
    try {
      let written = 0;
      while (written < buf.length) {
        written += writeSync(fd, buf, written, buf.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  remove(file: string): void {
    try {
      unlinkSync(join(this.dir, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
