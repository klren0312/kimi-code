/*
 * Configuration file for Kimi Code Monitor
 * Edit this file to configure your device
 */

#ifndef CONFIG_H
#define CONFIG_H

// ============================================================================
// WiFi Configuration
// ============================================================================

// Your WiFi network credentials
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// WiFi connection timeout (ms)
#define WIFI_TIMEOUT_MS 30000

// WiFi reconnect interval (ms)
#define WIFI_RECONNECT_MS 10000

// ============================================================================
// Server Configuration
// ============================================================================

// Kimi Code Log Server IP address
// This should be your computer's local IP address
#define SERVER_HOST "192.168.1.100"

// Server port (default: 9877)
#define SERVER_PORT 9877

// SSE reconnect interval (ms)
#define SSE_RECONNECT_MS 5000

// HTTP request timeout (ms)
#define HTTP_TIMEOUT_MS 5000

// ============================================================================
// Display Configuration
// ============================================================================

// Display rotation (0-3)
// 0: Portrait
// 1: Landscape
// 2: Portrait (flipped)
// 3: Landscape (flipped)
#define DISPLAY_ROTATION 1

// Maximum log lines to keep in buffer
#define MAX_LOG_LINES 20

// Display refresh interval (ms)
#define DISPLAY_REFRESH_MS 100

// Log line height (pixels)
#define LOG_LINE_HEIGHT 16

// Status bar height (pixels)
#define STATUS_BAR_HEIGHT 24

// Footer height (pixels)
#define FOOTER_HEIGHT 20

// ============================================================================
// Approval Configuration
// ============================================================================

// Auto-approve all requests (for testing only!)
// WARNING: Do not enable in production!
#define AUTO_APPROVE false

// Auto-approve for session (requires AUTO_APPROVE=true)
#define AUTO_APPROVE_SESSION false

// Approval timeout (ms) - 0 to disable
#define APPROVAL_TIMEOUT_MS 0

// ============================================================================
// Debug Configuration
// ============================================================================

// Enable serial debug output
#define DEBUG_ENABLED true

// Serial baud rate
#define DEBUG_BAUD_RATE 115200

// ============================================================================
// Advanced Configuration
// ============================================================================

// SSE buffer size
#define SSE_BUFFER_SIZE 8192

// JSON document size for parsing
#define JSON_DOC_SIZE 8192

// Touch debounce time (ms)
#define TOUCH_DEBOUNCE_MS 200

// Button debounce time (ms)
#define BUTTON_DEBOUNCE_MS 200

#endif // CONFIG_H
