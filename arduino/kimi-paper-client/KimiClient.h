#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <HTTPClient.h>
#include <functional>

struct KimiEvent {
  String type;
  String sessionId;
  uint64_t seq = 0;
  bool isVolatile = false;
  JsonDocument payload;
};

struct PromptResult {
  String promptId;
  String userMessageId;
  String status;
  int code = 0;
  String errorMsg;
};

class KimiClient {
public:
  using EventCallback = std::function<void(const KimiEvent&)>;
  using LogCallback = std::function<void(const String&)>;

  KimiClient();
  ~KimiClient();

  void setLogCallback(LogCallback cb) { _logCb = cb; }
  void setEventCallback(EventCallback cb) { _eventCb = cb; }
  void setServerConfig(const String& host, uint16_t port);
  void setWiFiConfig(const String& ssid, const String& pass);

  bool connectWiFi(unsigned long timeoutMs = 15000);
  bool connectWS(unsigned long timeoutMs = 10000);
  void disconnect();
  bool isConnected() const;
  bool isWifiConnected() const;

  void subscribe(const String& sessionId, uint64_t seq = 0, const String& epoch = "");
  void unsubscribe(const String& sessionId);
  void sendPong(const String& nonce);
  void abortPrompt(const String& sessionId, const String& promptId);

  PromptResult submitPrompt(const String& sessionId, const String& text, const String& model = "");
  PromptResult submitPromptJson(const String& sessionId, const JsonDocument& content, const String& model = "");

  void loop();

private:
  String _host;
  uint16_t _port = 58627;
  String _ssid;
  String _pass;
  String _wsConnId;
  int _protocolVersion = 0;

  WebSocketsClient _ws;
  WiFiClient _wifiClient;
  HTTPClient _http;

  LogCallback _logCb;
  EventCallback _eventCb;

  String _pendingJson;

  static void onWsEvent(WStype_t type, uint8_t* payload, size_t length);
  void handleWsEvent(WStype_t type, uint8_t* payload, size_t length);
  void handleFrame(const String& json);
  void handleServerHello(JsonDocument& doc);
  void handleAck(JsonDocument& doc);
  void handlePing(JsonDocument& doc);
  void handleResyncRequired(JsonDocument& doc);
  void handleError(JsonDocument& doc);
  void handleSessionEvent(JsonDocument& doc);
  void log(const String& msg);
};
