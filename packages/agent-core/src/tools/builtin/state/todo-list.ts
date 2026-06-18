/**
 * TodoListTool — 结构化 TODO 列表管理工具。
 *
 * LLM 使用此工具在 plan-mode 工作流和多步骤操作中维护一个可见的
 * 子任务计划。单个工具同时支持读取和写入：
 *
 *   - `resolveExecution({ todos: [...] })` — 替换完整列表
 *   - `resolveExecution({ todos: [] })`    — 清空列表
 *   - `resolveExecution({})`               — 查询当前列表（不修改）
 *
 * 存储：todos 保存在 agent 级别的工具存储中。写入通过
 * `tools.update_store` 进行，因此存储更新在 wire replay 中可见。
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ToolStore } from '../../store';
import DESCRIPTION from './todo-list.md?raw';

// ── TODO 状态结构 ─────────────────────────────────────────────────

export const TODO_LIST_TOOL_NAME = 'TodoList' as const;
export const TODO_STORE_KEY = 'todo';
const TODO_LIST_WRITE_REMINDER =
  'Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

declare module '../../store' {
  interface ToolStoreData {
    todo: readonly TodoItem[];
  }
}

// ── Schema 定义 ───────────────────────────────────────────────────────────

const TodoItemSchema = z.object({
  title: z.string().min(1).describe('Short, actionable title for the todo.'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('Current status of the todo.'),
});

export interface TodoListInput {
  todos?: Array<{ title: string; status: TodoStatus }>;
}

export const TodoListInputSchema: z.ZodType<TodoListInput> = z.object({
  todos: z
    .array(TodoItemSchema)
    .optional()
    .describe(
      'The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.',
    ),
});

// ── 实现 ───────────────────────────────────────────────────

export function renderTodoList(todos: readonly TodoItem[], title = 'Current todo list:'): string {
  if (todos.length === 0) {
    return 'Todo list is empty.';
  }
  const lines = todos.map((t) => {
    const marker = statusMarker(t.status);
    return `  ${marker} ${t.title}`;
  });
  return [title, ...lines].join('\n');
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'pending':
      return '[pending]';
    case 'in_progress':
      return '[in_progress]';
    case 'done':
      return '[done]';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export class TodoListTool implements BuiltinTool<TodoListInput> {
  readonly name = TODO_LIST_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TodoListInputSchema);

  constructor(private readonly store: ToolStore) {}

  resolveExecution(args: TodoListInput): ToolExecution {
    const description =
      args.todos === undefined
        ? 'Reading todo list'
        : args.todos.length === 0
          ? 'Clearing todo list'
          : 'Updating todo list';
    return {
      description,
      approvalRule: this.name,
      execute: async () => {
        // 查询模式 — 返回当前列表，不修改。
        if (args.todos === undefined) {
          const current = this.getTodos();
          return { isError: false, output: renderTodoList(current) };
        }

        // 写入模式 — 替换完整列表并返回新状态。
        this.setTodos(args.todos);
        const stored = this.getTodos();
        const output =
          stored.length === 0
            ? 'Todo list cleared.'
            : `Todo list updated.\n${renderTodoList(stored)}\n\n${TODO_LIST_WRITE_REMINDER}`;
        return { isError: false, output };
      },
    };
  }

  private getTodos(): readonly TodoItem[] {
    const todos = this.store.get(TODO_STORE_KEY);
    return todos ?? [];
  }

  private setTodos(todos: readonly TodoItem[]): void {
    this.store.set(
      TODO_STORE_KEY,
      todos.map((todo) => ({ title: todo.title, status: todo.status })),
    );
  }
}
