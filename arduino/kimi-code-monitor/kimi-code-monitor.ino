/*
 * Kimi Code LLM 通信监控器
 * 硬件: M5PaperS3 (ESP32-S3 + 4.7" 墨水屏 540x960)
 * 依赖: M5Unified, ArduinoJson, WiFi, HTTPClient
 *
 * 功能:
 * - 通过 WiFi 连接 Kimi Code 日志服务器
 * - 实时显示 SSE 事件（LLM 请求/响应/认证/审批）
 * - 触摸屏和物理按钮操作（滚动、审批）
 * - 墨水屏优化渲染（直接写 LCD，按需刷新）
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <M5Unified.h>
#include "config.h"

// ============================================================================
// 全局变量
// ============================================================================

/* ---- WiFi 与 SSE 连接 ---- */
WiFiClient sseClient;           // SSE 长连接的 TCP 客户端
bool sseConnected = false;      // SSE 是否已连接
unsigned long lastReconnectAttempt = 0;  // 上次重连尝试的时间戳

/* ---- 显示模式 ---- */
enum DisplayMode {
  MODE_LOGS,         // 日志列表（默认）
  MODE_APPROVAL,     // 工具审批确认界面
  MODE_AUTH,         // OAuth 登录界面
  MODE_WIFI_CONFIG   // WiFi 配置界面（预留）
};

DisplayMode currentMode = MODE_LOGS;  // 当前显示模式

/* ---- 日志缓冲区（环形队列） ---- */
struct LogEntry {
  String type;       // 类型: "request" / "response" / "auth" / "approval"
  String timestamp;  // 时间戳 HH:MM:SS
  String content;    // 日志内容
  bool isNew;        // 是否为新增（可用于高亮闪烁）
};

LogEntry logBuffer[MAX_LOG_LINES];  // 环形缓冲区，大小由 config.h 定义
int logCount = 0;        // 当前缓冲区中的日志条数
int logStartIndex = 0;   // 环形队列的起始索引

/* ---- 审批状态 ---- */
struct ApprovalRequest {
  String requestId;   // 审批请求 ID
  String toolName;    // 需要审批的工具名称
  String toolInput;   // 工具的输入参数
  bool active;        // 是否有待处理的审批
};

ApprovalRequest currentApproval;
int selectedButton = 0;  // 当前选中的按钮: 0=批准, 1=会话级批准, 2=拒绝

/* ---- OAuth 认证状态 ---- */
struct AuthRequest {
  String userCode;         // 用户验证码（如 "ABCD-1234"）
  String verificationUri;  // 验证 URL（如 "https://..."）
  int expiresIn;           // 过期时间（秒）
  bool active;             // 是否有活跃的认证请求
};

AuthRequest currentAuth;
unsigned long authStartTime = 0;  // 认证请求开始时间，用于计算剩余时间

/* ---- 滚动位置 ---- */
int scrollOffset = 0;  // 日志列表的滚动偏移量

/* ---- 触摸状态 ---- */
bool touchPressed = false;  // 触摸是否按下（用于去抖）
int touchX = 0;             // 最近一次触摸的 X 坐标
int touchY = 0;             // 最近一次触摸的 Y 坐标

/* ---- 状态栏 ---- */
String statusText = "Disconnected";  // 状态栏显示文本
int signalStrength = 0;              // WiFi 信号强度 (dBm)

/* ---- 墨水屏按需刷新 ---- */
bool displayDirty = true;            // 屏幕是否需要刷新（有脏数据）
unsigned long lastDisplayUpdate = 0; // 上次刷新屏幕的时间戳
int partialRefreshCount = 0;         // 局部刷新计数，达到阈值后做一次全刷清残影

// ============================================================================
// 函数前向声明
// C++ 要求函数在调用前声明，Arduino 编译器不自动前向声明
// ============================================================================

// 网络
void connectWiFi();
void connectSSE();

// SSE 事件处理
void processSSEEvents();
void handleSSEEvent(const String& jsonStr);
void handleRequestEvent(JsonDocument& doc);
void handleResponseEvent(JsonDocument& doc);
void handleAuthEvent(JsonDocument& doc);
void handleAuthCompleteEvent(JsonDocument& doc);
void handleApprovalEvent(JsonDocument& doc);
void handleApprovalResultEvent(JsonDocument& doc);

