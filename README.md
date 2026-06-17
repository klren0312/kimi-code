# Kimi Code CLI

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://moonshotai.github.io/kimi-code/en/) <br>
[Documentation](https://moonshotai.github.io/kimi-code/en/) · [Issues](https://github.com/MoonshotAI/kimi-code/issues) · [中文](README.zh-CN.md)

![Demo of using Kimi Code](./docs/media/intro.gif)

## What is Kimi Code CLI

Kimi Code CLI is an AI coding agent that runs in your terminal — it can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI’s Kimi models and can also be configured to use other compatible providers.

## Install

Install with the official script. No Node.js required.

- **macOS or Linux**:

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- **Homebrew (macOS/Linux)**:

```sh
brew install kimi-code
```

- **Windows (PowerShell)**:

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because Kimi Code CLI uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

Then, run it with a new shell session:

```sh
kimi --version
```

For npm install, upgrade, uninstall, see [Getting Started](https://moonshotai.github.io/kimi-code/en/guides/getting-started).

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
kimi
```

On first launch, run `/login` inside Kimi Code CLI and choose either Kimi Code OAuth or a Moonshot AI Open Platform API key. After login, try your first task:

```
Take a look at this project and explain its main directories.
```

## Key Features

- **Single-binary distribution.** Install with one command: no Node.js setup, PATH gymnastics, or global module conflicts.
- **Blazing-fast startup.** The TUI is ready in milliseconds, so starting a session never feels heavy.
- **Purpose-built TUI.** A carefully tuned interface, optimized end to end for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat and let the agent watch what is hard to describe in words — turn a reference clip into a LUT, a long video into a short, a screen recording into working code, and more.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally with `/mcp-config`, without hand-editing JSON.
- **Rich plugin ecosystem.** Install skills, MCP servers, and data sources from the marketplace or any GitHub repo, with each install's trust level surfaced up front.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, and `plan` subagents in isolated contexts while keeping the main conversation clean.
- **Lifecycle hooks.** Run local commands at key points to gate risky tool calls, audit decisions, trigger desktop notifications, or connect to your own automation.
- **Editor & IDE integration (ACP).** Drive a Kimi Code CLI session straight from Zed, JetBrains, or any [Agent Client Protocol](https://agentclientprotocol.com/) client with `kimi acp`.

## LLM Communication Log (Debug Feature)

Kimi Code CLI supports real-time logging of AI communication with a built-in web viewer. This is useful for debugging and monitoring LLM requests/responses.

### Usage

Set the environment variable `KIMI_CODE_LOG_LLM=1` when starting:

```sh
KIMI_CODE_LOG_LLM=1 kimi
```

The terminal will display the web viewer URL:

```
┌─────────────────────────────────────────────────────────┐
│  📊 LLM Communication Log                               │
│  http://127.0.0.1:9877                                  │
└─────────────────────────────────────────────────────────┘
```

Open the URL in a browser to view real-time logs.

### Features

- **Real-time logs** — Live display of LLM requests and responses via SSE (Server-Sent Events)
- **Request details** — System Prompt, available tools, conversation history
- **Response details** — Model output, tool calls, token usage, duration
- **OAuth login integration** — Device authorization code and verification link displayed in web viewer
- **Tool approval** — Approve/reject tool execution directly from the web page (MCP, Bash, file edits, etc.)
- **Log file** — Simultaneous writing to `~/.kimi-code/logs/llm-communication.log`

### Web Viewer Features

| Feature | Description |
|---------|-------------|
| Auto-scroll | New logs automatically scroll to bottom |
| Clear | Clear all displayed logs |
| Expand/Collapse | Click log entry to view details |
| Approve | Approve tool execution (single use) |
| Approve for session | Approve same operation for entire session |
| Reject | Reject tool execution |

### Log File Format

The log file uses a delimiter format for easy reading and parsing:

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


## Use it in your editor (ACP)

Kimi Code CLI speaks the [Agent Client Protocol](https://agentclientprotocol.com/), so ACP-compatible editors and IDEs (Zed, JetBrains, …) can drive a session over stdio. Log in once, then point your editor at the `kimi acp` subcommand — no extra login needed.

For Zed, add this to `~/.config/zed/settings.json`:

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

Then open a new conversation in Zed's Agent panel. See [Using in IDEs](https://moonshotai.github.io/kimi-code/en/guides/ides) for JetBrains setup and troubleshooting, and the [`kimi acp` reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp) for the full capability matrix.

## Docs

- [Getting Started](https://moonshotai.github.io/kimi-code/en/guides/getting-started)
- [Interaction and approvals](https://moonshotai.github.io/kimi-code/en/guides/interaction)
- [Sessions](https://moonshotai.github.io/kimi-code/en/guides/sessions)
- [Using in IDEs (ACP)](https://moonshotai.github.io/kimi-code/en/guides/ides)
- [Configuration](https://moonshotai.github.io/kimi-code/en/configuration/config-files)
- [Command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command)

## Develop

Requirements: Node.js ≥ 24.15.0, pnpm 10.33.0.

```sh
git clone https://github.com/MoonshotAI/kimi-code.git
cd kimi-code
pnpm install
```

```sh
pnpm dev:cli    # run the CLI in dev mode
pnpm test       # run tests
pnpm typecheck  # TypeScript check
pnpm lint       # oxlint
pnpm build      # build all packages
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution guide.

## Community

- [Issues](https://github.com/MoonshotAI/kimi-code/issues)
- For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## Acknowledgements

Our TUI is built on top of [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui). We thank the authors of `pi-tui` for their valuable work.

## License

Released under the [MIT License](LICENSE).
