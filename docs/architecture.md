# Kimi Code 项目架构设计

## 1. 项目概览

Kimi Code 是由月之暗面（Moonshot AI）开发的 AI 编码助手，提供终端 TUI、Web UI 和服务端三种交互方式。项目采用 TypeScript monorepo 架构，基于 pnpm workspace 管理，核心思想是将 AI Agent 能力抽象为可复用的包，通过不同的宿主（app）暴露给用户。

**技术栈：**
- Node.js >= 24.15.0
- pnpm 10.33.0
- TypeScript 6.0.2
- Vitest 测试框架
- Fastify 服务端框架
- Vue 3 + Vite Web UI

## 2. 仓库结构

```
kimi-code/
├── apps/                          # 应用层（宿主）
│   ├── kimi-code/                 # CLI/TUI 应用（主终端界面）
│   ├── kimi-web/                  # Web UI 应用（浏览器界面）
│   └── vis/                       # 可视化调试工具
│       ├── server/                # Vis 服务端
│       └── web/                   # Vis 前端
├── packages/                      # 核心包（能力层）
│   ├── agent-core/                # 统一 Agent 引擎
│   ├── kosong/                    # LLM/Provider 抽象层
│   ├── server/                    # REST + WebSocket 服务端
│   ├── node-sdk/                  # 公开 TypeScript SDK
│   ├── kaos/                      # 执行环境抽象（文件/进程）
│   ├── acp-adapter/               # Agent Client Protocol 适配层
│   ├── oauth/                     # OAuth 认证工具包
│   ├── telemetry/                 # 遥测基础设施
│   ├── migration-legacy/          # 旧版迁移工具
│   └── kimi-migration-legacy/     # Kimi CLI 迁移工具
├── plugins/                       # 插件生态
│   ├── official/                  # 官方插件
│   └── marketplace.json           # 插件市场清单
├── docs/                          # 文档
├── scripts/                       # 构建/维护脚本
└── flake.nix                      # Nix 构建配置
```