// HTTP API
bool submitApproval(String requestId, bool approved, const char* scope);

// 日志
void addLogEntry(const String& type, const String& content);
String getTimestamp();

// 输入
void handleTouch();
void handleTouchPress(int x, int y);
void handleButtons();

// 显示
void updateDisplay();
void drawSplashScreen();
void drawStatusBar();
void drawLogScreen();
void drawApprovalScreen();
void drawAuthScreen();
void drawFooter(const String& text);

// ============================================================================
// 初始化
// ============================================================================

void setup() {
  // 初始化 M5Unified（自动检测硬件型号，初始化屏幕、触摸、按键等）
  auto cfg = M5.config();
  M5.begin(cfg);

  // 设置屏幕为横屏模式（1 = 90° 旋转，540x960 → 960x540）
  M5.Lcd.setRotation(1);

  // 显示启动画面
  drawSplashScreen();
  lastDisplayUpdate = millis();  // 记录初始刷新时间
  displayDirty = false;          // 启动画面已显示，暂不需要刷新

  // 初始化串口（用于调试输出）
  Serial.begin(115200);
  Serial.println("Kimi Code Monitor Starting...");

  // 连接 WiFi
  connectWiFi();

  // WiFi 连接成功后，连接 SSE 服务器
  if (WiFi.status() == WL_CONNECTED) {
    connectSSE();
  }
}

// ============================================================================
// 主循环
// ============================================================================

void loop() {
  // 更新 M5Unified 内部状态（按键、触摸等需要每帧调用）
  M5.update();

  // 处理触摸输入
  handleTouch();

  // 处理物理按钮输入（M5PaperS3 有 A/B/C 三个按钮）
  handleButtons();

  // ---- SSE 事件处理与自动重连 ----
  if (sseConnected && sseClient.connected()) {
    // SSE 已连接且 TCP 连接正常，处理待读取的事件
    processSSEEvents();
  } else if (WiFi.status() == WL_CONNECTED) {
    // WiFi 正常但 SSE 断开，按间隔尝试重连
    unsigned long now = millis();
    if (now - lastReconnectAttempt > SSE_RECONNECT_MS) {
      lastReconnectAttempt = now;
      connectSSE();
    }
  } else {
    // WiFi 也断了，重新连接 WiFi
    connectWiFi();
  }

  // ---- 墨水屏按需刷新 ----
  // 只在有脏数据（displayDirty）且距上次刷新超过最小间隔时才更新
  // 墨水屏全刷需要 ~300ms，频繁刷新会导致闪烁
  unsigned long now = millis();
  if (displayDirty && (now - lastDisplayUpdate >= DISPLAY_MIN_REFRESH_MS)) {
    displayDirty = false;
    lastDisplayUpdate = now;
    updateDisplay();
  }

  delay(20);  // 短暂延时让出 CPU，同时保持输入响应性
}

// ============================================================================
// WiFi 连接
// ============================================================================

void connectWiFi() {
  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);
  statusText = "Connecting WiFi...";
  displayDirty = true;  // 标记屏幕需要刷新

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // 等待连接，超时后放弃
  unsigned long startTime = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startTime < WIFI_TIMEOUT_MS) {
    delay(500);
    Serial.print(".");
  }

  // 更新连接状态
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
    statusText = "WiFi: " + WiFi.localIP().toString();
    signalStrength = WiFi.RSSI();  // 记录信号强度
  } else {
    Serial.println("\nWiFi connection failed");
    statusText = "WiFi Failed";
  }
  displayDirty = true;  // 状态变化，标记刷新
}

// ============================================================================
// SSE 连接
// 通过 HTTP GET 请求建立 Server-Sent Events 长连接
// ============================================================================

