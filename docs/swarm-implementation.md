# AgentSwarm 实现原理

## 概述

AgentSwarm 是 Kimi Code CLI 的核心并行能力，允许主 Agent 在一个 turn 内同时派生多个子 Agent（Subagent），各自独立执行任务，最终汇总结果返回给主 Agent。

**核心流程：** 主 Agent 调用 `AgentSwarm` 工具 → 进入 Swarm 模式 → 批量派生子 Agent → 子 Agent 并行执行 → 结果聚合 → 退出 Swarm 模式 → 主 Agent 基于结果继续。

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                        Agent (主)                            │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              SwarmMode (状态机)                       │   │
│  │  manual / task / tool                                │   │
│  └──────────────────────────────────────────────────────┘   │
│                              │                               │
│                    AgentSwarm 工具                           │
│                              │                               │
│         ┌────────────────────┼────────────────────┐          │
│         ▼                    ▼                    ▼          │
│  ┌──────────┐          ┌──────────┐          ┌──────────┐   │
│  │ Subagent │          │ Subagent │          │ Subagent │   │
│  │  #1      │          │  #2      │          │  #N      │   │
│  │ (coder)  │          │ (explore)│          │ (plan)   │   │
│  └──────────┘          └──────────┘          └──────────┘   │
│         │                    │                    │           │
│         └────────────────────┼────────────────────┘           │
│                              ▼                               │
│                    结果聚合 (XML)                              │
│                              │                               │
│                      主 Agent 继续                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、触发方式

Swarm 有三种触发模式（`SwarmModeTrigger`），定义在 `packages/agent-core/src/agent/swarm/index.ts`：

| 触发方式 | 值 | 说明 | 自动退出 |
|---------|------|------|---------|
| 手动 | `manual` | `/swarm on` 命令，持久开启 | 否 |
| 一次性任务 | `task` | `/swarm <prompt>`，单次 turn 后退出 | 是 |
| 工具调用 | `tool` | 直接调用 `AgentSwarm` 工具 | 是 |

### 触发路径 A：`/swarm` 斜杠命令

1. 用户输入 `/swarm 分析这些文件`
2. `apps/kimi-code/src/tui/commands/swarm.ts` 设置 `swarmMode = { enabled: true, trigger: 'task' }`
3. 发送用户 prompt 给模型
4. 模型收到 swarm 系统提醒后，决定调用 `AgentSwarm` 工具

### 触发路径 B：模型直接调用 AgentSwarm 工具

1. Swarm 模式已通过 `/swarm on` 开启
2. 模型在 turn 中直接生成 `AgentSwarm` 工具调用
3. 工具执行 → 派生子 Agent → 聚合结果 → 返回给模型

---

## 三、核心组件

### 3.1 AgentSwarm 工具

**文件：** `packages/agent-core/src/tools/builtin/collaboration/agent-swarm.ts`

这是 Swarm 的入口点，一个内置工具（`BuiltinTool`）。

#### 输入参数（Zod Schema 校验）

```typescript
{
  description: string;           // 必填，Swarm 简要描述
  subagent_type: string;         // 可选，默认 'coder'
  prompt_template: string;       // 当 items 提供时必填，含 {{item}} 占位符
  items: string[];               // 可选，最多 128 项，每项派生一个子 Agent
  resume_agent_ids: Record;      // 可选，恢复已有子 Agent
}
```

#### 执行流程

```
execution()
  ├─ swarmMode.enter('tool')           // 进入 Swarm 模式
  ├─ runSwarm()
  │   ├─ createAgentSwarmSpecs()       // 验证输入，构建 Spec 列表
  │   │   ├─ 校验最少 2 个 items（或有 resume）
  │   │   ├─ 校验最多 128 个子 Agent
  │   │   ├─ 校验 prompt_template 包含 {{item}} 占位符
  │   │   ├─ 校验所有生成的 prompt 不重复
  │   │   └─ 恢复的 Agent 排在前面（优先级：resume > spawn）
  │   ├─ 将 Spec 转为 QueuedSubagentTask[]
  │   │   ├─ kind: 'spawn' 或 'resume'
  │   │   ├─ 设置 profileName、parentToolCallId、signal、timeout 等
  │   │   └─ 默认 timeout: 30 分钟
  │   └─ subagentHost.runQueued(tasks)  // 批量执行
  │       └─ SubagentBatch.run()       // 调度器
  ├─ renderSwarmResults()              // 生成 XML 结果
  └─ 返回 output                       // 自动 exit（trigger='tool'）
```

