/**
 * `IEnvironmentService` — daemon 和进程内服务使用的文件系统路径解析的权威来源
 *（home 目录、配置文件等）。
 *
 * VSCode 风格：通过 `@IEnvironmentService` 注入，而非作为静态 options 前缀传入。
 * 这消除了仅需要路径解析的服务中"options bag 作为构造函数第一个参数"的模式。
 */

import { createDecorator } from '../../di';

export interface IEnvironmentService {
  readonly _serviceBrand: undefined;
  /** 已解析的 kimi home 目录（例如 `~/.kimi-code`）。 */
  readonly homeDir: string;
  /** 已解析的 `config.toml` 绝对路径。 */
  readonly configPath: string;
}

export const IEnvironmentService = createDecorator<IEnvironmentService>(
  'environmentService',
);
