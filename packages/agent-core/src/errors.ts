// 桶导出，使 #/errors 解析到单个 .ts 文件（package imports map 中的第一个
// 条目）。vitest 无法正确地通过目录回退解析；这个轻量桶导出让别名在
// node、tsc 和 vitest 之间统一生效。实际模块位于 ./errors 下。
export * from './errors/index';
