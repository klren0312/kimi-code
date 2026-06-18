/**
 * TodoPanel — 在输入区域上方显示的实时更新待办事项列表。
 *
 * 作为专用的 `Container` 插槽挂载在活动面板（旋转器/思考流）和队列/编辑器块之间。
 * 宿主在 LLM 调用 `TodoList` 工具时调用 {@link setTodos}；
 * 状态在各轮次间保持，因此列表会持续可见，直到被显式清除（`todos: []`）、
 * 新会话开始或执行 `/clear` 命令。
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

const MAX_VISIBLE = 5;

export interface VisibleTodos {
  readonly rows: readonly TodoItem[];
  readonly hidden: number;
}

/**
 * 当列表超过 {@link MAX_VISIBLE} 时选择要渲染的待办事项。
 *
 * 选择器与顺序无关——TodoList 工具保持模型产生的任意顺序，
 * 不会按状态分组，因此可能出现 `pending, done, pending, done, ...` 这样的交错序列，
 * 且当数量足够时仍需生成 MAX_VISIBLE 行。
 *
 * 策略：
 * 1. 包含所有 `in_progress` 项目（上限为 MAX_VISIBLE）。
 * 2. 用"接下来做什么"填充剩余槽位——按原始位置取最早的 `pending` 项目，
 *    同时为"刚刚完成"预留一个槽位——取最新的 `done` 项目——当两种都存在时。
 *    如果一侧候选不足，另一侧会扩展。
 *
 * 项目按原始顺序返回。
 */
export function selectVisibleTodos(todos: readonly TodoItem[]): VisibleTodos {
  if (todos.length <= MAX_VISIBLE) {
    return { rows: [...todos], hidden: 0 };
  }

  const inProgress: number[] = [];
  const pending: number[] = [];
  const done: number[] = [];
  for (const [i, todo] of todos.entries()) {
    if (todo.status === 'in_progress') inProgress.push(i);
    else if (todo.status === 'pending') pending.push(i);
    else done.push(i);
  }

  const picked = new Set<number>();
  for (const i of inProgress.slice(0, MAX_VISIBLE)) picked.add(i);

  if (picked.size < MAX_VISIBLE) {
    // 最近完成的优先；最早待办的优先。
    const doneCandidates = done.toReversed();
    const pendingCandidates = pending;

    const remaining = MAX_VISIBLE - picked.size;
    let doneCount: number;
    let pendingCount: number;
    if (doneCandidates.length === 0) {
      doneCount = 0;
      pendingCount = Math.min(remaining, pendingCandidates.length);
    } else if (pendingCandidates.length === 0) {
      pendingCount = 0;
      doneCount = Math.min(remaining, doneCandidates.length);
    } else {
      doneCount = 1;
      pendingCount = Math.min(remaining - 1, pendingCandidates.length);
      if (pendingCount < remaining - 1) {
        doneCount = Math.min(doneCandidates.length, remaining - pendingCount);
      }
    }

    for (let i = 0; i < doneCount; i++) picked.add(doneCandidates[i] as number);
    for (let i = 0; i < pendingCount; i++) picked.add(pendingCandidates[i] as number);
  }

  const sortedIdx = [...picked].toSorted((a, b) => a - b);
  return {
    rows: sortedIdx.map((i) => todos[i] as TodoItem),
    hidden: todos.length - sortedIdx.length,
  };
}

export class TodoPanelComponent implements Component {
  private todos: readonly TodoItem[] = [];

  setTodos(todos: readonly TodoItem[]): void {
    this.todos = todos.map((t) => ({ title: t.title, status: t.status }));
  }

  getTodos(): readonly TodoItem[] {
    return this.todos;
  }

  clear(): void {
    this.todos = [];
  }

  isEmpty(): boolean {
    return this.todos.length === 0;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.todos.length === 0) return [];
    const c = currentTheme.palette;
    const { rows, hidden } = selectVisibleTodos(this.todos);
    const lines: string[] = [
      chalk.hex(c.border)('─'.repeat(width)),
      chalk.hex(c.primary).bold('  Todo'),
    ];
    for (const todo of rows) {
      lines.push(renderRow(todo, c));
    }
    if (hidden > 0) {
      lines.push(chalk.hex(c.textDim)(`  … +${hidden} more`));
    }

    return lines.map((line) => truncateToWidth(line, width));
  }
}

function renderRow(todo: TodoItem, colors: ColorPalette): string {
  const marker = statusMarker(todo.status, colors);
  const titleStyled = styleTitle(todo.title, todo.status, colors);
  return `  ${marker} ${titleStyled}`;
}

function statusMarker(status: TodoStatus, colors: ColorPalette): string {
  switch (status) {
    case 'in_progress':
      return chalk.hex(colors.primary).bold('●');
    case 'done':
      return chalk.hex(colors.success)('✓');
    case 'pending':
      return chalk.hex(colors.textDim)('○');
  }
}

function styleTitle(title: string, status: TodoStatus, colors: ColorPalette): string {
  switch (status) {
    case 'in_progress':
      return chalk.hex(colors.text).bold(title);
    case 'done':
      return chalk.hex(colors.textDim).strikethrough(title);
    case 'pending':
      return chalk.hex(colors.text)(title);
  }
}
