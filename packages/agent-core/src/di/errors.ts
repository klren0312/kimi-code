/**
 * DI 子系统抛出的错误。
 */

import type { Graph } from './graph';

/**
 * 当容器检测到依赖图中存在循环时抛出。
 *
 * 支持两种构造形式：
 *
 *  1. **`path: string[]` 形式** — 用于 `_getOrCreateInstance` 内部的线性
 *     `_inProgress` 树栈检查。这是最初的栈检查形式。path 是检测到循环时的
 *     构造栈，按构造顺序排列（根 → ... → 重复的 id）。
 *     重复的 id 出现在两端，使循环一目了然。
 *
 *  2. **`Graph<any>` 形式** — 用于基于图的
 *     `_createAndCacheServiceInstance`。path 通过 `graph.findCycleSlow()`
 *     延迟计算。如果循环查找器返回 `undefined`，则回退为转储整个图，
 *     以便仍然可以诊断故障。
 *
 * 两种形式都暴露 `path: ReadonlyArray<string>`，因此现有的调用点（和测试）
 * 继续正常工作。对于 Graph 形式，`path` 数组是 `[graph.findCycleSlow()]`
 * 按 `' -> '` 分割的结果，这样相同的数据结构就可用了；这避免了强制调用方
 * 根据构建错误的形式进行分支判断。
 */
export class CyclicDependencyError extends Error {
  readonly path: ReadonlyArray<string>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(pathOrGraph: ReadonlyArray<string> | Graph<any>) {
    if (Array.isArray(pathOrGraph)) {
      const path = pathOrGraph as ReadonlyArray<string>;
      super(`Cyclic DI dependency detected: ${path.join(' → ')}`);
      this.path = path;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const graph = pathOrGraph as Graph<any>;
      const cycle = graph.findCycleSlow();
      const detail = cycle ?? `UNABLE to detect cycle, dumping graph:\n${graph.toString()}`;
      super(`cyclic dependency between services: ${detail}`);
      // 为直接读取 `.path` 的调用方提供结构化的路径。
      // `findCycleSlow` 格式为 `A -> B -> A`；将其拆分为各个段。
      this.path = cycle ? cycle.split(' -> ') : [];
    }
    this.name = 'CyclicDependencyError';
  }
}
