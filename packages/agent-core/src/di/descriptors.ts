/**
 * 服务描述符：`SyncDescriptor` 将构造函数和静态参数打包，供容器延迟实例化。
 * 模仿自 VSCode 的 `SyncDescriptor`。
 */

/**
 * 包装一个构造函数及可选的静态参数。容器从 `ServiceCollection` 中获取
 * `SyncDescriptor`（而非已构建的实例），在首次 `get` 时进行构造。
 */
export class SyncDescriptor<T> {
  // 与 VSCode 一致：构造函数参数为调用者提供类型，而存储的 ctor 是
  // 运行时元数据，由 DI 内部消费。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly ctor: any;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctor: new (...args: any[]) => T,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public readonly staticArguments: ReadonlyArray<any> = [],
    public readonly supportsDelayedInstantiation: boolean = false,
  ) {
    this.ctor = ctor;
  }
}

export interface SyncDescriptor0<T> {
  readonly ctor: new () => T;
}
