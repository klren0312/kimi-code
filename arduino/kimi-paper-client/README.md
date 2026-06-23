# Kimi Paper Client — M5PaperS3

An Arduino client for Kimi Code Server running on M5PaperS3 (ESP32-S3 + 4.7" e-ink display).

## Features

- WebSocket event streaming (thinking delta, assistant delta, tool calls, etc.)
- REST prompt submission
- 6 preset prompts (selectable via buttons)
- Custom text input
- Auto-scroll chat display on e-ink

## Hardware

- M5PaperS3 (ESP32-S3, 16MB flash, 8MB PSRAM)
- 4.7" e-ink display (540x960)
- Onboard buttons: A (left), B (middle), C (right), Pwr (side)

## Dependencies

- [M5EPD](https://github.com/m5stack/M5EPD) — display and board support
- [WebSockets](https://github.com/Links2004/arduinoWebSockets) — WS client
- [ArduinoJson](https://arduinojson.org/) — JSON parsing

## Configuration

Edit `kimi-paper-client.ino` and set:

```cpp
const char* WIFI_SSID    = "your-ssid";
const char* WIFI_PASS    = "your-password";
const char* SERVER_HOST  = "192.168.1.100";  // Kimi Server IP
const uint16_t SERVER_PORT = 58627;
```

Kimi Server must bind to `0.0.0.0` (not `127.0.0.1`) for LAN access.
Start it with: `kimi-code server --host 0.0.0.0`

## Button Map

| Button | Chat Mode | Preset Select |
|--------|-----------|---------------|
| A | Open preset selector | Previous preset |
| B | Send current preset prompt | Confirm & send |
| C | Abort running prompt | Next preset |
| Pwr | Deep sleep | — |

## Build & Upload

Using PlatformIO:

```bash
cd arduino/kimi-paper-client
pio run --target upload
pio device monitor
```

Or open the folder in VS Code with PlatformIO extension.
