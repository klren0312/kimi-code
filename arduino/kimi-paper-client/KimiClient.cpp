#include "KimiClient.h"

static KimiClient* instance = nullptr;

KimiClient::KimiClient() {
  instance = this;
}

KimiClient::~KimiClient() {
  disconnect();
  if (instance == this) instance = nullptr;
}

void KimiClient::setServerConfig(const String& host, uint16_t port) {
  _host = host;
  _port = port;
}

void KimiClient::setWiFiConfig(const String& ssid, const String& pass) {
  _ssid = ssid;
  _pass = pass;
}

void KimiClient::log(const String& msg) {
  if (_logCb) _logCb(msg);
}

bool KimiClient::connectWiFi(unsigned long timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(_ssid, _pass);
  log("Connecting to WiFi: " + _ssid);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    if (millis() - start > timeoutMs) {
      log("WiFi timeout");
      return false;
    }
  }
  log("WiFi connected, IP: " + WiFi.localIP().toString());
  return true;
}

bool KimiClient::connectWS(unsigned long timeoutMs) {
  if (_ws.isConnected()) return true;

  _ws.begin(_host, _port, "/api/v1/ws");
  _ws.onEvent([](WStype_t type, uint8_t* payload, size_t length) {
    if (instance) instance->handleWsEvent(type, payload, length);
  });
  _ws.setReconnectInterval(5000);

  log("Connecting WS to " + _host + ":" + String(_port) + "/api/v1/ws");
  unsigned long start = millis();
  while (!_ws.isConnected()) {
    _ws.loop();
    delay(10);
    if (millis() - start > timeoutMs) {
      log("WS timeout");
      return false;
    }
  }
  log("WS connected");
  return true;
}

void KimiClient::disconnect() {
  _ws.disconnect();
  _http.end();
  WiFi.disconnect();
}

bool KimiClient::isConnected() const {
  return _ws.isConnected();
}

bool KimiClient::isWifiConnected() const {
  return WiFi.status() == WL_CONNECTED;
}

void KimiClient::loop() {
  _ws.loop();
}

// ---- WebSocket Callback (static -> instance) ----
void KimiClient::onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  if (instance) instance->handleWsEvent(type, payload, length);
}

void KimiClient::handleWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_TEXT: {
      String text((char*)payload, length);
      _pendingJson += text;
      handleFrame(_pendingJson);
      _pendingJson = "";
      break;
    }
    case WStype_DISCONNECTED:
      log("WS disconnected");
      break;
    case WStype_CONNECTED:
      log("WS connected");
      break;
    case WStype_ERROR:
      log("WS error");
      break;
    case WStype_FRAGMENT_TEXT_START:
      _pendingJson = String((char*)payload, length);
      break;
    case WStype_FRAGMENT:
      _pendingJson += String((char*)payload, length);
      break;
    case WStype_FRAGMENT_FIN:
      _pendingJson += String((char*)payload, length);
      handleFrame(_pendingJson);
      _pendingJson = "";
      break;
    default:
      break;
  }
}

// ---- Frame Dispatch ----
void KimiClient::handleFrame(const String& json) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    log("JSON parse error: " + String(err.c_str()));
    return;
  }

  const char* type = doc["type"];
  if (!type) return;

  if (strcmp(type, "server_hello") == 0) {
    handleServerHello(doc);
  } else if (strcmp(type, "ack") == 0) {
    handleAck(doc);
  } else if (strcmp(type, "ping") == 0) {
    handlePing(doc);
  } else if (strcmp(type, "resync_required") == 0) {
    handleResyncRequired(doc);
  } else if (strcmp(type, "error") == 0) {
    handleError(doc);
  } else {
    handleSessionEvent(doc);
  }
}

void KimiClient::handleServerHello(JsonDocument& doc) {
  JsonObject payload = doc["payload"];
  _wsConnId = payload["ws_connection_id"] | "";
  _protocolVersion = payload["protocol_version"] | 0;
  log("Server hello: conn=" + _wsConnId + " proto=" + String(_protocolVersion));
}

void KimiClient::handleAck(JsonDocument& doc) {
  int code = doc["code"] | -1;
  const char* msg = doc["msg"] | "";
  log("ACK: code=" + String(code) + " msg=" + String(msg));
}

void KimiClient::handlePing(JsonDocument& doc) {
  const char* nonce = doc["payload"]["nonce"];
  if (nonce) sendPong(String(nonce));
}