#### 结果渲染

子 Agent 完成后，结果被格式化为 XML：

```xml
<agent_swarm_result>
  <summary>completed: 3, failed: 1</summary>
  <subagent outcome="completed" agent_id="agent-5">
    子 Agent #1 的完成摘要
  </subagent>
  <subagent outcome="failed" agent_id="agent-6">
    错误信息
  </subagent>
  <subagent outcome="aborted" state="not_started">
    未启动即被中止
  </subagent>
</agent_swarm_result>
```

---

### 3.2 SubagentBatch 调度器

**文件：** `packages/agent-core/src/session/subagent-batch.ts`

这是 Swarm 的核心调度引擎，负责管理并发、限流、退避。

#### 正常阶段（Normal Phase）

```
时间轴:
0ms     ━━━ 启动前 5 个任务（并行）
        [T1] [T2] [T3] [T4] [T5]
        
700ms   ━━━ 再启动 1 个
        [T1] [T2] [T3] [T4] [T5] [T6]

1400ms  ━━━ 再启动 1 个
        [T1] [T2] [T3] [T4] [T5] [T6] [T7]
        ...
```

- 初始并发上限：5 个
- 之后每 700ms 启动 1 个（只要队列中还有待处理任务）
- 可通过环境变量 `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` 设置硬性上限

#### 速率限制阶段（Rate-Limit Phase）

当 Provider 返回速率限制错误时自动进入：

```
触发条件: 首次 provider 速率限制

行为:
├─ 暂停正常启动节奏
├─ 保存失败的 agentId（同 Agent 重试优化）
├─ 指数退避重试: 3s → 6s → 12s → 24s → ...
├─ 容量逐次缩减（每 2s 最多缩 1 次）
└─ 每 3 分钟无速率限制 → 容量 +1（恢复）

每个 tick 只启动 1 个任务
```

#### 任务状态机

```
pending → queued → running → completed / failed / cancelled
                                    ↑
                              (suspended: 速率限制暂挂)
```

- **pending**: 输入尚未完全解析（流式参数时）
- **queued**: 等待调度器分配执行 slot
- **running**: 子 Agent 已启动，正在执行
- **completed**: 成功完成
- **failed**: 执行失败（错误、超时、速率限制且为唯一未完成任务）
- **cancelled**: 用户主动中止

#### 取消处理

- **用户取消**：保留已有结果，将未启动任务标记为 `aborted/not_started`，将已启动任务标记为 `aborted/started`
- **非用户取消**：整个批次失败（reject Promise）

---

### 3.3 SessionSubagentHost

**文件：** `packages/agent-core/src/session/subagent-host.ts`

负责实际创建和运行子 Agent。

#### 三种操作

| 方法 | 说明 |
|------|------|
| `spawn()` | 创建全新的子 Agent |
| `resume()` | 恢复已存在的子 Agent（从历史继续） |
| `retry()` | 重试已失败的子 Agent（速率限制后） |

#### spawn 详细流程

```
spawn(options)
  ├─ session.ensureAgentResumed(ownerAgentId)    // 获取父 Agent
  ├─ resolveProfile(parent, options.profileName) // 查找 profile 配置
  ├─ session.createAgent({ type: 'sub', ... })   // 创建子 Agent 实例
  │   └─ 传入 parentAgentId, swarmItem
  ├─ runWithActiveChild(childId, ...)             // 注册到 activeChildren
  │   ├─ emitSubagentSpawned(...)                 // 发出 subagent.spawned 事件
  │   ├─ configureChild(parent, child, profile)   // 配置子 Agent
  │   │   ├─ 继承 modelAlias, thinkingLevel, cwd
  │   │   ├─ 使用 profile 的系统提示词
  │   │   ├─ 继承用户的工具列表
  │   │   └─ 注入系统提醒（禁止调用工具等）
  │   └─ runPromptTurn(parent, child, ...)        // 执行 turn
  │       ├─ triggerSubagentStart(hook)
  │       ├─ child.turn.prompt([prompt])
  │       └─ waitForChildCompletion(parent, child, ...)
  │           ├─ runChildTurnToCompletion(child)   // 等待 turn 完成
  │           ├─ 检查摘要长度 < 200 字符时追问展开
  │           │   └─ 最多追问 1 次 (SUMMARY_CONTINUATION_ATTEMPTS)
  │           └─ emitSubagentCompleted(...)        // 发出完成事件
  └─ { agentId, profileName, resumed: false, completion }
```

