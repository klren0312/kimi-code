/**
 * Kimi Paper Client for M5PaperS3
 *
 * Connects to Kimi Code Server via WebSocket + REST API.
 * Displays conversation on the 4.7" e-ink screen.
 *
 * Required libraries:
 *   - M5Unified (M5PaperS3 board support)
 *   - WebSockets (by Markus Sattler)
 *   - ArduinoJson (by Benoit Blanchon)
 *
 * Wiring: none needed, M5PaperS3 has everything on board.
 */

#include <M5Unified.h>
#include "KimiClient.h"
#include "KimiDisplay.h"

// ============ CONFIGURATION ============
const char* WIFI_SSID = "your-ssid";
const char* WIFI_PASS = "your-password";
const char* SERVER_HOST = "192.168.1.100"; // Kimi Server IP
const uint16_t SERVER_PORT = 58627;
const char* SESSION_ID = "";               // leave empty to create new
const char* DEFAULT_MODEL = "";            // leave empty for server default
// =======================================

KimiClient client;
KimiDisplay display;

String currentSessionId;
String activePromptId;
String assistantBuffer;

enum AppMode { MODE_CHAT, MODE_PRESET_SELECT };
AppMode appMode = MODE_CHAT;

unsigned long lastHeartbeatCheck = 0;
bool wsReady = false;

// ============ Forward Declarations ============
void setupWiFiAndServer();
void setupWSSession();
void createSession();
void handleEvent(const KimiEvent& ev);
void submitPromptText(const String& text);
void onLog(const String& msg);
void handleBtnA();
void handleBtnB();
void handleBtnC();
void handleBtnPower();
unsigned long lastButtonCheck = 0;

// ============ Arduino Entry Points ============

void setup() {
  Serial.begin(115200);
  delay(500);

  display.begin();

  client.setLogCallback(onLog);
  client.setEventCallback(handleEvent);
  client.setWiFiConfig(WIFI_SSID, WIFI_PASS);
  client.setServerConfig(SERVER_HOST, SERVER_PORT);

  setupWiFiAndServer();
}

void loop() {
  client.loop();

  // handle buttons (debounced, ~100ms)
  if (millis() - lastButtonCheck > 100) {
    lastButtonCheck = millis();
    M5.update();

    if (M5.BtnA.wasPressed()) handleBtnA();
    if (M5.BtnB.wasPressed()) handleBtnB();
    if (M5.BtnC.wasPressed()) handleBtnC();
    if (M5.BtnP.wasPressed()) handleBtnPower();
  }

  // prompt to create session if not set
  if (client.isConnected() && currentSessionId.length() == 0) {
    createSession();
  }
}

// ============ WiFi + Server Setup ============

void setupWiFiAndServer() {
  display.drawStatusBar("Kimi", "Connecting WiFi...");

  if (!client.connectWiFi(20000)) {
    display.showSplash("WiFi Failed!");
    display.drawStatusBar("ERROR", "No WiFi");
    return;
  }

  display.drawStatusBar("Kimi", client.isWifiConnected() ? "WiFi OK" : "WiFi...");

  if (!client.connectWS(15000)) {
    display.showSplash("Server unreachable!");
    display.drawStatusBar("ERROR", "No Server");
    return;
  }

  display.drawStatusBar("Kimi", "WS Connected");
}

void setupWSSession() {
  client.subscribe(currentSessionId);
  display.drawStatusBar("Session", currentSessionId.substring(0, 16) + "...");
}

// ============ Session Management ============

void createSession() {
  HTTPClient http;
  WiFiClient wc;
  String url = "http://" + String(SERVER_HOST) + ":" + String(SERVER_PORT) + "/api/v1/sessions";

  http.begin(wc, url);
  http.addHeader("Content-Type", "application/json");

  JsonDocument body;
  body["title"] = "M5PaperS3";
  body["metadata"]["cwd"] = "/home/user/project";
  JsonObject ac = body["agent_config"].to<JsonObject>();
  if (strlen(DEFAULT_MODEL) > 0) ac["model"] = DEFAULT_MODEL;

  String bodyStr;
  serializeJson(body, bodyStr);

  int code = http.POST(bodyStr);
  if (code > 0) {
    String resp = http.getString();
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, resp);
    if (!err && doc["code"] == 0) {
      currentSessionId = doc["data"]["id"] | "";
      setupWSSession();
    }
  }
  http.end();
}

// ============ Prompt Submission ============