## 3. 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                        应用层 (Apps)                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  kimi-code   │  │   kimi-web   │  │      vis         │  │
│  │  CLI/TUI     │  │  Vue 3 Web   │  │  可视化调试工具   │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                   │             │
├─────────┼─────────────────┼───────────────────┼─────────────┤
│         ▼                 ▼                   ▼             │
│                    node-sdk (KimiHarness)     │             │
│              ┌─────┴──────┐                   │             │
│              │  SDK RPC   │◄──────────────────┘             │
│              └──────┬─────┘                                  │
├─────────────────────┼───────────────────────────────────────┤
│                     ▼                                        │
│              server (Fastify)                                │
│         REST + WebSocket /api/v1                             │
│                     │                                        │
├─────────────────────┼───────────────────────────────────────┤
│                     ▼                                        │
│              agent-core (核心引擎)                            │
│   ┌───────────┬───────────┬───────────┬──────────────────┐  │
│   │  Agent    │  Session  │   Loop    │   Services       │  │
│   │  协调器   │  会话管理  │  LLM循环  │   DI服务层       │  │
│   ├───────────┼───────────┼───────────┼──────────────────┤  │
│   │ 工具系统  │ MCP集成  │ 权限管理  │ 配置文件/Profile │  │
│   │ Skill系统 │ Cron调度 │ Swarm模式 │ 插件管理         │  │
│   └──────┬────┴───────────┴───────────┴──────────────────┘  │
├──────────────────────┬──────────────────────────────────────┤
│                     ▼                                      │
│              kosong (LLM抽象层)                              │
│    ┌──────┬──────┬───────┬──────────┬─────────────┐        │
│    │Kimi  │Anthropic│OpenAI │GoogleGenAI │OpenAIResp │        │
│    └──────┴──────┴───────┴──────────┴─────────────┘        │
├──────────────────────┬──────────────────────────────────────┤
│                     ▼                                      │
│              kaos (执行环境抽象)                             │
│         文件系统 / 进程管理 / SSH / 环境变量                  │
└─────────────────────────────────────────────────────────────┘
```

## 4. 核心包详解

### 4.1 `@moonshot-ai/agent-core` — 统一 Agent 引擎

整个系统的核心，负责 AI Agent 的全部能力：

```
agent-core/src/
├── agent/                    # Agent 核心协调器
│   ├── background/           # 后台任务管理
│   ├── compaction/           # 上下文压缩（full / micro）
│   ├── config/               # Agent 配置状态
│   ├── context/              # 对话上下文管理
│   ├── cron/                 # Cron 定时任务
│   ├── goal/                 # 目标管理
│   ├── injection/            # 依赖注入（goal/plan/permission 模式）
│   ├── permission/           # 权限策略系统
│   │   └── policies/         # 各种权限策略（yolo/auto/plan/swarm 等）
│   ├── plan/                 # 计划模式
│   ├── records/              # 线记录持久化
│   ├── replay/               # 会话重放
│   ├── skill/                # Skill 激活与管理
│   ├── swarm/                # Agent Swarm 群体模式
│   ├── tool/                 # 工具注册与生命周期
│   ├── turn/                 # 对话回合管理
│   └── usage/                # Token 用量统计
├── session/                  # Session 会话管理
│   ├── hooks/                # 钩子引擎
│   ├── store/                # 会话持久化存储
│   ├── export/               # 会话导出
│   ├── provider-manager.ts   # LLM Provider 管理
│   └── subagent-host.ts      # 子 Agent 主机
├── loop/                     # 无状态 LLM 循环
│   ├── llm.ts                # LLM 请求
│   ├── retry.ts              # 重试逻辑
│   ├── run-turn.ts           # 回合执行
│   ├── tool-scheduler.ts     # 工具调度
│   └── turn-step.ts          # 步骤级控制
├── tools/                    # 工具实现
│   ├── builtin/              # 内置工具集
│   │   ├── file/             # 读写/编辑/搜索文件
│   │   ├── shell/            # Bash 执行
│   │   ├── collaboration/    # 协作工具（agent/swarm/ask-user）
│   │   ├── goal/             # 目标管理工具
│   │   ├── planning/         # 计划模式切换
│   │   ├── state/            # TODO 列表
│   │   └── web/              # 网页抓取/搜索
│   ├── cron/                 # Cron 工具
│   └── display/              # 展示工具
├── services/                 # 进程内服务层
│   ├── approval/             # 审批服务（反向 RPC）
│   ├── question/             # 用户问答服务（反向 RPC）
│   ├── fs/                   # 文件系统服务
│   ├── workspace/            # 工作区管理
│   ├── config/               # 配置服务
│   ├── session/              # 会话服务
│   ├── tool/                 # 工具服务
│   ├── mcp/                  # MCP 服务
│   ├── skill/                # Skill 服务
│   ├── oauth/                # OAuth 服务
│   └── ...
├── di/                       # 依赖注入容器
│   ├── InstantiationService  # 实例化服务
│   ├── ServiceCollection     # 服务集合
│   └── ...
├── rpc/                      # RPC 通信层
│   ├── client.ts             # RPC 客户端
│   ├── core-api.ts           # 核心 API 定义
│   ├── core-impl.ts          # 核心 API 实现
│   └── sdk-api.ts            # SDK API 定义
├── mcp/                      # MCP (Model Context Protocol) 集成
│   ├── client-*.ts           # 多种客户端实现（stdio/SSE/HTTP）
│   ├── oauth/                # MCP OAuth 认证
│   └── connection-manager.ts # 连接管理
├── profile/                  # Agent Profile 系统
│   ├── default/              # 默认 profile（coder/explore/plan 等）
│   └── context.ts            # Profile 上下文解析
├── skill/                    # Skill 系统
│   ├── builtin/              # 内置 Skill
│   ├── parser.ts             # SKILL.md 解析
│   └── registry.ts           # Skill 注册表
├── plugin/                   # 插件系统
│   ├── manager.ts            # 插件管理器
│   └── source.ts             # 插件源解析
├── config/                   # 配置解析
├── flags/                    # 实验特性标志
├── logging/                  # 日志系统
├── errors/                   # 错误体系
└── telemetry.ts              # 遥测
```

**关键设计原则：**
- Agent 类可独立使用，不强制依赖 Session
- 服务层遵循 VSCode 平台服务命名规范（`IXxxService` / `XxxService`）
- 使用注册式 DI 模式（`registerSingleton` + `getSingletonServiceDescriptors`）
- 无状态 Loop 与宿主层解耦

### 4.2 `@moonshot-ai/kosong` — LLM/Provider 抽象层

统一的 LLM 客户端抽象，支持多种后端：

```
kosong/src/
├── provider.ts               # ChatProvider 接口
├── generate.ts               # generate() 核心生成函数
├── message.ts                # 消息类型（Text/Image/ToolCall/Think）
├── tool.ts                   # 工具协议定义
├── capability.ts             # 模型能力矩阵
├── catalog.ts                # 模型目录元数据
├── usage.ts                  # Token 用量追踪
├── errors.ts                 # 错误类型
└── providers/                # 具体 Provider 实现
    ├── kimi.ts               # Kimi 后端
    ├── anthropic.ts          # Anthropic Claude
    ├── openai-common.ts      # OpenAI 公共逻辑
    ├── openai-legacy.ts      # OpenAI 传统接口
    ├── openai-responses.ts   # OpenAI Responses API
    ├── google-genai.ts       # Google Gemini
    └── kimi-files.ts         # Kimi 文件处理