void connectSSE() {
  // 如果已有连接，先断开
  if (sseClient.connected()) {
    sseClient.stop();
  }

  Serial.printf("Connecting to SSE server: %s:%d\n", SERVER_HOST, SERVER_PORT);
  statusText = "Connecting to server...";

  // TCP 连接到服务器
  if (sseClient.connect(SERVER_HOST, SERVER_PORT)) {
    // 发送 HTTP 请求头，建立 SSE 连接
    sseClient.print("GET /events HTTP/1.1\r\n");
    sseClient.printf("Host: %s:%d\r\n", SERVER_HOST, SERVER_PORT);
    sseClient.print("Accept: text/event-stream\r\n");
    sseClient.print("Cache-Control: no-cache\r\n");
    sseClient.print("Connection: keep-alive\r\n\r\n");

    sseConnected = true;
    statusText = "Connected";
    Serial.println("SSE connected");
  } else {
    sseConnected = false;
    statusText = "Connection failed";
    Serial.println("SSE connection failed");
  }
  displayDirty = true;
}

// ============================================================================
// SSE 事件读取与分发
// ============================================================================

void processSSEEvents() {
  // 逐行读取 SSE 数据流
  while (sseClient.available()) {
    String line = sseClient.readStringUntil('\n');

    // 跳过空行和 HTTP 响应头
    if (line.length() == 0) continue;
    if (line.startsWith("HTTP/") || line.startsWith("Content-") ||
        line.startsWith("Cache-") || line.startsWith("Connection:") ||
        line.startsWith("Access-Control-") || line.startsWith(":ok")) {
      continue;
    }

    // SSE 数据格式: "data: {json}"
    if (line.startsWith("data: ")) {
      String jsonStr = line.substring(6);  // 去掉 "data: " 前缀
      jsonStr.trim();

      if (jsonStr.length() > 0) {
        handleSSEEvent(jsonStr);  // 解析并分发事件
      }
    }
  }
}

/**
 * 解析 SSE 事件的 JSON 数据，根据 type 字段分发到对应的处理函数
 * 支持的事件类型:
 *   - "request":          LLM 请求发出
 *   - "response":         LLM 响应返回
 *   - "auth":             OAuth 认证请求（需要用户登录）
 *   - "auth_complete":    OAuth 认证完成
 *   - "approval":         工具调用审批请求
 *   - "approval_result":  审批结果通知
 */
void handleSSEEvent(const String& jsonStr) {
  StaticJsonDocument<8192> doc;
  DeserializationError error = deserializeJson(doc, jsonStr);

  if (error) {
    Serial.printf("JSON parse error: %s\n", error.c_str());
    return;
  }

  const char* type = doc["type"];
  if (type == nullptr) return;

  // 根据事件类型分发
  if (strcmp(type, "request") == 0) {
    handleRequestEvent(doc);
  } else if (strcmp(type, "response") == 0) {
    handleResponseEvent(doc);
  } else if (strcmp(type, "auth") == 0) {
    handleAuthEvent(doc);
  } else if (strcmp(type, "auth_complete") == 0) {
    handleAuthCompleteEvent(doc);
  } else if (strcmp(type, "approval") == 0) {
    handleApprovalEvent(doc);
  } else if (strcmp(type, "approval_result") == 0) {
    handleApprovalResultEvent(doc);
  }
}

// ============================================================================
// 事件处理函数
// ============================================================================

/**
 * 处理 LLM 请求事件
 * 记录 provider、model、消息数和工具数
 */
void handleRequestEvent(JsonDocument& doc) {
  const char* provider = doc["request"]["provider"];
  const char* model = doc["request"]["model"];
  int messages = doc["request"]["messages"].size();
  int tools = doc["request"]["tools"].size();

  String logMsg = String("[REQ] ") + provider + "/" + model +
                  " msgs:" + String(messages) + " tools:" + String(tools);

  addLogEntry("request", logMsg);
  Serial.println(logMsg);
}

/**
 * 处理 LLM 响应事件
 * 记录耗时、token 数，以及截断后的响应内容
 */
void handleResponseEvent(JsonDocument& doc) {
  const char* content = doc["response"]["content"];
  int duration = doc["response"]["durationMs"];
  int totalTokens = doc["response"]["usage"]["total"] | 0;

  String logMsg = String("[RES] ") + String(duration) + "ms " +
                  String(totalTokens) + " tokens";

  // 截断过长的内容以适应屏幕显示
  if (content != nullptr) {
    String contentStr = String(content);
    if (contentStr.length() > 50) {
      contentStr = contentStr.substring(0, 50) + "...";
    }
    logMsg += "\n  " + contentStr;
  }

  addLogEntry("response", logMsg);
  Serial.println(logMsg);
}

