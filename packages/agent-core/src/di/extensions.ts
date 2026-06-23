/**
 * 模块级全局服务注册表。模块（或顶层文件）通过 `registerSingleton` 在导入时
 * 注册服务实现；守护进程启动时从 `getSingletonServiceDescriptors()` 收集
 * 根 `ServiceCollection` 的种子。
 *
 * 模仿自 VSCode 的 `extensions.ts` — 相同的结构和用途。
 *
 * 注册表结构：`Array<[ServiceIdentifier<any>, SyncDescriptor<any>]>`。每个条目
 * 将 id 与 `SyncDescriptor` 配对，`SyncDescriptor` 捕获构造函数 + 静态参数
 * 以及 `supportsDelayedInstantiation` 标志。注册按原样追加。覆盖语义由
 * 消费注册表的 `ServiceCollection` 阶段决定，与 VS Code 宽松的模块加载
 * 注册表一致。
 */

import { SyncDescriptor } from './descriptors';
import type { BrandedService, ServiceIdentifier } from './instantiation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _registry: Array<[ServiceIdentifier<any>, SyncDescriptor<any>]> = [];

export enum InstantiationType {
  Eager = 0,
  Delayed = 1,
}

/**
 * 在标识符下注册服务实现。通常在模块顶层调用。
 *
 * 支持两种调用形式：
 *
 * - `registerSingleton(id, ctor, instantiationType?)` — 向后兼容的构造函数
 *   重载。内部将 `ctor` 包装为 `new SyncDescriptor(ctor, [],
 *   supportsDelayedInstantiation)`，其中
 *   `supportsDelayedInstantiation = Boolean(instantiationType)`。
 * - `registerSingleton(id, descriptor)` — 描述符重载。按原样存储描述符；
 *   调用方拥有 `staticArguments` 和 `supportsDelayedInstantiation`。
 *
 * 如果 `id` 已被注册，则追加新条目。构建 `ServiceCollection` 的消费者
 * 按插入顺序决定有效绑定。
 */
export function registerSingleton<T, Services extends BrandedService[]>(
  id: ServiceIdentifier<T>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (...services: Services) => T,
  instantiationType?: InstantiationType,
): void;
export function registerSingleton<T>(
  id: ServiceIdentifier<T>,
  descriptor: SyncDescriptor<any>,
): void;
export function registerSingleton<T, Services extends BrandedService[]>(
  id: ServiceIdentifier<T>,
  ctorOrDescriptor:
    | SyncDescriptor<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | (new (...services: Services) => T),
  instantiationType?: boolean | InstantiationType,
): void {
  const descriptor =
    ctorOrDescriptor instanceof SyncDescriptor
      ? ctorOrDescriptor
      : new SyncDescriptor<T>(
          ctorOrDescriptor as new (...args: unknown[]) => T,
          [],
          Boolean(instantiationType),
        );

  _registry.push([id, descriptor]);
}

/**
 * 返回注册表列表，适用于构建 `ServiceCollection`。
 *
 * 结构：`ReadonlyArray<readonly [ServiceIdentifier<any>, SyncDescriptor<any>]>`
 * — 二元组，与 VS Code 的 `getSingletonServiceDescriptors()` 一致。
 * `supportsDelayedInstantiation` 标志在描述符本身上，而非作为注册表的
 * 独立槽位。
 *
 * 返回的数组是活的注册表引用，与 VS Code 一致。
 */
export function getSingletonServiceDescriptors(): ReadonlyArray<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [ServiceIdentifier<any>, SyncDescriptor<any>]
> {
  return _registry;
}

/**
 * 仅用于测试的逃逸口：清空注册表。正式代码绝不能调用此函数 —
 * 模块加载时的注册在进程生命周期内应是永久的。
 */
export function _clearRegistryForTests(): void {
  _registry.length = 0;
}