void submitPromptText(const String& text) {
  if (currentSessionId.length() == 0 || text.length() == 0) return;

  display.appendLine("You: " + text, 0);
  assistantBuffer = "";

  PromptResult r = client.submitPrompt(currentSessionId, text);
  if (r.code == 0) {
    activePromptId = r.promptId;
    display.drawStatusBar("Kimi", "running...");
  } else {
    display.appendLine("Error: " + r.errorMsg, 4);
  }
}

// ============ Event Handler ============

void handleEvent(const KimiEvent& ev) {
  // Serial: log for debugging
  Serial.printf("EVENT: type=%s seq=%llu volatile=%d\n",
    ev.type.c_str(), ev.seq, ev.isVolatile);

  if (ev.type == "turn.started") {
    assistantBuffer = "";
    display.drawStatusBar("Kimi", "Thinking...");

  } else if (ev.type == "thinking.delta") {
    const char* delta = ev.payload["delta"];
    if (delta && strlen(delta) > 0) {
      display.appendThinking(String(delta));
    }

  } else if (ev.type == "assistant.delta") {
    const char* delta = ev.payload["delta"];
    if (delta) {
      assistantBuffer += String(delta);
      // Avoid too many e-ink refreshes per frame
      static unsigned long lastDeltaRefresh = 0;
      if (millis() - lastDeltaRefresh > 500) {
        lastDeltaRefresh = millis();
        display.clearChat();
        display.appendLine("Kimi:", 15);
        display.appendText(assistantBuffer);
      }
    }

  } else if (ev.type == "tool.call.started") {
    const char* name = ev.payload["name"] | "?";
    String args;
    JsonObject a = ev.payload["args"];
    if (!a.isNull()) {
      serializeJson(a, args);
    }
    display.appendToolCall(String(name), args);

  } else if (ev.type == "tool.result") {
    const char* out = ev.payload["output"] | "";
    display.appendToolResult(String(out));

  } else if (ev.type == "turn.step.completed") {
    JsonObject usage = ev.payload["usage"];
    if (!usage.isNull()) {
      char buf[64];
      snprintf(buf, sizeof(buf), " tokens: in=%d out=%d",
        usage["inputOther"] | 0, usage["output"] | 0);
      display.appendLine(String(buf), 6);
    }

  } else if (ev.type == "turn.ended") {
    display.drawStatusBar("Kimi", "Done");
    activePromptId = "";

    // show final assembled text
    display.clearChat();
    display.appendLine("Kimi:", 15);
    display.appendText(assistantBuffer);

  } else if (ev.type == "prompt.submitted") {
    const char* status = ev.payload["status"] | "";
    display.drawStatusBar("Kimi", String(status).c_str());

  } else if (ev.type == "error") {
    display.appendLine("Error: " + String(ev.payload["msg"] | ""), 4);

  } else if (ev.type == "resync_required") {
    display.appendLine("Resync requested", 6);
    // re-subscribe with new seq
    uint64_t seq = ev.payload["current_seq"] | 0;
    const char* epoch = ev.payload["epoch"] | "";
    client.subscribe(currentSessionId, seq, String(epoch));
  }
}

// ============ Log Callback ============

void onLog(const String& msg) {
  Serial.println("[Kimi] " + msg);
}

// ============ Button Handlers ============

void handleBtnA() {
  switch (appMode) {
    case MODE_CHAT:
      appMode = MODE_PRESET_SELECT;
      display.showPresetSelector(true);
      break;
    case MODE_PRESET_SELECT:
      display.cyclePreset(-1);
      break;
  }
}

void handleBtnB() {
  switch (appMode) {
    case MODE_CHAT:
      // submit last used preset (default: first)
      submitPromptText(display.getSelectedPresetText());
      break;
    case MODE_PRESET_SELECT:
      String text = display.getSelectedPresetText();
      appMode = MODE_CHAT;
      display.showPresetSelector(false);
      submitPromptText(text);
      break;
  }
}

void handleBtnC() {
  switch (appMode) {
    case MODE_CHAT:
      if (activePromptId.length() > 0 && currentSessionId.length() > 0) {
        client.abortPrompt(currentSessionId, activePromptId);
        display.appendLine("(aborted)", 8);
        activePromptId = "";
        display.drawStatusBar("Kimi", "Aborted");
      }
      break;
    case MODE_PRESET_SELECT:
      display.cyclePreset(1);
      break;
  }
}

void handleBtnPower() {
  M5.Lcd.fillScreen(TFT_WHITE);
  M5.Lcd.sleep();
  M5.Power.deepSleep();
}
