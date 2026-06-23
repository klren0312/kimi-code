/**
 * WorkspaceConfig — 定义工具允许访问的根目录。
 *
 * 通过每个 Tool 的构造函数注入，不通过 Runtime 传递：
 * Runtime 保持固定的小结构，工作区限制在 Tool 侧管理。
 *
 * 路径应已完成词法规范化（绝对路径 + 标准化）；
 * 调用方负责在构造此配置前进行规范化。
 */

export interface WorkspaceConfig {
  /** 主工作区目录（绝对路径，已规范化）。 */
  readonly workspaceDir: string;
  /** 额外允许的根目录（如 `--add-dir` CLI 参数）。 */
  readonly additionalDirs: readonly string[];
}
