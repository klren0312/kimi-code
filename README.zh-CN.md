# Kimi Code CLI

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://moonshotai.github.io/kimi-code/zh/)

[Documentation](https://moonshotai.github.io/kimi-code/zh/) · [Issues](https://github.com/MoonshotAI/kimi-code/issues) · [English](README.md)


![Kimi Code 的使用演示](./docs/media/intro.gif)


## 什么是 Kimi Code CLI

Kimi Code CLI 是一个运行在终端里的 AI 编程 agent，可以帮你读写代码、执行 shell 命令、检索文件、抓取网页，并根据反馈自主决定下一步动作。开箱即用对接 Moonshot AI 的 Kimi 模型，也可指向其他兼容厂商。

## 安装

推荐使用官方安装脚本，不需要提前安装 Node.js。

- **macOS / Linux**：

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- **Homebrew（macOS / Linux）**：

```sh
brew install kimi-code
```

- **Windows（PowerShell）**：

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

> Windows 用户首次启动前还需要安装 [Git for Windows](https://gitforwindows.org/)，Kimi Code CLI 会使用其中的 Git Bash 作为 Shell 环境。如果 Git Bash 安装在非标准路径，请把 `KIMI_SHELL_PATH` 设为 `bash.exe` 的绝对路径。

随后在新的终端会话中运行：

```sh
kimi --version
```

npm 安装、升级、卸载方式，见[快速上手](https://moonshotai.github.io/kimi-code/zh/guides/getting-started)。

## 快速开始

进入项目目录并启动交互界面：

```sh
cd your-project
kimi
```

首次启动时，在 Kimi Code CLI 里输入 `/login`，选择 Kimi Code OAuth 或 Moonshot AI Open Platform API 密钥登录。登录完成后，可以先让它熟悉项目：

```
帮我看一下这个项目的目录结构，简单介绍一下每个目录是做什么的
```

## 核心特性

- **二进制发行，零环境依赖** 一行命令安装，不需要预装 Node.js，不用折腾 PATH，也不会和全局模块冲突。
- **极速启动** TUI 在毫秒级就绪，开一个新会话没有任何心智负担。
- **精致的 TUI 体验** 端到端打磨的交互界面，专为长时间、专注的 Agent 会话优化。
- **视频也能输入** 把屏幕录像、演示视频拖进对话，让 Agent 看那些难以用文字描述的东西——把参考片段做成 LUT、把长视频剪成短视频、把录屏变成代码，等等。
- **AI-native 的 MCP 配置** 通过 `/mcp-config` 对话式添加、编辑、认证 MCP 服务器，无需手写 JSON。
- **丰富的插件生态** 从插件市场或任意 GitHub 仓库安装 skills、MCP 服务器和数据源，每次安装都会标明来源的信任级别。
- **子 Agent 聚焦并行工作** 内置 `coder`、`explore`、`plan` 子 Agent 在隔离上下文中处理子任务，主对话保持清爽。
- **生命周期 hooks** 在关键节点执行本地命令：拦截高风险工具调用、审计决策、发送桌面通知，或对接你自己的自动化脚本。
- **编辑器 / IDE 集成（ACP）** 用 `kimi acp` 让 Zed、JetBrains 等任意 [Agent Client Protocol](https://agentclientprotocol.com/) 客户端直接驱动会话。


## LLM 通信日志（调试功能）

Kimi Code CLI 支持实时记录 AI 通信日志，并通过内置的网页查看器展示。这对于调试、监控 LLM 请求/响应非常有用。

### 启用方式

在启动时设置环境变量 `KIMI_CODE_LOG_LLM=1`：

```sh
KIMI_CODE_LOG_LLM=1 kimi
```

启动后终端会显示网页查看器地址：

```
┌─────────────────────────────────────────────────────────┐
│  📊 LLM Communication Log                               │
│  http://127.0.0.1:9877                                  │
└─────────────────────────────────────────────────────────┘
```

在浏览器中打开该地址即可查看实时日志。

### 功能特性

- **实时日志** — 通过 SSE (Server-Sent Events) 实时显示 LLM 请求和响应
- **请求详情** — 显示 System Prompt、可用工具、对话历史
- **响应详情** — 显示模型回复内容、工具调用、Token 用量、耗时
- **OAuth 登录集成** — 在网页上显示设备授权码和验证链接
- **工具授权** — 在网页上直接批准/拒绝工具执行（MCP、Bash、文件编辑等）
- **日志文件** — 同时写入 `~/.kimi-code/logs/llm-communication.log`

### 网页查看器功能

| 功能 | 说明 |
|------|------|
| Auto-scroll | 新日志自动滚动到底部 |
| Clear | 清空当前显示的日志 |
| 展开/折叠 | 点击日志条目查看详情 |
| Approve | 批准工具执行（单次） |
| Approve for session | 批准整个会话中的同类操作 |
| Reject | 拒绝工具执行 |

### 日志文件格式

日志文件采用分隔符格式，便于阅读和解析：

```
================================================================================
[2026-06-16T14:30:00.000Z] LLM REQUEST
Provider: kimi
Model: kimi-k2
================================================================================

--- System Prompt ---
You are a helpful assistant...

--- Tools (5) ---
[{"name":"read","description":"Read file"}, ...]

--- Messages (3) ---
[{"role":"user","content":"Hello"}, ...]

--------------------------------------------------------------------------------
--- Response [2026-06-16T14:30:05.000Z] (5000ms) ---
Finish reason: completed
Tokens: input=1500 output=200 total=1700

--- Content ---
Hi! How can I help you?

--- Tool Calls (1) ---
  read(path/to/file)
```


## 在编辑器里使用（ACP）

Kimi Code CLI 支持 [Agent Client Protocol](https://agentclientprotocol.com/)，ACP 兼容的编辑器 / IDE（Zed、JetBrains……）可以通过 stdio 直接驱动会话。登录一次后，把编辑器指向 `kimi acp` 子命令即可，无需重复登录。

以 Zed 为例，在 `~/.config/zed/settings.json` 中加入：

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "type": "custom",
      "command": "kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

随后在 Zed 的 Agent 面板新建对话即可。JetBrains 配置与排障见[在 IDE 中使用](https://moonshotai.github.io/kimi-code/zh/guides/ides)，完整能力矩阵见 [`kimi acp` 参考](https://moonshotai.github.io/kimi-code/zh/reference/kimi-acp)。

## 文档

- [快速上手](https://moonshotai.github.io/kimi-code/zh/guides/getting-started)
- [交互与审批](https://moonshotai.github.io/kimi-code/zh/guides/interaction)
- [会话](https://moonshotai.github.io/kimi-code/zh/guides/sessions)
- [在 IDE 中使用（ACP）](https://moonshotai.github.io/kimi-code/zh/guides/ides)
- [配置](https://moonshotai.github.io/kimi-code/zh/configuration/config-files)
- [命令参考](https://moonshotai.github.io/kimi-code/zh/reference/kimi-command)

## 本地开发

环境要求：Node.js ≥ 24.15.0，pnpm 10.33.0。

```sh
git clone https://github.com/MoonshotAI/kimi-code.git
cd kimi-code
pnpm install
```

```sh
pnpm dev:cli    # 以开发模式运行 CLI
pnpm test       # 运行测试
pnpm typecheck  # TypeScript 检查
pnpm lint       # 运行 oxlint
pnpm build      # 构建所有包
```

完整贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 社区

- [Issues](https://github.com/MoonshotAI/kimi-code/issues)
- 安全漏洞反馈，请见 [SECURITY.md](SECURITY.md)。

## 致谢

我们的 TUI 构建在 [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui) 之上。我们衷心感谢 `pi-tui` 作者的工作。

## 许可证

基于 [MIT](LICENSE) 协议发布。
