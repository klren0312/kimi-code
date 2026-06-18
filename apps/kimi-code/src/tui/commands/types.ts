import type { AutocompleteItem, SlashCommand } from '@earendil-works/pi-tui';
import type { FlagId } from '@moonshot-ai/kimi-code-sdk';

export type SlashCommandAvailability = 'always' | 'idle-only';

export interface KimiSlashCommand<Name extends string = string> extends SlashCommand {
  readonly name: Name;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly priority?: number;
  readonly availability?: SlashCommandAvailability | ((args: string) => SlashCommandAvailability);
  /** 设置后，该命令将从命令面板中隐藏，除非启用此实验性标志，否则无法使用。 */
  readonly experimentalFlag?: FlagId;
  /**
   * 通用参数自动补全。`argumentPrefix` 是在 `/<command> ` 之后输入的文本；
   * 返回建议列表或 `null`。声明为普通函数属性（而非方法），
   * 以便传递时不依赖 `this`。在自动补全设置中适配 pi-tui 的 `getArgumentCompletions`。
   */
  readonly completeArgs?: (argumentPrefix: string) => AutocompleteItem[] | null;
}

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashCommandBusyReason = 'streaming' | 'compacting';

export type SlashCommandInvalidReason = 'unknown';