```

**支持的 Provider 类型：**
- `kimi` — Kimi 自有后端
- `anthropic` — Anthropic Claude
- `openai` — OpenAI 传统 Chat Completions
- `openai_responses` — OpenAI Responses API
- `google-genai` — Google Gemini
- `vertexai` — Google Vertex AI

### 4.3 `@moonshot-ai/server` — REST + WebSocket 服务端

基于 Fastify 的本地服务器，将 agent-core 暴露为标准 API：

```
server/src/
├── start.ts                  # 服务启动入口
├── envelope.ts               # 统一响应格式 { code, msg, data, request_id }
├── routes/                   # REST API 路由
│   └── registerApiV1Routes.ts # /api/v1 路由聚合
├── services/                 # 服务端 DI 适配
│   ├── gateway/              # 网关服务（REST/WS/Broadcast）
│   ├── approval/             # 审批适配
│   └── question/             # 问答适配
├── ws/                       # WebSocket 协议
│   ├── connection.ts         # WsConnection
│   └── protocol.ts           # 帧协议（server_hello/ack/event）
├── middleware/               # 路由中间件
└── svc/                      # OS 服务管理（launchd/systemd/schtasks）
```

**关键约束：**
- 单实例锁机制（防止重复启动）
- 端口忙时自动递增重试
- 所有响应统一信封格式
- 路由校验通过 Zod schema + defineRoute 中间件

### 4.4 `@moonshot-ai/kimi-code-sdk` — 公开 TypeScript SDK

外部宿主通过 SDK 与 agent-core 通信：

```
node-sdk/src/
├── index.ts                  # 公共导出
├── kimi-harness.ts           # KimiHarness 主入口
├── session.ts                # Session 封装
├── sdk-rpc-client.ts         # SDK RPC 客户端
├── rpc.ts                    # RPC 基础客户端
├── auth.ts                   # 认证门面
├── config-rpc.ts             # 配置 RPC
├── kimi-code-model-provider.ts # Kimi 模型 Provider
├── catalog.ts                # 模型目录
└── events.ts                 # 事件类型
```

**通信链路：** SDK → RPC → agent-core（本地进程）或 server（远程）

### 4.5 `@moonshot-ai/kaos` — 执行环境抽象

跨平台的环境、文件和进程管理：

```
kaos/src/
├── kaos.ts                   # Kaos 核心接口
├── local.ts                  # 本地实现
├── process.ts                # 进程接口
├── ssh.ts                    # SSH 远程执行
├── environment.ts            # 环境探测
├── current.ts                # AsyncLocalStorage 上下文
└── types.ts                  # 类型定义
```

### 4.6 `@moonshot-ai/acp-adapter` — Agent Client Protocol 适配层

实现 [Agent Client Protocol](https://modelcontextprotocol.io/) 标准，使 Kimi Code 可以作为 ACP 客户端与其他工具集成：

```
acp-adapter/src/
├── server.ts                 # ACP 服务器
├── session.ts                # ACP 会话
├── convert.ts                # 内容转换
├── events-map.ts             # 事件映射
├── auth-methods.ts           # 认证方法
└── mcp.ts                    # MCP 转发
```

## 5. 应用层详解

### 5.1 `apps/kimi-code` — CLI/TUI 应用

终端交互入口，支持命令行和交互式 TUI 两种模式：

```
kimi-code/src/
├── main.ts                   # 主入口 → handleMainCommand
├── cli/                      # CLI 命令系统
│   ├── commands.ts           # Commander.js 命令定义
│   ├── run-shell.ts          # TUI 启动
│   ├── run-prompt.ts         # 非交互式 prompt
│   ├── sub/                  # 子命令
│   │   ├── server/           # kimi server (run/install/daemon)
│   │   ├── login.ts          # 登录流程
│   │   ├── upgrade.ts        # 升级
│   │   ├── doctor.ts         # 诊断
│   │   ├── acp.ts            # ACP 命令
│   │   └── vis.ts            # 可视化工具
│   └── update/               # 更新系统
│       ├── preflight.ts      # 更新预检
│       ├── refresh.ts        # 刷新可用版本
│       └── select.ts         # 版本选择
├── tui/                      # 终端 UI
│   ├── kimi-tui.ts           # TUI 协调器
│   ├── tui-state.ts          # 全局 UI 状态
│   ├── controllers/          # 独立控制器
│   │   ├── session-event-handler  # SDK 事件路由
│   │   ├── streaming-ui         # 流式渲染
│   │   ├── session-replay       # 会话回放
│   │   ├── editor-keyboard      # 编辑器键盘
│   │   └── auth-flow            # 认证流程
│   ├── commands/             # 斜杠命令
│   ├── components/           # UI 组件
│   │   ├── chrome/           # 持久 UI 元素（footer/todo）
│   │   ├── dialogs/          # 弹窗选择器
│   │   ├── editor/           # 自定义编辑器
│   │   ├── media/            # 媒体渲染
│   │   ├── messages/         # 消息块渲染
│   │   └── panes/            # 侧边面板
│   ├── reverse-rpc/          # 反向 RPC 适配
│   ├── theme/                # 主题系统
│   └── utils/                # TUI 工具函数
├── migration/                # 迁移系统
├── native/                   # Native 打包支持
└── utils/                    # 通用工具
```

**TUI 架构原则：**
- `KimiTUI` 是协调器，不堆积业务逻辑
- 复杂逻辑下沉到 `controllers/`、`commands/`、`components/`
- 组件只负责展示，不直接调用 SDK
- 主题系统统一管理颜色和样式

### 5.2 `apps/kimi-web` — Web UI

Vue 3 浏览器界面，通过 REST + WebSocket 与服务端通信：

```
kimi-web/src/
├── App.vue                   # 根组件
├── main.ts                   # 入口
├── api/                      # API 层
│   ├── daemon/               # 守护进程 API
│   │   ├── client.ts         # HTTP 客户端
│   │   ├── ws.ts             # WebSocket 连接
│   │   ├── mappers.ts        # 数据映射
│   │   └── wire.ts           # 线协议类型
│   └── types.ts              # 类型定义
├── composables/              # Vue 组合式函数
│   ├── useKimiWebClient.ts   # Web API 客户端
│   ├── useTerminal.ts        # 终端管理
│   └── swarmGroups.ts        # Swarm 分组
├── components/               # Vue 组件
│   ├── ChatPane.vue          # 聊天面板
│   ├── Composer.vue          # 输入框
│   ├── ConversationPane.vue  # 对话面板
│   ├── Sidebar.vue           # 侧边栏
│   ├── Terminal.vue          # 终端组件
│   └── ...                   # 其他 UI 组件
└── i18n/                     # 国际化
```

**关键约束：** Web UI 不依赖 `agent-core`，类型定义在本地重新实现。

## 6. 数据流与通信

### 6.1 典型请求流（CLI 场景）

```
用户输入
  │
  ▼