/**
 * 处理 OAuth 认证请求
 * 切换到认证界面，显示验证码和验证 URL
 */
void handleAuthEvent(JsonDocument& doc) {
  currentAuth.userCode = doc["auth"]["userCode"].as<String>();
  currentAuth.verificationUri = doc["auth"]["verificationUri"].as<String>();
  currentAuth.expiresIn = doc["auth"]["expiresIn"] | 900;  // 默认 15 分钟过期
  currentAuth.active = true;
  authStartTime = millis();  // 记录开始时间，用于倒计时

  currentMode = MODE_AUTH;   // 切换到认证界面
  displayDirty = true;

  Serial.printf("Auth required: %s\n", currentAuth.userCode.c_str());
}

/**
 * 处理 OAuth 认证完成事件
 * 返回日志界面并记录结果
 */
void handleAuthCompleteEvent(JsonDocument& doc) {
  bool success = doc["authComplete"]["success"];
  const char* message = doc["authComplete"]["message"];

  currentAuth.active = false;
  currentMode = MODE_LOGS;  // 返回日志界面
  displayDirty = true;

  String logMsg = success ? "[AUTH] Success" : "[AUTH] Failed";
  if (message != nullptr) {
    logMsg += ": " + String(message);
  }
  addLogEntry("auth", logMsg);
}

/**
 * 处理工具审批请求
 * 切换到审批界面，显示工具名称和参数
 * 如果开启了自动审批（AUTO_APPROVE），则自动批准
 */
void handleApprovalEvent(JsonDocument& doc) {
  currentApproval.requestId = doc["approval"]["requestId"].as<String>();
  currentApproval.toolName = doc["approval"]["toolName"].as<String>();
  currentApproval.toolInput = doc["approval"]["toolInput"].as<String>();
  currentApproval.active = true;
  selectedButton = 0;  // 默认选中第一个按钮

  currentMode = MODE_APPROVAL;  // 切换到审批界面
  displayDirty = true;

  Serial.printf("Approval required: %s\n", currentApproval.toolName.c_str());

  // 自动审批模式（仅用于测试，生产环境请勿开启）
  if (AUTO_APPROVE) {
    submitApproval(currentApproval.requestId, true, AUTO_APPROVE_SESSION ? "session" : nullptr);
  }
}

/**
 * 处理审批结果事件
 * 返回日志界面并记录审批结果
 */
void handleApprovalResultEvent(JsonDocument& doc) {
  bool approved = doc["approvalResult"]["approved"];
  const char* scope = doc["approvalResult"]["scope"];

  currentApproval.active = false;
  currentMode = MODE_LOGS;  // 返回日志界面
  displayDirty = true;

  String logMsg = approved ? "[APPROVED]" : "[REJECTED]";
  if (scope != nullptr && strlen(scope) > 0) {
    logMsg += " (session)";  // 标记为会话级审批
  }
  addLogEntry("approval", logMsg);
}

// ============================================================================
// HTTP API —— 提交审批结果到服务器
// ============================================================================

/**
 * 向服务器提交审批决定
 * @param requestId  审批请求 ID
 * @param approved   true=批准, false=拒绝
 * @param scope      审批范围: nullptr=单次, "session"=会话级
 * @return           true=提交成功
 */
bool submitApproval(String requestId, bool approved, const char* scope) {
  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + String(SERVER_PORT) +
               "/api/approval/" + requestId;

  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  // 构建 JSON 请求体
  StaticJsonDocument<128> doc;
  doc["approved"] = approved;
  if (scope != nullptr) {
    doc["scope"] = scope;
  }

  String body;
  serializeJson(doc, body);

  // 发送 POST 请求
  int httpCode = http.POST(body);
  http.end();

  if (httpCode == 200) {
    Serial.println("Approval submitted");
    return true;
  } else {
    Serial.printf("Approval failed: %d\n", httpCode);
    return false;
  }
}

// ============================================================================
// 日志缓冲区（环形队列）
// ============================================================================

