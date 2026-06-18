# Kimi Code Monitor for M5PaperS3

基于 M5PaperS3 的 Kimi Code LLM 通信监控器，实时显示 AI 请求/响应日志，支持工具授权操作。

## 硬件要求

- M5PaperS3 (ESP32-S3 + 4.7" E-Paper 540x960)
- WiFi 网络连接

## 软件要求

- PlatformIO (推荐) 或 Arduino IDE
- M5GFX 库
- M5Unified 库
- ArduinoJson 库

## 快速开始

### 1. 配置 WiFi 和服务器

编辑 `kimi-code-monitor.ino` 文件开头的配置：

```cpp
// WiFi Configuration
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Kimi Code Log Server
const char* SERVER_HOST = "192.168.1.100";  // 你的电脑 IP
const int SERVER_PORT = 9877;
```

### 2. 启动 Kimi Code Log Server

在电脑上运行：

```bash
KIMI_CODE_LOG_LLM=1 kimi
```

终端会显示：
```
┌─────────────────────────────────────────────────────────┐
│  📊 LLM Communication Log                               │
│  http://127.0.0.1:9877                                  │
└─────────────────────────────────────────────────────────┘
```

### 3. 编译和上传

#### 使用 PlatformIO (推荐)

```bash
cd arduino/kimi-code-monitor
pio run -t upload
```

#### 使用 Arduino IDE

1. 安装 M5PaperS3 开发板支持
2. 安装 M5GFX, M5Unified, ArduinoJson 库
3. 选择开发板 "M5PaperS3"
4. 上传代码

### 4. 使用

1. M5PaperS3 开机后自动连接 WiFi
2. 连接到 Kimi Code Log Server
3. 实时显示 LLM 请求/响应日志
4. 工具授权时显示授权界面

## 功能说明

### 显示模式

| 模式 | 说明 |
|------|------|
| LOGS | 实时日志显示模式 |
| APPROVAL | 工具授权模式 |
| AUTH | OAuth 登录模式 |

### 按钮操作

#### 日志模式

| 按钮 | 功能 |
|------|------|
| BtnB | 向上滚动 |
| BtnC | 向下滚动 |

#### 授权模式

| 按钮 | 功能 |
|------|------|
| BtnA | 批准 (单次) |
| BtnB | 批准 (整个会话) |
| BtnC | 拒绝 |

#### 登录模式

| 按钮 | 功能 |
|------|------|
| 任意按钮 | 关闭登录提示 |

### 触摸操作

#### 日志模式
- 右侧上半部分：向上滚动
- 右侧下半部分：向下滚动

#### 授权模式
- 左侧按钮：批准
- 中间按钮：批准整个会话
- 右侧按钮：拒绝

## 日志颜色

| 颜色 | 类型 |
|------|------|
| 蓝色 | LLM 请求 |
| 绿色 | LLM 响应 |
| 橙色 | 授权操作 |
| 紫色 | 登录操作 |

## 自动授权 (测试用)

在代码中设置：

```cpp
const bool AUTO_APPROVE = true;           // 自动批准
const bool AUTO_APPROVE_SESSION = true;   // 自动批准整个会话
```

**注意**: 仅用于测试，生产环境请禁用。

## 故障排除

### WiFi 连接失败

1. 检查 WiFi SSID 和密码
2. 确保 WiFi 网络可用
3. 检查信号强度

### 服务器连接失败

1. 确保电脑和 M5PaperS3 在同一网络
2. 检查服务器 IP 地址
3. 确保 Kimi Code Log Server 正在运行
4. 检查防火墙设置

### 显示异常

1. 重启设备
2. 检查 M5GFX 库版本
3. 确保使用正确的开发板配置

## API 接口

详见 `packages/agent-core/src/logging/API.md`

## 许可证

MIT License