#### 子 Agent 配置继承

子 Agent 继承父 Agent 的：
- 模型 (`modelAlias`)
- 思考等级 (`thinkingLevel`)
- 工作目录 (`cwd`)
- 用户工具列表 (`inheritUserTools`)
- 会话上下文（投影历史 `useProjectedHistoryFrom`）

子 Agent **不继承**：
- 权限策略（使用 `DenyAllPermissionPolicy`）
- 工具调用能力（side-question 场景下禁止）

---

## 四、TUI 侧渲染

### 4.1 事件路由

**文件：** `apps/kimi-code/src/tui/controllers/session-event-handler.ts`

SDK 发出的所有事件统一由 `SessionEventHandler.handleEvent()` 路由：

```
handleEvent(event)
  ├─ subAgentEventHandler.routeChildAgentEvent(event)  // 子 Agent 事件优先
  │   └─ 如果是子 Agent 的事件 → 直接处理并 return true
  │
  └─ switch (event.type)
      ├─ subagent.spawned / started / suspended / completed / failed
      │   └─ subAgentEventHandler.handleLifecycleEvent()
      ├─ tool.call.started (name === 'AgentSwarm')
      │   └─ subAgentEventHandler.handleAgentSwarmToolCallStarted()
      ├─ tool.call.delta
      │   └─ subAgentEventHandler.handleAgentSwarmToolCallDelta()
      └─ tool.result
          └─ subAgentEventHandler.handleAgentSwarmToolResult()
```

### 4.2 SubAgentEventHandler

**文件：** `apps/kimi-code/src/tui/controllers/subagent-event-handler.ts`

TUI 侧的子 Agent 事件编排器，维护两个核心数据结构：

```typescript
// 子 Agent ID → 父工具调用 ID、名称、swarmIndex 映射
subagentInfo: Map<string, SubagentInfo>

// 父工具调用 ID → AgentSwarmProgressComponent 映射
agentSwarmProgress: Map<string, AgentSwarmProgressComponent>
```

#### 事件处理分流

```
子 Agent 事件
  ├─ 前台子 Agent (runInBackground === false)
  │   ├─ 有 SwarmProgress → 更新进度网格
  │   └─ 无 SwarmProgress → 更新父工具调用卡片
  │
  └─ 后台子 Agent (runInBackground === true)
      └─ 作为 BackgroundTask 处理

AgentSwarm 工具事件
  ├─ tool.call.started → 创建 AgentSwarmProgressComponent
  ├─ tool.call.delta   → 更新参数（支持流式解析）
  └─ tool.result       → 解析 XML 结果 → 更新成员状态
```

### 4.3 AgentSwarmProgressComponent

**文件：** `apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts`

这是 Swarm 的可视化组件，在终端中渲染一个网格展示所有子 Agent 的实时进度。

#### 成员状态

```typescript
interface AgentSwarmMember {
  id: string;              // 成员编号 (001, 002, ...)
  agentId?: string;        // 关联的实际 agent ID
  phase: AgentSwarmPhase;  // pending | queued | suspended | running | completed | failed | cancelled
  ticks: number;           // 进度刻度（用于 braille 进度条）
  itemText: string;        // 对应的 items[i] 文本
  latestModelText: string; // 子 Agent 最新模型输出（最多 2000 字符）
  completedText?: string;  // 完成时的摘要
  failureText?: string;    // 失败时的错误信息
}
```

#### 渲染结构

```
┌──────────────────────────────────────────────────────┐
│ ━ Agent Swarm ─ Analyze these files ━━━━━━━━━━━━━━━━│
│                                                      │
│ 001 ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿  Running    [分析文件 A...]    │
│ 002 ⣿⣿⣿⣿⣿⣿⣀⣀⣀⣀  Running    [分析文件 B...]    │
│ 003 ⣿⣿⣿⣀⣀⣀⣀⣀⣀⣀  Queued    ─────────────────  │
│ 004 ⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀  Pending  ─────────────────  │
│                                                      │
│ ◐ Working... ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
└──────────────────────────────────────────────────────┘
```