kimi-code/src/tui/kimi-tui.ts
  │  (事件路由)
  ▼
controllers/session-event-handler.ts
  │  (SDK 调用)
  ▼
node-sdk/KimiHarness.createSession()
  │  (本地 RPC / in-process)
  ▼
agent-core/Session → Agent
  │  (LLM 调用)
  ▼
kosong/generate() → ChatProvider
  │  (HTTP 请求)
  ▼
LLM Backend (Kimi/Anthropic/OpenAI/Google)
```

### 6.2 典型请求流（Web 场景）

```
浏览器用户操作
  │
  ▼
kimi-web/composables/useKimiWebClient.ts
  │  (HTTP/WebSocket /api/v1)
  ▼
server/src/routes/ (Fastify)
  │  (DI 解析)
  ▼
server/src/start.ts → InstantiationService
  │  (调用 agent-core)
  ▼
agent-core/Session → Agent
  │  (LLM 调用)
  ▼
kosong/generate() → ChatProvider
```

### 6.3 事件流

```
Agent Loop (agent-core/loop)
  │
  ├── EventService (pub-sub bus)
  │     │
  │     ├── CLI: TUI 组件更新
  │     ├── Web: WebSocket 推送 → 浏览器 UI 更新
  │     └── Vis: 可视化调试工具订阅
  │
  └── Reverse RPC (approval/question)
        │
        ├── CLI: 弹窗等待用户决策
        └── Web: WebSocket 帧传输 → 前端组件