/**
 * 向日志缓冲区添加一条记录
 * 当缓冲区满时，最旧的记录会被覆盖
 * 添加后自动滚动到底部
 */
void addLogEntry(const String& type, const String& content) {
  // 计算写入位置（环形索引）
  int index = (logStartIndex + logCount) % MAX_LOG_LINES;

  logBuffer[index].type = type;
  logBuffer[index].timestamp = getTimestamp();
  logBuffer[index].content = content;
  logBuffer[index].isNew = true;

  // 更新队列计数，满了就移动起始指针（丢弃最旧的）
  if (logCount < MAX_LOG_LINES) {
    logCount++;
  } else {
    logStartIndex = (logStartIndex + 1) % MAX_LOG_LINES;
  }

  // 自动滚动到最新日志
  int maxVisible = (M5.Lcd.height() - STATUS_BAR_HEIGHT - FOOTER_HEIGHT) / LOG_LINE_HEIGHT;
  scrollOffset = max(0, logCount - maxVisible);
  displayDirty = true;  // 有新数据，标记屏幕刷新
}

/**
 * 获取设备运行时间格式的时间戳 HH:MM:SS
 * 注意: 这是相对时间（自开机以来），不是真实时钟时间
 */
String getTimestamp() {
  unsigned long ms = millis();
  unsigned long s = ms / 1000;
  unsigned long m = s / 60;
  unsigned long h = m / 60;

  char buf[16];
  snprintf(buf, sizeof(buf), "%02lu:%02lu:%02lu", h % 24, m % 60, s % 60);
  return String(buf);
}

// ============================================================================
// 输入处理
// ============================================================================

/**
 * 处理触摸输入
 * 使用边沿检测（按下瞬间触发一次），避免按住时重复触发
 */
void handleTouch() {
  auto touch = M5.Touch.getDetail();

  if (touch.isPressed() && !touchPressed) {
    // 按下瞬间：记录坐标并分发
    touchPressed = true;
    touchX = touch.x;
    touchY = touch.y;
    handleTouchPress(touchX, touchY);
  } else if (!touch.isPressed()) {
    // 松开：重置状态
    touchPressed = false;
  }
}

/**
 * 处理触摸按下事件
 * 根据当前界面模式和触摸位置执行不同操作
 *
 * 审批模式: 底部三个按钮区域（批准/会话批准/拒绝）
 * 日志模式: 右侧边缘区域（上滚/下滚）
 */
void handleTouchPress(int x, int y) {
  if (currentMode == MODE_APPROVAL) {
    // 审批模式：底部按钮区域
    if (y > M5.Lcd.height() - 80) {
      int btnWidth = M5.Lcd.width() / 3;
      if (x < btnWidth) {
        // 左 1/3: 批准（单次）
        submitApproval(currentApproval.requestId, true, nullptr);
      } else if (x < btnWidth * 2) {
        // 中 1/3: 批准（会话级）
        submitApproval(currentApproval.requestId, true, "session");
      } else {
        // 右 1/3: 拒绝
        submitApproval(currentApproval.requestId, false, nullptr);
      }
      displayDirty = true;
    }
  } else if (currentMode == MODE_LOGS) {
    // 日志模式：右侧 40px 区域为滚动热区
    if (x > M5.Lcd.width() - 40) {
      int maxVisible = (M5.Lcd.height() - STATUS_BAR_HEIGHT - FOOTER_HEIGHT) / LOG_LINE_HEIGHT;
      if (y < M5.Lcd.height() / 2) {
        // 上半部分: 向上滚动
        scrollOffset = max(0, scrollOffset - 1);
      } else {
        // 下半部分: 向下滚动
        scrollOffset = min(max(0, logCount - maxVisible), scrollOffset + 1);
      }
      displayDirty = true;
    }
  }
}

/**
 * 处理物理按钮（A/B/C）
 *
 * 审批模式:
 *   A = 拒绝, B = 会话级批准, C = 拒绝
 *
 * 日志模式:
 *   B = 向上翻页（3行）, C = 向下翻页（3行）
 */