- 使用 Braille 字符（`⣀⣄⣤⣦⣶⣷⣿`）绘制进度条
- 每 80ms 刷新一次动画（`FRAME_INTERVAL_MS`）
- 支持自动布局计算（`calculateAgentSwarmGridLayout`）根据终端宽度/高度调整列数

#### 进度估算

内部使用 `AgentSwarmProgressEstimator` 基于以下因素估算进度：
- 当前 phase
- 已用时间
- 工具调用次数
- 模型 token 生成速率

---

## 五、子 Agent 事件透传

除了 AgentSwarm 场景，普通 `Agent` 工具调用的子 Agent 事件也会透传到 TUI：

```typescript
routeChildAgentEvent(event)
  ├─ 找到 parentToolCallId
  ├─ 如果有 SwarmProgress → applySubagentEventToSwarmProgress()
  │   ├─ assistant.delta / thinking.delta → progress.appendModelDelta()
  │   └─ tool.call.started → progress.recordToolCall()
  │
  └─ 否则 → 写入父工具调用卡片
      ├─ hook.result → appendSubagentText()
      ├─ assistant.delta → appendSubagentText()
      ├─ thinking.delta → appendSubagentText()
      ├─ tool.call.* → appendSubToolCall()
      └─ agent.status.updated → updateSubagentMetrics()
```

这使得子 Agent 的输出可以实时显示在父工具调用卡片内，用户体验上类似"嵌套工具调用"。

---

## 六、协议层事件

**文件：** `packages/protocol/src/events.ts`

子 Agent 生命周期通过标准化事件传递：

```typescript
// 子 Agent 已创建（分配了 agentId）
interface SubagentSpawnedEvent {
  type: 'subagent.spawned';
  subagentId: string;
  subagentName: string;
  parentToolCallId: string;
  parentAgentId?: string;
  description?: string;
  swarmIndex?: number;
  runInBackground: boolean;
}

// 子 Agent 已开始执行
interface SubagentStartedEvent {
  type: 'subagent.started';
  subagentId: string;
}

// 子 Agent 被暂挂（速率限制）
interface SubagentSuspendedEvent {
  type: 'subagent.suspended';
  subagentId: string;
  reason: string;
}

// 子 Agent 完成
interface SubagentCompletedEvent {
  type: 'subagent.completed';
  subagentId: string;
  resultSummary: string;
  usage?: TokenUsage;
  contextTokens?: number;
}

// 子 Agent 失败
interface SubagentFailedEvent {
  type: 'subagent.failed';
  subagentId: string;
  error: string;
}
```

---

