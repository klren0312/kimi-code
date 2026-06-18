# LLM Communication Log API 接口文档

**服务器地址**: `http://127.0.0.1:9877`

**启用方式**: 设置环境变量 `KIMI_CODE_LOG_LLM=1` 后启动 Kimi Code CLI

---

## 目录

1. [SSE 事件流](#1-sse-事件流实时日志推送)
2. [获取日志文件](#2-获取日志文件)
3. [提交工具授权响应](#3-提交工具授权响应)
4. [SSE 事件数据结构](#4-sse-事件数据结构)
5. [Arduino ESP32 示例代码](#5-arduino-esp32-示例代码)

---

## 1. SSE 事件流（实时日志推送）

**端点**: `GET /events`

**描述**: 建立 SSE (Server-Sent Events) 连接，接收实时日志事件推送

**请求头**:
```http
Accept: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**响应格式**:
```
data: {"type":"request","timestamp":"2026-06-18T10:30:00.000Z","request":{...}}

data: {"type":"response","timestamp":"2026-06-18T10:30:05.000Z","response":{...}}
```

**事件类型总览**:

| type | 说明 | 触发时机 |
|------|------|----------|
| `request` | LLM 请求 | 发送请求到 AI 模型时 |
| `response` | LLM 响应 | 收到 AI 模型响应时 |
| `auth` | OAuth 设备授权 | 需要用户登录时 |
| `auth_complete` | 授权完成 | 用户完成或取消登录时 |
| `approval` | 工具授权请求 | 工具执行需要用户批准时 |
| `approval_result` | 工具授权结果 | 用户批准或拒绝工具执行时 |

---

## 2. 获取日志文件

**端点**: `GET /api/logs`

**描述**: 获取完整的日志文件内容

**请求头**:
```http
Accept: text/plain
```

**响应**:
- **成功**: `200 OK`，返回日志文件内容
- **无日志**: `200 OK`，返回 `(no logs yet)`

---

## 3. 提交工具授权响应

**端点**: `POST /api/approval/{requestId}`

**描述**: 从网页端提交工具执行授权决策

**路径参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| requestId | string | 是 | 授权请求的唯一标识符 |

**请求头**:
```http
Content-Type: application/json
```

**请求体**:
```json
{
  "approved": true,
  "scope": "session"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| approved | boolean | 是 | `true` 批准，`false` 拒绝 |
| scope | string | 否 | `"session"` 表示整个会话有效，不填表示单次有效 |

**响应**:

成功:
```json
{
  "ok": true
}
```

失败:
```json
{
  "error": "invalid request body"
}
```

**CORS 支持**:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

---

## 4. SSE 事件数据结构

### 4.1 request 事件

LLM 请求事件，发送到 AI 模型时触发。

```json
{
  "type": "request",
  "timestamp": "2026-06-18T10:30:00.000Z",
  "request": {
    "provider": "kimi",
    "model": "kimi-k2",
    "systemPrompt": "You are a helpful assistant...",
    "tools": [
      {
        "name": "read",
        "description": "Read file content"
      },
      {
        "name": "write",
        "description": "Write file content"
      }
    ],
    "messages": [
      {
        "role": "user",
        "content": "Hello"
      },
      {
        "role": "assistant",
        "content": "Hi! How can I help you?"
      }
    ]
  }
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| type | string | 固定值 `"request"` |
| timestamp | string | ISO 8601 时间戳 |
| request.provider | string | AI 提供商名称 (如 `"kimi"`, `"openai"`, `"anthropic"`) |
| request.model | string | 模型名称 (如 `"kimi-k2"`, `"gpt-4"`) |
| request.systemPrompt | string | 系统提示词 |
| request.tools | array | 可用工具列表 |
| request.tools[].name | string | 工具名称 |
| request.tools[].description | string | 工具描述 |
| request.messages | array | 对话历史 |
| request.messages[].role | string | 消息角色 (`"user"`, `"assistant"`, `"system"`, `"tool"`) |
| request.messages[].content | string/array | 消息内容 |

---

### 4.2 response 事件

LLM 响应事件，收到模型回复时触发。

```json
{
  "type": "response",
  "timestamp": "2026-06-18T10:30:05.000Z",
  "response": {
    "content": "Hi! How can I help you?",
    "toolCalls": [
      {
        "name": "read",
        "arguments": "{\"path\":\"file.txt\"}"
      }
    ],
    "usage": {
      "input": 1500,
      "output": 200,
      "total": 1700
    },
    "finishReason": "completed",
    "durationMs": 5000
  }
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| type | string | 固定值 `"response"` |
| timestamp | string | ISO 8601 时间戳 |
| response.content | string | 模型回复的文本内容 |
| response.toolCalls | array | 模型请求调用的工具列表 |
| response.toolCalls[].name | string | 工具名称 |
| response.toolCalls[].arguments | string | 工具参数 (JSON 字符串) |
| response.usage | object/null | Token 用量统计 |
| response.usage.input | number | 输入 token 数 |
| response.usage.output | number | 输出 token 数 |
| response.usage.total | number | 总 token 数 |
| response.finishReason | string | 结束原因 (`"completed"`, `"tool_calls"`, `"truncated"`, `"filtered"`) |
| response.durationMs | number | 请求耗时 (毫秒) |

---

### 4.3 auth 事件

OAuth 设备授权事件，需要用户登录时触发。

```json
{
  "type": "auth",
  "timestamp": "2026-06-18T10:30:00.000Z",
  "auth": {
    "userCode": "ABCD-EFGH",
    "verificationUri": "https://auth.kimi.com/device",
    "verificationUriComplete": "https://auth.kimi.com/device?user_code=ABCD-EFGH",
    "expiresIn": 900,
    "interval": 5
  }
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| type | string | 固定值 `"auth"` |
| timestamp | string | ISO 8601 时间戳 |
| auth.userCode | string | 用户需要输入的授权码 |
| auth.verificationUri | string | 授权验证页面 URL |
| auth.verificationUriComplete | string | 带授权码的完整验证 URL (可直接点击) |
| auth.expiresIn | number/null | 授权码有效期 (秒) |
| auth.interval | number | 轮询间隔 (秒) |

---

### 4.4 auth_complete 事件

授权完成事件，用户完成或取消登录时触发。

```json
{
  "type": "auth_complete",
  "timestamp": "2026-06-18T10:30:30.000Z",
  "authComplete": {
    "success": true,
    "message": "Login successful."
  }
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| type | string | 固定值 `"auth_complete"` |
| timestamp | string | ISO 8601 时间戳 |
| authComplete.success | boolean | `true` 登录成功，`false` 登录失败 |
| authComplete.message | string | 结果消息 |

---

### 4.5 approval 事件

工具授权请求事件，工具执行需要用户批准时触发。

```json
{
  "type": "approval",
  "timestamp": "2026-06-18T10:30:00.000Z",
  "approval": {
    "toolName": "bash",
    "toolInput": "ls -la",
    "requestId": "req_abc123"
  }
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| type | string | 固定值 `"approval"` |
| timestamp | string | ISO 8601 时间戳 |
| approval.toolName | string | 工具名称 (如 `"bash"`, `"write"`, `"mcp__server__tool"`) |
| approval.toolInput | string | 工具执行的输入/参数 |
| approval.requestId | string | 授权请求的唯一标识符 |

---

### 4.6 approval_result 事件

工具授权结果事件，用户批准或拒绝工具执行时触发。

```json
{
  "type": "approval_result",
  "timestamp": "2026-06-18T10:30:01.000Z",
  "approvalResult": {
    "requestId": "req_abc123",
    "approved": true,
    "scope": "session"
  }
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| type | string | 固定值 `"approval_result"` |
| timestamp | string | ISO 8601 时间戳 |
| approvalResult.requestId | string | 对应的授权请求 ID |
| approvalResult.approved | boolean | `true` 批准，`false` 拒绝 |
| approvalResult.scope | string/null | `"session"` 表示整个会话有效，`null` 表示单次 |

---

## 5. Arduino ESP32 示例代码

### 5.1 基础连接

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "your-wifi-ssid";
const char* WIFI_PASSWORD = "your-wifi-password";
const char* SERVER_URL = "http://192.168.1.100:9877";

WiFiClient sseClient;

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    Serial.println("Connecting to WiFi...");
  }
  Serial.println("WiFi connected");
  connectSSE();
}

void loop() {
  if (!sseClient.connected()) {
    Serial.println("SSE disconnected, reconnecting...");
    delay(1000);
    connectSSE();
    return;
  }
  
  if (sseClient.available()) {
    String line = sseClient.readStringUntil('\n');
    if (line.startsWith("data: ")) {
      handleSSEEvent(line.substring(6));
    }
  }
}
```

### 5.2 SSE 连接

```cpp
void connectSSE() {
  if (sseClient.connect("192.168.1.100", 9877)) {
    sseClient.print("GET /events HTTP/1.1\r\n");
    sseClient.print("Host: 192.168.1.100:9877\r\n");
    sseClient.print("Accept: text/event-stream\r\n");
    sseClient.print("Cache-Control: no-cache\r\n");
    sseClient.print("Connection: keep-alive\r\n\r\n");
    Serial.println("SSE connected");
  } else {
    Serial.println("SSE connection failed");
  }
}
```

### 5.3 事件处理

```cpp
void handleSSEEvent(String json) {
  StaticJsonDocument<4096> doc;
  DeserializationError error = deserializeJson(doc, json);
  
  if (error) {
    Serial.print("JSON parse error: ");
    Serial.println(error.c_str());
    return;
  }
  
  const char* type = doc["type"];
  
  if (strcmp(type, "request") == 0) {
    handleRequest(doc);
  } else if (strcmp(type, "response") == 0) {
    handleResponse(doc);
  } else if (strcmp(type, "auth") == 0) {
    handleAuth(doc);
  } else if (strcmp(type, "approval") == 0) {
    handleApproval(doc);
  }
}

void handleRequest(JsonDocument& doc) {
  const char* provider = doc["request"]["provider"];
  const char* model = doc["request"]["model"];
  Serial.printf("[REQUEST] %s/%s\n", provider, model);
}

void handleResponse(JsonDocument& doc) {
  const char* content = doc["response"]["content"];
  int duration = doc["response"]["durationMs"];
  Serial.printf("[RESPONSE] %dms: %s\n", duration, content);
}

void handleAuth(JsonDocument& doc) {
  const char* userCode = doc["auth"]["userCode"];
  const char* url = doc["auth"]["verificationUri"];
  Serial.println("[AUTH] Login required:");
  Serial.printf("  Code: %s\n", userCode);
  Serial.printf("  URL: %s\n", url);
}

void handleApproval(JsonDocument& doc) {
  const char* requestId = doc["approval"]["requestId"];
  const char* toolName = doc["approval"]["toolName"];
  const char* toolInput = doc["approval"]["toolInput"];
  
  Serial.println("[APPROVAL] Required:");
  Serial.printf("  Tool: %s\n", toolName);
  Serial.printf("  Input: %s\n", toolInput);
  
  // 自动批准示例 (生产环境应等待用户确认)
  // submitApproval(requestId, true);
}
```

### 5.4 提交授权响应

```cpp
bool submitApproval(String requestId, bool approved, const char* scope = nullptr) {
  HTTPClient http;
  String url = String(SERVER_URL) + "/api/approval/" + requestId;
  
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  
  // 构建请求体
  StaticJsonDocument<128> doc;
  doc["approved"] = approved;
  if (scope != nullptr) {
    doc["scope"] = scope;
  }
  
  String body;
  serializeJson(doc, body);
  
  int httpCode = http.POST(body);
  
  if (httpCode == 200) {
    Serial.println("Approval submitted successfully");
    http.end();
    return true;
  } else {
    Serial.printf("Approval failed: %d\n", httpCode);
    http.end();
    return false;
  }
}

// 使用示例
// submitApproval("req_abc123", true);              // 批准单次
// submitApproval("req_abc123", true, "session");   // 批准整个会话
// submitApproval("req_abc123", false);             // 拒绝
```

### 5.5 带显示的完整示例 (OLED)

```cpp
#include <U8g2lib.h>

U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0);

void displayApprovalRequest(const char* toolName, const char* requestId) {
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 12, "Approval Required");
  u8g2.drawStr(0, 28, toolName);
  u8g2.drawStr(0, 44, "[A] Approve [B] Reject");
  u8g2.sendBuffer();
  
  // 等待按键
  while (true) {
    if (digitalRead(BTN_APPROVE) == LOW) {
      submitApproval(requestId, true);
      break;
    }
    if (digitalRead(BTN_REJECT) == LOW) {
      submitApproval(requestId, false);
      break;
    }
    delay(100);
  }
}
```

---

## 6. 错误处理

### HTTP 状态码

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 404 | 路径不存在 |

### 常见错误响应

```json
{
  "error": "invalid request body"
}
```

### SSE 重连策略

建议使用指数退避重连：

```cpp
int reconnectDelay = 1000;
const int MAX_RECONNECT_DELAY = 30000;

void reconnectSSE() {
  while (!sseClient.connected()) {
    Serial.printf("Reconnecting in %dms...\n", reconnectDelay);
    delay(reconnectDelay);
    connectSSE();
    
    reconnectDelay = min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
  reconnectDelay = 1000; // 重置
}
```

---

## 7. 附录

### 完整的消息流程图

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Kimi Code  │     │   Server    │     │   Arduino   │
│    CLI      │     │  :9877      │     │   Client    │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │   LLM Request     │                   │
       │──────────────────►│                   │
       │                   │   SSE: request    │
       │                   │──────────────────►│
       │                   │                   │
       │   LLM Response    │                   │
       │──────────────────►│                   │
       │                   │   SSE: response   │
       │                   │──────────────────►│
       │                   │                   │
       │   Tool Approval   │                   │
       │──────────────────►│                   │
       │                   │   SSE: approval   │
       │                   │──────────────────►│
       │                   │                   │
       │                   │  POST /approval   │
       │                   │◄──────────────────│
       │                   │                   │
       │   Approval Result │                   │
       │◄──────────────────│                   │
       │                   │                   │
```

### 联系方式

- GitHub: https://github.com/MoonshotAI/kimi-code
- Issues: https://github.com/MoonshotAI/kimi-code/issues
