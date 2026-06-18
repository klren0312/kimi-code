/**
 * `ServiceCollection` 是用于种子化 `InstantiationService` 的无序映射，
 * 映射关系为 服务标识符 → (描述符 | 实例)。它是对 `Map` 的轻量包装，
 * 值类型为 `SyncDescriptor<T> | T` — 容器通过 `instanceof SyncDescriptor`
 * 决定取哪个。
 */

import type { SyncDescriptor } from './descriptors';
import type { ServiceIdentifier } from './instantiation';

export class ServiceCollection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _entries = new Map<ServiceIdentifier<any>, unknown>();

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...entries: ReadonlyArray<readonly [ServiceIdentifier<any>, unknown]>
  ) {
    for (const [id, value] of entries) {
      this._entries.set(id, value);
    }
  }

  /**
   * 设置一个条目。返回之前的值（如果该 id 之前未设置则返回 `undefined`）。
   */
  set<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: T | SyncDescriptor<T>,
  ): T | SyncDescriptor<T> | undefined {
    const prev = this._entries.get(id);
    this._entries.set(id, instanceOrDescriptor);
    return prev as T | SyncDescriptor<T> | undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  has(id: ServiceIdentifier<any>): boolean {
    return this._entries.has(id);
  }

  get<T>(id: ServiceIdentifier<T>): T | SyncDescriptor<T> | undefined {
    return this._entries.get(id) as T | SyncDescriptor<T> | undefined;
  }

  /** 遍历所有条目。顺序为插入顺序（Map 语义）。 */
  forEach(
    callback: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      id: ServiceIdentifier<any>,
      value: unknown,
    ) => void,
  ): void {
    this._entries.forEach((value, id) => callback(id, value));
  }
}
