/*
 * Kimi Code LLM Communication Monitor
 * Hardware: M5PaperS3 (ESP32-S3 + 4.7" E-Paper 540x960)
 * Library: M5GFX
 *
 * Features:
 * - WiFi connection to Kimi Code LLM Log Server
 * - Real-time SSE event display
 * - Tool approval with touch buttons
 * - E-paper optimized rendering
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <M5GFX.h>
#include <M5Unified.h>
#include "config.h"

// ============================================================================
// Global Variables
// ============================================================================

M5GFX display;
M5Canvas canvas(&display);

// WiFi and SSE
WiFiClient sseClient;
bool sseConnected = false;
unsigned long lastReconnectAttempt = 0;

// Display state
enum DisplayMode {
  MODE_LOGS,
  MODE_APPROVAL,
  MODE_AUTH,
  MODE_WIFI_CONFIG
};

DisplayMode currentMode = MODE_LOGS;

// Log buffer
struct LogEntry {
  String type;
  String timestamp;
  String content;
  bool isNew;
};

LogEntry logBuffer[MAX_LOG_LINES];
int logCount = 0;
int logStartIndex = 0;

// Approval state
struct ApprovalRequest {
  String requestId;
  String toolName;
  String toolInput;
  bool active;
};

ApprovalRequest currentApproval;
int selectedButton = 0;  // 0=approve, 1=session, 2=reject

// Auth state
struct AuthRequest {
  String userCode;
  String verificationUri;
  int expiresIn;
  bool active;
};

AuthRequest currentAuth;
unsigned long authStartTime = 0;

// Scroll position
int scrollOffset = 0;

// Touch state
bool touchPressed = false;
int touchX = 0;
int touchY = 0;

// Status bar
String statusText = "Disconnected";
int signalStrength = 0;

// ============================================================================
// Setup
// ============================================================================

void setup() {
  // Initialize M5
  auto cfg = M5.config();
  M5.begin(cfg);

  // Initialize display
  display.begin();
  display.setRotation(1);  // Landscape mode
  display.fillScreen(TFT_WHITE);

  // Create canvas for double buffering
  canvas.setColorDepth(1);
  canvas.createSprite(display.width(), display.height());
  canvas.setTextWrap(true);

  // Show splash screen
  drawSplashScreen();

  // Initialize Serial for debug
  Serial.begin(115200);
  Serial.println("Kimi Code Monitor Starting...");

  // Connect WiFi
  connectWiFi();

  // Connect SSE
  if (WiFi.status() == WL_CONNECTED) {
    connectSSE();
  }
}

// ============================================================================
// Main Loop
// ============================================================================

void loop() {
  M5.update();

  // Handle touch input
  handleTouch();

  // Handle button input (M5PaperS3 has physical buttons)
  handleButtons();

  // Process SSE events
  if (sseConnected && sseClient.connected()) {
    processSSEEvents();
  } else if (WiFi.status() == WL_CONNECTED) {
    // Reconnect SSE if disconnected
    unsigned long now = millis();
    if (now - lastReconnectAttempt > RECONNECT_DELAY_MS) {
      lastReconnectAttempt = now;
      connectSSE();
    }
  } else {
    // Reconnect WiFi if disconnected
    connectWiFi();
  }

  // Update display
  updateDisplay();

    delay(DISPLAY_REFRESH_MS);
  }

  // Handle touch input
  handleTouch();

  // Handle button input (M5PaperS3 has physical buttons)
  handleButtons();

  // Process SSE events
  if (sseConnected && sseClient.connected()) {
    processSSEEvents();
  } else if (WiFi.status() == WL_CONNECTED) {
    // Reconnect SSE if disconnected
    unsigned long now = millis();
    if (now - lastReconnectAttempt > SSE_RECONNECT_MS) {
      lastReconnectAttempt = now;
      connectSSE();
    }
  } else {
    // Reconnect WiFi if disconnected
    connectWiFi();
  }

  // Update display
  updateDisplay();

  delay(DISPLAY_REFRESH_MS);
}

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
    statusText = "WiFi: " + WiFi.localIP().toString();
    signalStrength = WiFi.RSSI();
  } else {
    Serial.println("\nWiFi connection failed");
    statusText = "WiFi Failed";
  }
}

// ============================================================================
// SSE Connection
// ============================================================================

void connectSSE() {
  if (sseClient.connected()) {
    sseClient.stop();
  }

  Serial.printf("Connecting to SSE server: %s:%d\n", SERVER_HOST, SERVER_PORT);
  statusText = "Connecting to server...";

  if (sseClient.connect(SERVER_HOST, SERVER_PORT)) {
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
}

// ============================================================================
// SSE Event Processing
// ============================================================================

void processSSEEvents() {
  while (sseClient.available()) {
    String line = sseClient.readStringUntil('\n');

    // Skip empty lines and HTTP headers
    if (line.length() == 0) continue;
    if (line.startsWith("HTTP/") || line.startsWith("Content-") ||
        line.startsWith("Cache-") || line.startsWith("Connection:") ||
        line.startsWith("Access-Control-") || line.startsWith(":ok")) {
      continue;
    }

    // Parse SSE data
    if (line.startsWith("data: ")) {
      String jsonStr = line.substring(6);
      jsonStr.trim();

      if (jsonStr.length() > 0) {
        handleSSEEvent(jsonStr);
      }
    }
  }
}

void handleSSEEvent(const String& jsonStr) {
  StaticJsonDocument<8192> doc;
  DeserializationError error = deserializeJson(doc, jsonStr);

  if (error) {
    Serial.printf("JSON parse error: %s\n", error.c_str());
    return;
  }

  const char* type = doc["type"];
  if (type == nullptr) return;

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
// Event Handlers
// ============================================================================

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

void handleResponseEvent(JsonDocument& doc) {
  const char* content = doc["response"]["content"];
  int duration = doc["response"]["durationMs"];
  int totalTokens = doc["response"]["usage"]["total"] | 0;

  String logMsg = String("[RES] ") + String(duration) + "ms " +
                  String(totalTokens) + " tokens";

  // Truncate content for display
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

void handleAuthEvent(JsonDocument& doc) {
  currentAuth.userCode = doc["auth"]["userCode"].as<String>();
  currentAuth.verificationUri = doc["auth"]["verificationUri"].as<String>();
  currentAuth.expiresIn = doc["auth"]["expiresIn"] | 900;
  currentAuth.active = true;
  authStartTime = millis();

  currentMode = MODE_AUTH;

  Serial.printf("Auth required: %s\n", currentAuth.userCode.c_str());
}

void handleAuthCompleteEvent(JsonDocument& doc) {
  bool success = doc["authComplete"]["success"];
  const char* message = doc["authComplete"]["message"];

  currentAuth.active = false;
  currentMode = MODE_LOGS;

  String logMsg = success ? "[AUTH] Success" : "[AUTH] Failed";
  if (message != nullptr) {
    logMsg += ": " + String(message);
  }
  addLogEntry("auth", logMsg);
}

void handleApprovalEvent(JsonDocument& doc) {
  currentApproval.requestId = doc["approval"]["requestId"].as<String>();
  currentApproval.toolName = doc["approval"]["toolName"].as<String>();
  currentApproval.toolInput = doc["approval"]["toolInput"].as<String>();
  currentApproval.active = true;
  selectedButton = 0;

  currentMode = MODE_APPROVAL;

  Serial.printf("Approval required: %s\n", currentApproval.toolName.c_str());

  // Auto-approve if enabled
  if (AUTO_APPROVE) {
    submitApproval(currentApproval.requestId, true, AUTO_APPROVE_SESSION ? "session" : nullptr);
  }
}

void handleApprovalResultEvent(JsonDocument& doc) {
  bool approved = doc["approvalResult"]["approved"];
  const char* scope = doc["approvalResult"]["scope"];

  currentApproval.active = false;
  currentMode = MODE_LOGS;

  String logMsg = approved ? "[APPROVED]" : "[REJECTED]";
  if (scope != nullptr && strlen(scope) > 0) {
    logMsg += " (session)";
  }
  addLogEntry("approval", logMsg);
}

// ============================================================================
// HTTP API
// ============================================================================

bool submitApproval(String requestId, bool approved, const char* scope) {
  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + String(SERVER_PORT) +
               "/api/approval/" + requestId;

  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<128> doc;
  doc["approved"] = approved;
  if (scope != nullptr) {
    doc["scope"] = scope;
  }

  String body;
  serializeJson(doc, body);

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
// Log Buffer
// ============================================================================

void addLogEntry(const String& type, const String& content) {
  int index = (logStartIndex + logCount) % MAX_LOG_LINES;

  logBuffer[index].type = type;
  logBuffer[index].timestamp = getTimestamp();
  logBuffer[index].content = content;
  logBuffer[index].isNew = true;

  if (logCount < MAX_LOG_LINES) {
    logCount++;
  } else {
    logStartIndex = (logStartIndex + 1) % MAX_LOG_LINES;
  }

  // Auto-scroll to bottom
  int maxVisible = (display.height() - STATUS_BAR_HEIGHT - FOOTER_HEIGHT) / LOG_LINE_HEIGHT;
  scrollOffset = max(0, logCount - maxVisible);
}

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
// Input Handling
// ============================================================================

void handleTouch() {
  auto touch = M5.Touch.getDetail();

  if (touch.isPressed() && !touchPressed) {
    touchPressed = true;
    touchX = touch.x;
    touchY = touch.y;
    handleTouchPress(touchX, touchY);
  } else if (!touch.isPressed()) {
    touchPressed = false;
  }
}

void handleTouchPress(int x, int y) {
  if (currentMode == MODE_APPROVAL) {
    // Approval button area (bottom of screen)
    if (y > display.height() - 80) {
      int btnWidth = display.width() / 3;
      if (x < btnWidth) {
        // Approve button
        submitApproval(currentApproval.requestId, true, nullptr);
      } else if (x < btnWidth * 2) {
        // Approve for session button
        submitApproval(currentApproval.requestId, true, "session");
      } else {
        // Reject button
        submitApproval(currentApproval.requestId, false, nullptr);
      }
    }
  } else if (currentMode == MODE_LOGS) {
    // Scroll buttons (right side)
    if (x > display.width() - 40) {
      int maxVisible = (display.height() - STATUS_BAR_HEIGHT - FOOTER_HEIGHT) / LOG_LINE_HEIGHT;
      if (y < display.height() / 2) {
        // Scroll up
        scrollOffset = max(0, scrollOffset - 1);
      } else {
        // Scroll down
        scrollOffset = min(max(0, logCount - maxVisible), scrollOffset + 1);
      }
    }
  }
}

void handleButtons() {
  // M5PaperS3 has physical buttons
  if (M5.BtnA.wasPressed()) {
    if (currentMode == MODE_APPROVAL) {
      // Approve
      submitApproval(currentApproval.requestId, false, nullptr);
    }
  }

  if (M5.BtnB.wasPressed()) {
    if (currentMode == MODE_APPROVAL) {
      // Approve for session
      submitApproval(currentApproval.requestId, true, "session");
    } else if (currentMode == MODE_LOGS) {
      // Scroll up
      int maxVisible = (display.height() - STATUS_BAR_HEIGHT - FOOTER_HEIGHT) / LOG_LINE_HEIGHT;
      scrollOffset = max(0, scrollOffset - 3);
    }
  }

  if (M5.BtnC.wasPressed()) {
    if (currentMode == MODE_APPROVAL) {
      // Reject
      submitApproval(currentApproval.requestId, false, nullptr);
    } else if (currentMode == MODE_LOGS) {
      // Scroll down
      int maxVisible = (display.height() - STATUS_BAR_HEIGHT - FOOTER_HEIGHT) / LOG_LINE_HEIGHT;
      scrollOffset = min(max(0, logCount - maxVisible), scrollOffset + 3);
    }
  }
}

// ============================================================================
// Display Rendering
// ============================================================================

void updateDisplay() {
  canvas.fillScreen(TFT_WHITE);

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

  // Push canvas to display
  canvas.pushSprite(0, 0);
}

void drawSplashScreen() {
  canvas.fillScreen(TFT_WHITE);

  canvas.setTextSize(2);
  canvas.setTextColor(TFT_BLACK);
  canvas.setTextDatum(MC_DATUM);

  canvas.drawString("Kimi Code Monitor", display.width() / 2, display.height() / 2 - 40);
  canvas.setTextSize(1);
  canvas.drawString("LLM Communication Viewer", display.width() / 2, display.height() / 2);
  canvas.drawString("Connecting...", display.width() / 2, display.height() / 2 + 30);

  canvas.pushSprite(0, 0);
}

void drawStatusBar() {
  // Status bar background
  canvas.fillRect(0, 0, display.width(), 24, TFT_BLACK);

  canvas.setTextSize(1);
  canvas.setTextColor(TFT_WHITE);
  canvas.setTextDatum(ML_DATUM);

  // Status text
  canvas.drawString(" " + statusText, 4, 12);

  // WiFi signal
  canvas.setTextDatum(MR_DATUM);
  String wifiStr = "WiFi:" + String(abs(signalStrength)) + "dBm";
  canvas.drawString(wifiStr + " ", display.width() - 4, 12);
}

void drawLogScreen() {
  drawStatusBar();

  // Log area
  int y = STATUS_BAR_HEIGHT + 6;
  int lineHeight = LOG_LINE_HEIGHT;
  int maxLines = (display.height() - STATUS_BAR_HEIGHT - FOOTER_HEIGHT) / lineHeight;

  canvas.setTextSize(1);

  for (int i = 0; i < maxLines && (i + scrollOffset) < logCount; i++) {
    int idx = (logStartIndex + i + scrollOffset) % MAX_LOG_LINES;
    LogEntry& entry = logBuffer[idx];

    // Set color based on type
    if (entry.type == "request") {
      canvas.setTextColor(TFT_BLUE);
    } else if (entry.type == "response") {
      canvas.setTextColor(TFT_GREEN);
    } else if (entry.type == "approval") {
      canvas.setTextColor(TFT_ORANGE);
    } else if (entry.type == "auth") {
      canvas.setTextColor(TFT_PURPLE);
    } else {
      canvas.setTextColor(TFT_BLACK);
    }

    // Draw timestamp and content
    String line = entry.timestamp + " " + entry.content;
    int maxChars = (display.width() - 50) / 6;  // Approximate chars per line
    if (line.length() > maxChars) {
      line = line.substring(0, maxChars) + "...";
    }
    canvas.drawString(line, 4, y);
    y += lineHeight;
  }

  // Scroll indicators
  if (scrollOffset > 0) {
    canvas.fillTriangle(display.width() - 20, STATUS_BAR_HEIGHT + 10,
                        display.width() - 10, STATUS_BAR_HEIGHT + 20,
                        display.width() - 30, STATUS_BAR_HEIGHT + 20, TFT_BLACK);
  }
  if (scrollOffset < max(0, logCount - maxLines)) {
    canvas.fillTriangle(display.width() - 20, display.height() - FOOTER_HEIGHT - 10,
                        display.width() - 10, display.height() - FOOTER_HEIGHT - 20,
                        display.width() - 30, display.height() - FOOTER_HEIGHT - 20, TFT_BLACK);
  }

  // Footer
  drawFooter("Scroll:BtnB/C  Menu:Touch");
}

void drawApprovalScreen() {
  drawStatusBar();

  // Title
  canvas.setTextSize(2);
  canvas.setTextColor(TFT_RED);
  canvas.setTextDatum(MC_DATUM);
  canvas.drawString("APPROVAL REQUIRED", display.width() / 2, 60);

  // Tool name
  canvas.setTextSize(1);
  canvas.setTextColor(TFT_BLACK);
  canvas.drawString("Tool: " + currentApproval.toolName, display.width() / 2, 100);

  // Tool input (wrapped)
  canvas.setTextDatum(TL_DATUM);
  int y = 130;
  String input = currentApproval.toolInput;
  int maxChars = (display.width() - 40) / 6;  // Approximate chars per line

  while (input.length() > 0 && y < display.height() - 120) {
    String line = input.substring(0, min(maxChars, (int)input.length()));
    if (input.length() > maxChars) {
      input = input.substring(maxChars);
    } else {
      input = "";
    }
    canvas.drawString(line, 20, y);
    y += LOG_LINE_HEIGHT;
  }

  // Buttons
  int btnY = display.height() - 80;
  int btnWidth = display.width() / 3;

  // Approve button
  canvas.fillRect(10, btnY, btnWidth - 20, 50, TFT_GREEN);
  canvas.setTextColor(TFT_WHITE);
  canvas.setTextDatum(MC_DATUM);
  canvas.drawString("APPROVE", btnWidth / 2, btnY + 25);

  // Approve for session button
  canvas.fillRect(btnWidth + 10, btnY, btnWidth - 20, 50, TFT_BLUE);
  canvas.drawString("SESSION", btnWidth + btnWidth / 2, btnY + 25);

  // Reject button
  canvas.fillRect(btnWidth * 2 + 10, btnY, btnWidth - 20, 50, TFT_RED);
  canvas.drawString("REJECT", btnWidth * 2 + btnWidth / 2, btnY + 25);
}

void drawAuthScreen() {
  drawStatusBar();

  // Title
  canvas.setTextSize(2);
  canvas.setTextColor(TFT_PURPLE);
  canvas.setTextDatum(MC_DATUM);
  canvas.drawString("LOGIN REQUIRED", display.width() / 2, 60);

  // User code
  canvas.setTextSize(3);
  canvas.setTextColor(TFT_BLACK);
  canvas.drawString(currentAuth.userCode, display.width() / 2, 120);

  // URL
  canvas.setTextSize(1);
  canvas.setTextColor(TFT_BLUE);
  canvas.drawString(currentAuth.verificationUri, display.width() / 2, 170);

  // Timer
  if (currentAuth.expiresIn > 0) {
    unsigned long elapsed = (millis() - authStartTime) / 1000;
    int remaining = currentAuth.expiresIn - elapsed;

    if (remaining > 0) {
      canvas.setTextColor(TFT_RED);
      canvas.drawString("Expires in: " + String(remaining) + "s", display.width() / 2, 210);
    } else {
      canvas.setTextColor(TFT_RED);
      canvas.drawString("EXPIRED", display.width() / 2, 210);
    }
  }

  // Instructions
  canvas.setTextColor(TFT_BLACK);
  canvas.setTextDatum(MC_DATUM);
  canvas.drawString("Open the URL above and enter the code", display.width() / 2, 260);
  canvas.drawString("Press any button to dismiss", display.width() / 2, 290);

  drawFooter("Dismiss:BtnA/B/C");
}

void drawFooter(const String& text) {
  int footerY = display.height() - FOOTER_HEIGHT;

  canvas.fillRect(0, footerY, display.width(), FOOTER_HEIGHT, TFT_LIGHTGREY);
  canvas.setTextSize(1);
  canvas.setTextColor(TFT_BLACK);
  canvas.setTextDatum(MC_DATUM);
  canvas.drawString(text, display.width() / 2, footerY + FOOTER_HEIGHT / 2);
}
