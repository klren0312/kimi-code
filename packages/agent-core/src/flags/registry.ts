import type { FlagDefinitionInput } from './types';

/**
 * 实验性功能标志。
 *
 * 要添加一个标志，追加一个条目，并通过 `KimiCore`、`Session` 或 `Agent`
 * 上的作用域解析器来控制运行时行为：
 *   { id: 'my_feature', title: 'My feature', description: '...', env: 'KIMI_CODE_EXPERIMENTAL_MY_FEATURE', default: false, surface: 'both' }
 *
 * 保留 `as const satisfies`——它派生出字面量 `FlagId` 联合类型，
 * 为 `enabled()` 提供自动补全和拼写检查。`env` 必须以 'KIMI_CODE_EXPERIMENTAL_' 开头，
 * 唯一且不等于主开关 'KIMI_CODE_EXPERIMENTAL_FLAG'；`id` 不能为 'flag'。
 */
export const FLAG_DEFINITIONS = [
  {
    id: 'micro_compaction',
    title: 'Micro compaction',
    description: 'Trim older large tool results from context while keeping recent conversation intact.',
    env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    default: true,
    surface: 'core',
  },
] as const satisfies readonly FlagDefinitionInput[];

/** 已注册标志 id 的字面量联合类型。 */
export type FlagId = (typeof FLAG_DEFINITIONS)[number]['id'];
