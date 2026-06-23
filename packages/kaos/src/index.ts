/** 文件状态结果类型 */
export type { StatResult } from './types';
/** 进程接口类型 */
export type { KaosProcess } from './process';
/** KAOS 核心接口类型 */
export type { Kaos } from './kaos';
/** 环境探测相关类型 */
export type {
  Environment,
  EnvironmentDeps,
  OsKind,
  ShellName,
} from './environment';
/** 环境探测函数 */
export { detectEnvironment, detectEnvironmentFromNode } from './environment';
/** 错误类型 */
export {
  KaosError,
  KaosValueError,
  KaosFileExistsError,
  KaosShellNotFoundError,
} from './errors';
/** 本地文件系统 Kaos 实现 */
export { LocalKaos } from './local';
/** 基于 AsyncLocalStorage 的当前 Kaos 上下文便捷函数 */
export {
  chdir,
  exec,
  execWithEnv,
  getCurrentKaos,
  getcwd,
  gethome,
  glob,
  iterdir,
  mkdir,
  normpath,
  pathClass,
  readBytes,
  readLines,
  readText,
  runWithKaos,
  setCurrentKaos,
  stat,
  writeBytes,
  writeText,
} from './current';