```

## 7. 依赖关系图

```
┌─────────────────────────────────────────────────────┐
│                    apps/kimi-code                    │
│         (依赖 node-sdk，不直接依赖 agent-core)        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                 apps/kimi-web                        │
│         (独立类型定义，通过 /api/v1 与服务端通信)      │
└──────────────────────┬──────────────────────────────┘
                       │ (Web 场景)
┌──────────────────────▼──────────────────────────────┐
│              @moonshot-ai/server                     │
│        (依赖 agent-core, protokol, fastify)           │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│            @moonshot-ai/kimi-code-sdk                │
│          (依赖 agent-core, kaos, oauth)               │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│             @moonshot-ai/agent-core                  │
│  (依赖 kosong, kaos, telemetry, protocol)             │
│  ┌────────┬────────┬────────┬────────┬────────┐    │
│  │ Agent  │Session │  Loop  │Services │  DI    │    │
│  └────────┴────────┴────────┴────────┴────────┘    │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│           @moonshot-ai/kosong                        │
│      (依赖 @anthropic-ai/sdk, @google/genai, ...)    │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│            @moonshot-ai/kaos                         │
│          (node:fs, node:child_process, ssh2)          │
└─────────────────────────────────────────────────────┘
```

**依赖约束：**
- `apps/kimi-code` 只能通过 `node-sdk` 使用 core 能力，禁止直接依赖 `agent-core`
- `apps/kimi-web` 不依赖 `agent-core`，类型在本地重新实现
- `agent-core` 是能力核心，其他包不应反向依赖它

## 8. 关键系统设计

### 8.1 权限系统

agent-core 内置了灵活的权限策略系统，支持多种操作模式：

| 模式 | 策略 | 说明 |
|------|------|------|
| `yolo` | 全部自动批准 | 无限制模式 |
| `auto` | 默认批准 + 规则匹配 | 白名单模式 |
| `plan` | 计划审核 | 进入计划模式后逐项审批 |
| `swarm` | Swarm 群体审批 | 多 Agent 协同审批 |
| `default` | 询问用户 | 默认安全模式 |

策略链：`pre-tool-call-hook` → `user-configured-rules` → `plan-mode-tool-approve` / `exit-plan-mode-review-ask` → `fallback-ask`

### 8.2 上下文压缩（Compaction）

当对话过长时需要压缩上下文以节省 token：

- **Full Compaction**：完整压缩，将历史对话摘要化
- **Micro Compaction**：微压缩，只压缩不活跃的部分
- 策略由 `compaction/strategy.ts` 决定

### 8.3 Agent Profile 系统

不同角色使用不同的系统提示词和工具集：

- `coder` — 编码助手（默认）
- `explore` — 代码探索
- `plan` — 计划模式
- `system.md` — 通用系统提示

### 8.4 Skill 系统

SKILL.md 驱动的模块化技能系统：

- 内置 Skill：`sub-skill`（consolidate/review）、`custom-theme`、`mcp-config` 等
- 支持外部 Skill 目录扫描和注册
- Skill 可通过斜杠命令激活

### 8.5 MCP (Model Context Protocol)

完整的 MCP 客户端支持：

- 传输协议：stdio、SSE、HTTP
- OAuth 认证支持
- 连接管理器处理生命周期
- 工具名称限定（`server::tool` 格式避免冲突）

### 8.6 Swarm 模式

多 Agent 协同工作：

- 主 Agent 可派生子 Agent 并行工作
- 支持批量子 Agent 创建
- 独立的权限和配置隔离

### 8.7 后台任务系统

- 独立进程执行的后台 Agent 任务
- 支持进程任务和问答任务两种类型
- 持久化存储和状态跟踪

## 9. 构建与部署

### 9.1 构建流程

```
CI (GitHub Actions)
  ├── typecheck → lint → sherif → test → build → lint:pkg → publish
  └── changeset 驱动的版本管理
