/**
 * 待办列表提醒注入器。
 *
 * 在长时间多步骤任务中，周期性地提示模型更新 TodoList 工具。仅当过期阈值
 * （自上次写入以来的轮次）和冷却期（自上次提醒以来的轮次）均被超过时才触发，
 * 以避免不必要的中断。
 *
 * @module todo-list
 */

import type { ContextMessage } from '#/agent/context';
import {
  TODO_LIST_TOOL_NAME,
  TODO_STORE_KEY,
  type TodoItem,
  type TodoStatus,
} from '#/tools/builtin/state/todo-list';

import { DynamicInjector } from './injector';

/**
 * 待办列表提醒消息的注入变体标签，用于计算自上次提醒以来的轮次时进行去重。
 */
const TODO_LIST_REMINDER_VARIANT = 'todo_list_reminder';

/** 自上次 TodoList 写入以来允许触发提醒的最少助手轮次。 */
const TODO_LIST_REMINDER_TURNS_SINCE_WRITE = 10;

/** 自上次提醒注入以来允许再次触发的最少助手轮次。 */
const TODO_LIST_REMINDER_TURNS_BETWEEN_REMINDERS = 10;

/**
 * 用于决定是否触发待办列表提醒的轮次计数。
 * 两个计数器必须分别超过各自的阈值才会注入提醒。
 */
interface TodoListReminderTurnCounts {
  readonly turnsSinceLastWrite: number;
  readonly turnsSinceLastReminder: number;
}

/**
 * 注入周期性提醒以更新 TodoList 工具。
 *
 * 仅当 TodoList 工具处于活跃状态 *且* 以下两个条件同时满足时才触发：
 * - 自模型上次调用 TodoList 工具以来，至少经过了
 *   {@link TODO_LIST_REMINDER_TURNS_SINCE_WRITE} 个助手轮次。
 * - 自上次提醒注入以来，至少经过了
 *   {@link TODO_LIST_REMINDER_TURNS_BETWEEN_REMINDERS} 个助手轮次。
 *
 * 该节奏在避免频繁打扰模型的同时，确保在长时间多步骤任务中
 * 待办列表保持合理的更新。
 */
export class TodoListReminderInjector extends DynamicInjector {
  protected override readonly injectionVariant = TODO_LIST_REMINDER_VARIANT;

  /**
   * 如果待办列表已过期，返回温和提醒；如果未达到节奏阈值或工具未激活，
   * 返回 `undefined`。
   */
  protected override getInjection(): string | undefined {
    if (!this.isTodoListActive()) return undefined;

    const counts = getTodoListReminderTurnCounts(this.agent.context.history);
    if (
      counts.turnsSinceLastWrite < TODO_LIST_REMINDER_TURNS_SINCE_WRITE ||
      counts.turnsSinceLastReminder < TODO_LIST_REMINDER_TURNS_BETWEEN_REMINDERS
    ) {
      return undefined;
    }

    return renderTodoListReminder(this.currentTodos());
  }

  /** 检查 TodoList 工具是否当前已注册并对此代理处于活跃状态。 */
  private isTodoListActive(): boolean {
    return this.agent.tools.data().some((tool) => {
      return tool.name === TODO_LIST_TOOL_NAME && tool.active;
    });
  }

  /** 从代理的工具数据存储中读取当前待办事项。 */
  private currentTodos(): readonly TodoItem[] {
    const raw = this.agent.tools.storeData()[TODO_STORE_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter(isTodoItem).map((todo) => ({
      title: todo.title,
      status: todo.status,
    }));
  }
}

/**
 * 从对话历史中反向遍历，计算自上次 TodoList 工具写入和上次提醒注入以来的
 * 助手轮次。找到两者后提前终止。
 */
function getTodoListReminderTurnCounts(
  history: readonly ContextMessage[],
): TodoListReminderTurnCounts {
  let foundWrite = false;
  let foundReminder = false;
  let turnsSinceLastWrite = 0;
  let turnsSinceLastReminder = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message === undefined) continue;

    if (message.role === 'assistant') {
      if (!foundWrite && hasTodoListWrite(message)) {
        foundWrite = true;
      }
      if (!foundWrite) turnsSinceLastWrite += 1;
      if (!foundReminder) turnsSinceLastReminder += 1;
      continue;
    }

    if (!foundReminder && isTodoListReminder(message)) {
      foundReminder = true;
    }

    if (foundWrite && foundReminder) break;
  }

  return {
    turnsSinceLastWrite,
    turnsSinceLastReminder,
  };
}

/** 检查助手消息是否包含带 `todos` 数组参数的 TodoList 写入调用。 */
function hasTodoListWrite(message: ContextMessage): boolean {
  return message.toolCalls.some((toolCall) => {
    if (toolCall.name !== TODO_LIST_TOOL_NAME) return false;
    if (typeof toolCall.arguments !== 'string') return false;

    try {
      const args = JSON.parse(toolCall.arguments) as { todos?: unknown };
      return Array.isArray(args.todos);
    } catch {
      return false;
    }
  });
}

/** 检查上下文消息是否为之前注入的待办列表提醒。 */
function isTodoListReminder(message: ContextMessage): boolean {
  return (
    message.origin?.kind === 'injection' && message.origin.variant === TODO_LIST_REMINDER_VARIANT
  );
}

/** 构建提醒消息，如果有待办事项则可选地追加当前待办列表。 */
function renderTodoListReminder(todos: readonly TodoItem[]): string {
  let message =
    'The TodoList tool has not been updated recently. If you are working on tasks that benefit from progress tracking, consider using TodoList to update task status. Also consider clearing or rewriting the todo list if it has become stale and no longer matches the current work. Only use it if relevant. This is a gentle reminder; ignore it if not applicable. Make sure that you NEVER mention this reminder to the user.';

  const items = renderTodoItems(todos);
  if (items.length > 0) {
    message += `\n\nCurrent todo list:\n${items}`;
  }

  return message;
}

/** 将待办事项渲染为带状态指示器的编号列表。 */
function renderTodoItems(todos: readonly TodoItem[]): string {
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.title}`).join('\n');
}

/** 类型守卫：检查未知值是否具有 {@link TodoItem} 的结构。 */
function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['title'] === 'string' && isTodoStatus(record['status']);
}

/** 类型守卫：检查值是否为有效的 {@link TodoStatus}。 */
function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'done';
}
