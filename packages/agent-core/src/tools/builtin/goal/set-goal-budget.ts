/**
 * SetGoalBudgetTool — 让模型记录用户声明的当前目标硬性运行时限制。
 * 该工具一次接受一个限制，将支持的时间单位转换为毫秒，
 * 并拒绝明显不合理的时间限制。
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { GoalBudgetLimits } from '../../../agent/goal';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './set-goal-budget.md?raw';

const MIN_REASONABLE_TIME_BUDGET_MS = 1_000;
const MAX_REASONABLE_TIME_BUDGET_MS = 24 * 60 * 60 * 1000;
const BUDGET_UNITS = ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours'] as const;

export const SetGoalBudgetToolInputSchema = z
  .object({
    // 保持面向 provider 的 schema 简单。分数轮次/token 预算在执行期间
    // 规范化而非在 schema 验证时拒绝。
    value: z.number().positive().describe('The positive numeric budget value.'),
    unit: z.enum(BUDGET_UNITS),
  })
  .strict();

export type SetGoalBudgetToolInput = z.infer<typeof SetGoalBudgetToolInputSchema>;

export class SetGoalBudgetTool implements BuiltinTool<SetGoalBudgetToolInput> {
  readonly name = 'SetGoalBudget' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SetGoalBudgetToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: SetGoalBudgetToolInput): ToolExecution {
    const goal = this.agent.goal;

    const normalizedArgs = normalizeBudgetInput(args);
    return {
      description: `Setting goal budget: ${formatBudget(
        normalizedArgs.value,
        normalizedArgs.unit,
      )}`,
      approvalRule: this.name,
      execute: async () => {
        const budget = budgetLimitsFromInput(normalizedArgs);
        if (budget === null) {
          return {
            output:
              `Goal budget not set: ${formatBudget(normalizedArgs.value, normalizedArgs.unit)} is not a ` +
              'reasonable goal budget.',
          };
        }
        await goal.setBudgetLimits({ budgetLimits: budget }, 'model');
        return {
          output: `Goal budget set: ${formatBudget(normalizedArgs.value, normalizedArgs.unit)}.`,
        };
      },
    };
  }
}

function normalizeBudgetInput(input: SetGoalBudgetToolInput): SetGoalBudgetToolInput {
  switch (input.unit) {
    case 'turns':
    case 'tokens':
      return { ...input, value: Math.max(1, Math.round(input.value)) };
    case 'milliseconds':
    case 'seconds':
    case 'minutes':
    case 'hours':
      return input;
  }
}

function budgetLimitsFromInput(input: SetGoalBudgetToolInput): GoalBudgetLimits | null {
  switch (input.unit) {
    case 'turns':
      return { turnBudget: input.value };
    case 'tokens':
      return { tokenBudget: input.value };
    case 'milliseconds':
    case 'seconds':
    case 'minutes':
    case 'hours': {
      const wallClockBudgetMs = Math.round(toMilliseconds(input.value, input.unit));
      if (
        wallClockBudgetMs < MIN_REASONABLE_TIME_BUDGET_MS ||
        wallClockBudgetMs > MAX_REASONABLE_TIME_BUDGET_MS
      ) {
        return null;
      }
      return { wallClockBudgetMs };
    }
  }
}

function toMilliseconds(
  value: number,
  unit: Extract<SetGoalBudgetToolInput['unit'], 'milliseconds' | 'seconds' | 'minutes' | 'hours'>,
): number {
  switch (unit) {
    case 'milliseconds':
      return value;
    case 'seconds':
      return value * 1000;
    case 'minutes':
      return value * 60 * 1000;
    case 'hours':
      return value * 60 * 60 * 1000;
  }
}

function formatBudget(value: number, unit: SetGoalBudgetToolInput['unit']): string {
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  return `${String(value)} ${value === 1 ? singular : unit}`;
}