void KimiClient::handleResyncRequired(JsonDocument& doc) {
  log("Resync required: " + String(doc["payload"]["reason"] | ""));
  KimiEvent ev;
  ev.type = "resync_required";
  ev.payload = doc["payload"].as<JsonObject>();
  if (_eventCb) _eventCb(ev);
}

void KimiClient::handleError(JsonDocument& doc) {
  log("Server error: " + String(doc["payload"]["msg"] | ""));
  KimiEvent ev;
  ev.type = "error";
  ev.payload = doc["payload"].as<JsonObject>();
  if (_eventCb) _eventCb(ev);
}

void KimiClient::handleSessionEvent(JsonDocument& doc) {
  KimiEvent ev;
  ev.type = doc["type"] | "";
  ev.sessionId = doc["session_id"] | "";
  ev.seq = doc["seq"] | 0;
  ev.isVolatile = doc["volatile"] | false;
  ev.payload = doc["payload"].as<JsonObject>();
  if (_eventCb) _eventCb(ev);
}

// ---- WS Control Frames ----
void KimiClient::subscribe(const String& sessionId, uint64_t seq, const String& epoch) {
  JsonDocument doc;
  doc["type"] = "client_hello";
  doc["id"] = "ch_" + String(millis());
  doc["payload"]["client_id"] = "m5paper-" + WiFi.macAddress();
  doc["payload"]["subscriptions"][0] = sessionId;
  if (seq > 0 || epoch.length() > 0) {
    JsonObject cursor = doc["payload"]["cursors"][sessionId].to<JsonObject>();
    if (seq > 0) cursor["seq"] = seq;
    if (epoch.length() > 0) cursor["epoch"] = epoch;
  }
  String json;
  serializeJson(doc, json);
  _ws.sendTXT(json);
  log("Sent client_hello for session: " + sessionId);
}

void KimiClient::unsubscribe(const String& sessionId) {
  JsonDocument doc;
  doc["type"] = "unsubscribe";
  doc["id"] = "us_" + String(millis());
  doc["payload"]["session_ids"][0] = sessionId;
  String json;
  serializeJson(doc, json);
  _ws.sendTXT(json);
}

void KimiClient::sendPong(const String& nonce) {
  JsonDocument doc;
  doc["type"] = "pong";
  doc["payload"]["nonce"] = nonce;
  String json;
  serializeJson(doc, json);
  _ws.sendTXT(json);
}

void KimiClient::abortPrompt(const String& sessionId, const String& promptId) {
  JsonDocument doc;
  doc["type"] = "abort";
  doc["id"] = "ab_" + String(millis());
  doc["payload"]["session_id"] = sessionId;
  doc["payload"]["prompt_id"] = promptId;
  String json;
  serializeJson(doc, json);
  _ws.sendTXT(json);
  log("Sent abort: " + promptId);
}

// ---- REST API ----
PromptResult KimiClient::submitPromptJson(const String& sessionId, const JsonDocument& content, const String& model) {
  PromptResult result;
  String url = "http://" + _host + ":" + String(_port) + "/api/v1/sessions/" + sessionId + "/prompts";

  _http.begin(_wifiClient, url);
  _http.addHeader("Content-Type", "application/json");

  JsonDocument body;
  body["content"] = content;
  if (model.length() > 0) body["model"] = model;

  String bodyStr;
  serializeJson(body, bodyStr);

  int httpCode = _http.POST(bodyStr);
  if (httpCode > 0) {
    String response = _http.getString();
    JsonDocument respDoc;
    DeserializationError err = deserializeJson(respDoc, response);
    if (err) {
      result.code = -1;
      result.errorMsg = "JSON parse: " + String(err.c_str());
    } else {
      result.code = respDoc["code"] | -1;
      if (result.code == 0) {
        JsonObject data = respDoc["data"];
        result.promptId = data["prompt_id"] | "";
        result.userMessageId = data["user_message_id"] | "";
        result.status = data["status"] | "";
      } else {
        result.errorMsg = respDoc["msg"] | "unknown error";
      }
    }
  } else {
    result.code = httpCode;
    result.errorMsg = "HTTP error: " + String(_http.errorToString(httpCode));
  }
  _http.end();
  return result;
}

PromptResult KimiClient::submitPrompt(const String& sessionId, const String& text, const String& model) {
  JsonDocument content;
  JsonObject textBlock = content.add<JsonObject>();
  textBlock["type"] = "text";
  textBlock["text"] = text;
  return submitPromptJson(sessionId, content, model);
}