```

### 9.2 打包

- **TUI Native**：通过 `apps/kimi-code/scripts/native/` 下的脚本进行 SEA (Single Executable Application) 打包
- **Web Assets**：kimi-web 构建产物作为静态资源嵌入 TUI
- **Plugin Marketplace**：插件市场清单动态构建

### 9.3 发布

- 使用 Changesets 管理版本
- `@moonshot-ai/kimi-code` 公开发布到 npm
- `@moonshot-ai/kimi-code-sdk` 公开发布到 npm
- 其余包为 internal/private

## 10. 测试策略

- **单元测试**：Vitest，按包组织在 `test/` 目录下
- **E2E 测试**：`packages/server-e2e/` 针对运行中的服务端
- **Vis 工具**：`apps/vis/` 用于会话回放和调试
- 每个包独立的 `vitest.config.ts`

## 11. 扩展点

| 扩展方向 | 机制 | 位置 |
|----------|------|------|
| 新 LLM Provider | 实现 `ChatProvider` 接口 | `kosong/src/providers/` |
| 新工具 | 在 `tools/builtin/` 添加 | `agent-core/src/tools/` |
| 新 Skill | 放置 SKILL.md 文件 | 外部目录或 `skill/builtin/` |
| 新插件 | 发布到插件市场 | `plugins/` |
| 新 Profile | 添加 YAML + MD 文件 | `profile/default/` |
| 新权限策略 | 实现策略接口 | `agent/permission/policies/` |
| 新斜杠命令 | 注册命令处理器 | `apps/kimi-code/src/tui/commands/` |
