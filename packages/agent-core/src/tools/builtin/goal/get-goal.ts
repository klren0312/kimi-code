/**
 * GetGoalTool — 返回当前目标快照（目标、状态、预算和使用计数器），
 * 以便模型决定是继续、通过 UpdateGoal 报告完成、报告阻塞，
 * 还是尊重暂停状态。
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './get-goal.md?raw';

export const GetGoalToolInputSchema = z.object({}).strict();
export type GetGoalToolInput = z.infer<typeof GetGoalToolInputSchema>;

export class GetGoalTool implements BuiltinTool<GetGoalToolInput> {
  readonly name = 'GetGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetGoalToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(_args: GetGoalToolInput): ToolExecution {
    const store = this.agent.goal;
    return {
      description: 'Reading the current goal',
      approvalRule: this.name,
      execute: async () => {
        const result = store.getGoal();
        return { output: JSON.stringify(result, null, 2) };
      },
    };
  }
}