void handleButtons() {
  bool changed = false;

  // 按钮 A
  if (M5.BtnA.wasPressed()) {
    if (currentMode == MODE_APPROVAL) {
      submitApproval(currentApproval.requestId, false, nullptr);
      changed = true;
    }
  }

  // 按钮 B
  if (M5.BtnB.wasPressed()) {
    if (currentMode == MODE_APPROVAL) {
      submitApproval(currentApproval.requestId, true, "session");
      changed = true;
    } else if (currentMode == MODE_LOGS) {
      scrollOffset = max(0, scrollOffset - 3);  // 上翻 3 行
      changed = true;
    }
  }

  // 按钮 C
  if (M5.BtnC.wasPressed()) {
    if (currentMode == MODE_APPROVAL) {
      submitApproval(currentApproval.requestId, false, nullptr);
      changed = true;
    } else if (currentMode == MODE_LOGS) {
      int maxVisible = (M5.Lcd.height() - STATUS_BAR_HEIGHT - FOOTER_HEIGHT) / LOG_LINE_HEIGHT;
      scrollOffset = min(max(0, logCount - maxVisible), scrollOffset + 3);  // 下翻 3 行
      changed = true;
    }
  }

  if (changed) displayDirty = true;
}

// ============================================================================
// 显示渲染（直接写 M5.Lcd，不使用 Canvas）
// 墨水屏直接绘制比 Canvas + pushSprite 更可靠
// ============================================================================

/**
 * 根据当前模式刷新整个屏幕
 * 策略: 大多数时候用快速局部刷新（不闪），每 N 次后做一次全刷清残影
 */
void updateDisplay() {
  // 判断是否需要全刷（清残影）
  bool fullRefresh = (partialRefreshCount >= FULL_REFRESH_EVERY);
  if (fullRefresh) {
    partialRefreshCount = 0;
    // 全刷模式: 画面干净，会有一次黑→白闪烁
    M5.Lcd.setEpdMode(lgfx::epd_mode::epd_quality);
  } else {
    partialRefreshCount++;
    // 局部刷新模式: 速度快，不闪烁，但多次后会有残影
    M5.Lcd.setEpdMode(lgfx::epd_mode::epd_fast);
  }

  M5.Lcd.fillScreen(TFT_WHITE);  // 清屏

  switch (currentMode) {
    case MODE_LOGS:
      drawLogScreen();
      break;
    case MODE_APPROVAL:
      drawApprovalScreen();
      break;
    case MODE_AUTH:
      drawAuthScreen();
      break;
    default:
      drawLogScreen();
      break;
  }

  // 恢复默认全刷模式
  M5.Lcd.setEpdMode(lgfx::epd_mode::epd_quality);
}

/**
 * 绘制启动画面
 * 在 WiFi 连接前显示
 */
void drawSplashScreen() {
  M5.Lcd.fillScreen(TFT_WHITE);

  M5.Lcd.setTextSize(3);
  M5.Lcd.setTextColor(TFT_BLACK);
  M5.Lcd.setTextDatum(MC_DATUM);  // 居中对齐

  M5.Lcd.drawString("Kimi Code Monitor", M5.Lcd.width() / 2, M5.Lcd.height() / 2 - 50);
  M5.Lcd.setTextSize(2);
  M5.Lcd.drawString("LLM Communication Viewer", M5.Lcd.width() / 2, M5.Lcd.height() / 2);
  M5.Lcd.drawString("Connecting...", M5.Lcd.width() / 2, M5.Lcd.height() / 2 + 40);
}

/**
 * 绘制顶部状态栏
 * 显示连接状态文本和 WiFi 信号强度
 */
void drawStatusBar() {
  // 黑色背景条
  M5.Lcd.fillRect(0, 0, M5.Lcd.width(), STATUS_BAR_HEIGHT, TFT_BLACK);

  M5.Lcd.setTextSize(2);
  M5.Lcd.setTextColor(TFT_WHITE);
  M5.Lcd.setTextDatum(ML_DATUM);  // 左中对齐

  // 左侧: 连接状态文本
  M5.Lcd.drawString(" " + statusText, 4, STATUS_BAR_HEIGHT / 2);

  // 右侧: WiFi 信号强度
  M5.Lcd.setTextDatum(MR_DATUM);  // 右中对齐
  String wifiStr = "WiFi:" + String(abs(signalStrength)) + "dBm";
  M5.Lcd.drawString(wifiStr + " ", M5.Lcd.width() - 4, STATUS_BAR_HEIGHT / 2);
}