## 七、完整数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户层                                    │
│  输入: "帮我分析 src/ 目录下所有 TypeScript 文件"                  │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  [1] 模型决定调用 AgentSwarm 工具                                 │
│      AgentSwarm({                                                │
│        description: "Analyze TypeScript files",                  │
│        subagent_type: "explore",                                 │
│        prompt_template: "Review {{item}} for likely regressions.",│
│        items: ["src/a.ts", "src/b.ts", "src/c.ts"],             │
│      })                                                         │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  [2] TUI: 创建 AgentSwarmProgressComponent                       │
│      - 渲染进度网格                                              │
│      - 开始 80ms 动画循环                                        │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  [3] AgentSwarmTool.runSwarm()                                   │
│      - 创建 3 个 QueuedSubagentTask                              │
│      - 调用 SubagentBatch.run()                                  │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  [4] SubagentBatch 调度                                          │
│      - 立即启动 T1 (src/a.ts)                                    │
│      - 立即启动 T2 (src/b.ts)                                    │
│      - 立即启动 T3 (src/c.ts)                                    │
│      - 等待完成...                                               │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  [5] SessionSubagentHost × 3 (并行)                              │
│      ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│      │ spawn(#1)│  │ spawn(#2)│  │ spawn(#3)│                   │
│      ├──────────┤  ├──────────┤  ├──────────┤                   │
│      │创建子Agent│  │创建子Agent│  │创建子Agent│                   │
│      │继承配置   │  │继承配置   │  │继承配置   │                   │
│      │执行 prompt│  │执行 prompt│  │执行 prompt│                   │
│      │等待完成   │  │等待完成   │  │等待完成   │                   │
│      └────┬─────┘  └────┬─────┘  └────┬─────┘                   │
│           │              │              │                         │
│     emitted:            emitted:       emitted:                   │
│     completed           completed      completed                  │
└───────────┼──────────────┼──────────────┼─────────────────────────┘
            ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────┐
│  [6] TUI: SubAgentEventHandler 接收事件                          │
│      - subagent.spawned → 记录 subagentInfo                      │
│      - subagent.started → 更新进度网格 phase=running             │
│      - 子 Agent 的 assistant.delta → 更新进度网格 latestModelText│
│      - subagent.completed → 更新进度网格 phase=completed         │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  [7] SubagentBatch 收集所有结果                                  │
│      results = [                                                  │
│        { status: 'completed', result: 'src/a.ts: OK' },          │
│        { status: 'completed', result: 'src/b.ts: OK' },          │
│        { status: 'completed', result: 'src/c.ts: OK' },          │
│      ]                                                          │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  [8] renderSwarmResults() → XML 输出                            │
│      <agent_swarm_result>                                        │
│        <summary>completed: 3</summary>                           │
│        <subagent outcome="completed" agent_id="agent-1">...</sub>│
│        <subagent outcome="completed" agent_id="agent-2">...</sub>│
│        <subagent outcome="completed" agent_id="agent-3">...</sub>│
│      </agent_swarm_result>                                       │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  [9] TUI: 解析 XML 结果 → 更新 AgentSwarmProgressComponent       │
│      - 每个成员标记 completed/failed/cancelled                   │
│      - 显示完成文本                                               │
│      - 停止动画循环                                               │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  [10] SwarmMode.exit() → 退出 Swarm 模式                         │
│       主 Agent 看到结果，继续 turn                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 八、关键设计决策

### 8.1 为什么至少需要 2 个子 Agent？

`AgentSwarm` 工具要求至少 2 个 `items`（或 1 个 `resume_agent_ids`）。这是为了确保 Swarm 的真正并行价值——单任务不需要 Swarm 开销。

### 8.2 结果摘要强制展开

子 Agent 完成后，如果返回的最后助手文本少于 200 字符，系统会自动追加一条续写提示（`SUMMARY_CONTINUATION_PROMPT`），要求子 Agent 展开详细内容。这确保父 Agent 能获得充分的技术交接信息。最多追问 1 次。

### 8.3 速率限制自动重试

当子 Agent 遇到 Provider 速率限制时：
- 不会立即失败，而是进入 `suspended` 状态
- 保存失败的 agentId，后续用 `retry()` 复用
- 指数退避：3s → 6s → 12s → ...
- 如果该子 Agent 是唯一未完成的任务，则直接失败（不阻塞整个批次）

### 8.4 用户取消保留部分结果

用户手动中止 Swarm 时，已完成的子 Agent 结果会被保留，未启动/已启动的任务分别标记为 `aborted/not_started` 和 `aborted/started`。这使得部分完成的工作仍然有价值。

### 8.5 流式参数解析

AgentSwarm 的工具参数通过 `tool.call.delta` 流式到达。`AgentSwarmProgressComponent.updateArgs()` 支持解析部分 JSON（`parsePartialJsonString`），在参数还没完全到达时就能预渲染进度网格。

---

## 九、相关文件索引

| 文件 | 职责 |
|------|------|
| `packages/agent-core/src/tools/builtin/collaboration/agent-swarm.ts` | AgentSwarm 工具定义和执行 |
| `packages/agent-core/src/session/subagent-batch.ts` | 批量调度器（并发控制、限流、退避） |
| `packages/agent-core/src/session/subagent-host.ts` | 子 Agent 创建、配置、运行 |
| `packages/agent-core/src/agent/swarm/index.ts` | SwarmMode 状态机 |
| `packages/protocol/src/events.ts` | 子 Agent 生命周期事件协议 |
| `apps/kimi-code/src/tui/controllers/session-event-handler.ts` | 事件路由入口 |
| `apps/kimi-code/src/tui/controllers/subagent-event-handler.ts` | 子 Agent 事件编排 |
| `apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts` | Swarm 进度网格组件 |
| `apps/kimi-code/src/tui/components/messages/agent-swarm-progress-estimator.ts` | 进度估算器 |
| `apps/kimi-code/src/tui/components/messages/swarm-markers.ts` | Swarm 模式横幅标记 |
