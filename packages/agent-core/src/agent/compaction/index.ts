/**
 * @module compaction
 *
 * 压缩子系统的公共 barrel 导出。重新导出完整压缩（基于 LLM）和微压缩
 * （工具结果截断）实现、控制压缩何时触发的策略抽象，
 * 以及两条路径共享的类型。
 */

export * from './full';
export * from './micro';
export * from './strategy';
export * from './types';