/**
 * 绘制日志列表界面
 * 显示带颜色标记的滚动日志，支持上下滚动指示器
 *
 * 颜色方案:
 *   蓝色 = LLM 请求  绿色 = LLM 响应
 *   橙色 = 审批       紫色 = 认证
 */
void drawLogScreen() {
  drawStatusBar();

  // 日志区域起始 Y 坐标
  int y = STATUS_BAR_HEIGHT + 6;
  int lineHeight = LOG_LINE_HEIGHT;
  int maxLines = (M5.Lcd.height() - STATUS_BAR_HEIGHT - FOOTER_HEIGHT) / lineHeight;

  M5.Lcd.setTextSize(2);
  M5.Lcd.setTextDatum(TL_DATUM);  // 左上对齐（drawStatusBar 末尾设成了右对齐）

  // 遍历可见范围内的日志条目
  for (int i = 0; i < maxLines && (i + scrollOffset) < logCount; i++) {
    int idx = (logStartIndex + i + scrollOffset) % MAX_LOG_LINES;
    LogEntry& entry = logBuffer[idx];

    // 根据日志类型设置颜色
    if (entry.type == "request") {
      M5.Lcd.setTextColor(TFT_BLUE);
    } else if (entry.type == "response") {
      M5.Lcd.setTextColor(TFT_GREEN);
    } else if (entry.type == "approval") {
      M5.Lcd.setTextColor(TFT_ORANGE);
    } else if (entry.type == "auth") {
      M5.Lcd.setTextColor(TFT_PURPLE);
    } else {
      M5.Lcd.setTextColor(TFT_BLACK);
    }

    // 拼接时间戳和内容，超出宽度则截断加省略号
    String line = entry.timestamp + " " + entry.content;
    int maxChars = (M5.Lcd.width() - 50) / 12;  // textSize(2) 约 12px 宽/字符
    if (line.length() > maxChars) {
      line = line.substring(0, maxChars) + "...";
    }
    M5.Lcd.drawString(line, 4, y);
    y += lineHeight;
  }

  // 向上滚动指示器（顶部三角形）
  if (scrollOffset > 0) {
    M5.Lcd.fillTriangle(M5.Lcd.width() - 20, STATUS_BAR_HEIGHT + 10,
                        M5.Lcd.width() - 10, STATUS_BAR_HEIGHT + 20,
                        M5.Lcd.width() - 30, STATUS_BAR_HEIGHT + 20, TFT_BLACK);
  }
  // 向下滚动指示器（底部三角形）
  if (scrollOffset < max(0, logCount - maxLines)) {
    M5.Lcd.fillTriangle(M5.Lcd.width() - 20, M5.Lcd.height() - FOOTER_HEIGHT - 10,
                        M5.Lcd.width() - 10, M5.Lcd.height() - FOOTER_HEIGHT - 20,
                        M5.Lcd.width() - 30, M5.Lcd.height() - FOOTER_HEIGHT - 20, TFT_BLACK);
  }

  // 底部操作提示
  drawFooter("Scroll:BtnB/C  Menu:Touch");
}

/**
 * 绘制工具审批界面
 * 显示工具名称、参数，以及三个操作按钮
 */
void drawApprovalScreen() {
  drawStatusBar();

  // 标题
  M5.Lcd.setTextSize(3);
  M5.Lcd.setTextColor(TFT_RED);
  M5.Lcd.setTextDatum(MC_DATUM);
  M5.Lcd.drawString("APPROVAL REQUIRED", M5.Lcd.width() / 2, 60);

  // 工具名称
  M5.Lcd.setTextSize(2);
  M5.Lcd.setTextColor(TFT_BLACK);
  M5.Lcd.drawString("Tool: " + currentApproval.toolName, M5.Lcd.width() / 2, 100);

  // 工具输入参数（自动换行显示）
  M5.Lcd.setTextDatum(TL_DATUM);  // 左上对齐
  int y = 130;
  String input = currentApproval.toolInput;
  int maxChars = (M5.Lcd.width() - 40) / 12;  // textSize(2) 约 12px 宽/字符

  while (input.length() > 0 && y < M5.Lcd.height() - 120) {
    String line = input.substring(0, min(maxChars, (int)input.length()));
    if (input.length() > maxChars) {
      input = input.substring(maxChars);
    } else {
      input = "";
    }
    M5.Lcd.drawString(line, 20, y);
    y += LOG_LINE_HEIGHT;
  }

  // 底部三个按钮
  int btnY = M5.Lcd.height() - 80;
  int btnWidth = M5.Lcd.width() / 3;

  // 绿色: 批准（单次）
  M5.Lcd.fillRect(10, btnY, btnWidth - 20, 50, TFT_GREEN);
  M5.Lcd.setTextColor(TFT_WHITE);
  M5.Lcd.setTextDatum(MC_DATUM);
  M5.Lcd.drawString("APPROVE", btnWidth / 2, btnY + 25);

  // 蓝色: 批准（会话级）
  M5.Lcd.fillRect(btnWidth + 10, btnY, btnWidth - 20, 50, TFT_BLUE);
  M5.Lcd.drawString("SESSION", btnWidth + btnWidth / 2, btnY + 25);

  // 红色: 拒绝
  M5.Lcd.fillRect(btnWidth * 2 + 10, btnY, btnWidth - 20, 50, TFT_RED);
  M5.Lcd.drawString("REJECT", btnWidth * 2 + btnWidth / 2, btnY + 25);
}

/**
 * 绘制 OAuth 认证界面
 * 显示验证码、验证 URL 和过期倒计时
 */
void drawAuthScreen() {
  drawStatusBar();

  // 标题
  M5.Lcd.setTextSize(3);
  M5.Lcd.setTextColor(TFT_PURPLE);
  M5.Lcd.setTextDatum(MC_DATUM);
  M5.Lcd.drawString("LOGIN REQUIRED", M5.Lcd.width() / 2, 60);

  // 验证码（大字体显示，方便用户抄写）
  M5.Lcd.setTextSize(4);
  M5.Lcd.setTextColor(TFT_BLACK);
  M5.Lcd.drawString(currentAuth.userCode, M5.Lcd.width() / 2, 120);

  // 验证 URL
  M5.Lcd.setTextSize(2);
  M5.Lcd.setTextColor(TFT_BLUE);
  M5.Lcd.drawString(currentAuth.verificationUri, M5.Lcd.width() / 2, 170);

  // 过期倒计时
  if (currentAuth.expiresIn > 0) {
    unsigned long elapsed = (millis() - authStartTime) / 1000;
    int remaining = currentAuth.expiresIn - elapsed;

    if (remaining > 0) {
      M5.Lcd.setTextColor(TFT_RED);
      M5.Lcd.drawString("Expires in: " + String(remaining) + "s", M5.Lcd.width() / 2, 210);
    } else {
      M5.Lcd.setTextColor(TFT_RED);
      M5.Lcd.drawString("EXPIRED", M5.Lcd.width() / 2, 210);
    }
  }

  // 操作说明
  M5.Lcd.setTextColor(TFT_BLACK);
  M5.Lcd.setTextDatum(MC_DATUM);
  M5.Lcd.drawString("Open the URL above and enter the code", M5.Lcd.width() / 2, 260);
  M5.Lcd.drawString("Press any button to dismiss", M5.Lcd.width() / 2, 290);

  drawFooter("Dismiss:BtnA/B/C");
}

/**
 * 绘制底部提示栏
 * @param text  提示文本（如 "Scroll:BtnB/C  Menu:Touch"）
 */
void drawFooter(const String& text) {
  int footerY = M5.Lcd.height() - FOOTER_HEIGHT;

  // 浅灰色背景
  M5.Lcd.fillRect(0, footerY, M5.Lcd.width(), FOOTER_HEIGHT, TFT_LIGHTGREY);
  M5.Lcd.setTextSize(2);
  M5.Lcd.setTextColor(TFT_BLACK);
  M5.Lcd.setTextDatum(MC_DATUM);  // 居中
  M5.Lcd.drawString(text, M5.Lcd.width() / 2, footerY + FOOTER_HEIGHT / 2);
}
