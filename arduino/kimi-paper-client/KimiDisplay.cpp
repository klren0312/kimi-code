#include "KimiDisplay.h"

const char* KimiDisplay::PRESETS[KimiDisplay::PRESET_COUNT] = {
  "What files are in the project?",
  "Explain the current code",
  "Fix bugs in the last commit",
  "Write unit tests",
  "Summarize the conversation",
  "Help me debug an issue",
};

KimiDisplay::KimiDisplay() {}

void KimiDisplay::begin() {
  auto cfg = M5.config();
  M5.begin(cfg);
  M5.Lcd.setRotation(1);
  M5.Lcd.fillScreen(TFT_WHITE);
  showSplash("Kimi Paper");
}

void KimiDisplay::beginDraw(bool full) {
  if (full) {
    _partialRefreshCount = 0;
    M5.Lcd.setEpdMode(lgfx::epd_mode::epd_quality);
    M5.Lcd.fillScreen(TFT_WHITE);
  } else {
    _partialRefreshCount++;
    M5.Lcd.setEpdMode(lgfx::epd_mode::epd_fast);
  }
}

void KimiDisplay::refresh() {
  M5.Lcd.setEpdMode(lgfx::epd_mode::epd_quality);
}

void KimiDisplay::showSplash(const String& message) {
  M5.Lcd.fillScreen(TFT_WHITE);
  M5.Lcd.setTextSize(3);
  M5.Lcd.setTextColor(TFT_BLACK);
  M5.Lcd.setTextDatum(MC_DATUM);
  M5.Lcd.drawString(message, M5.Lcd.width() / 2, M5.Lcd.height() / 2 - 30);
  M5.Lcd.setTextSize(2);
  M5.Lcd.drawString("Connecting...", M5.Lcd.width() / 2, M5.Lcd.height() / 2 + 10);
}

// ---- layout helpers ----

int KimiDisplay::contentTop() const {
  return STATUS_BAR_HEIGHT + 4;
}

int KimiDisplay::contentHeight() const {
  return M5.Lcd.height() - STATUS_BAR_HEIGHT - FOOTER_HEIGHT - 8;
}

int KimiDisplay::maxVisibleLines() const {
  return contentHeight() / LINE_HEIGHT;
}

// ---- status / footer ----

void KimiDisplay::drawStatusBar(const String& left, const String& right) {
  M5.Lcd.fillRect(0, 0, M5.Lcd.width(), STATUS_BAR_HEIGHT, TFT_BLACK);
  M5.Lcd.setTextSize(2);
  M5.Lcd.setTextColor(TFT_WHITE);
  M5.Lcd.setTextDatum(ML_DATUM);
  M5.Lcd.drawString(" " + left, 4, STATUS_BAR_HEIGHT / 2);
  M5.Lcd.setTextDatum(MR_DATUM);
  int rw = M5.Lcd.textWidth(right);
  M5.Lcd.drawString(right + " ", M5.Lcd.width() - 4, STATUS_BAR_HEIGHT / 2);
}

void KimiDisplay::drawFooter(const String& text) {
  int fy = M5.Lcd.height() - FOOTER_HEIGHT;
  M5.Lcd.fillRect(0, fy, M5.Lcd.width(), FOOTER_HEIGHT, TFT_LIGHTGREY);
  M5.Lcd.setTextSize(2);
  M5.Lcd.setTextColor(TFT_BLACK);
  M5.Lcd.setTextDatum(MC_DATUM);
  M5.Lcd.drawString(text, M5.Lcd.width() / 2, fy + FOOTER_HEIGHT / 2);
}

// ---- chat lines ----

void KimiDisplay::appendText(const String& text) {
  if (text.length() == 0) return;
  String remaining = text;
  int maxChars = M5.Lcd.width() / 14;
  while (remaining.length() > 0) {
    String line = remaining.substring(0, maxChars);
    int nl = line.indexOf('\n');
    if (nl >= 0) {
      line = line.substring(0, nl);
      remaining = remaining.substring(nl + 1);
    } else {
      remaining = remaining.substring(maxChars);
    }
    if (line.length() > 0) appendLine(line);
  }
}

void KimiDisplay::appendLine(const String& line, uint32_t color) {
  _lines.push_back({line, color});
  int maxOff = max(0, (int)_lines.size() - maxVisibleLines());
  _scrollOffset = maxOff;
  redrawChat();
}

void KimiDisplay::appendThinking(const String& text) {
  appendLine("> " + text, TFT_DARKGREY);
}

void KimiDisplay::appendToolCall(const String& name, const String& args) {
  appendLine("  [" + name + "]", TFT_DARKGREY);
}

void KimiDisplay::appendToolResult(const String& output) {
  if (output.length() == 0) return;
  String s = output.substring(0, 80);
  if (output.length() > 80) s += "...";
  appendLine("  -> " + s, TFT_DARKGREY);
}

void KimiDisplay::clearChat() {
  _lines.clear();
  _scrollOffset = 0;
  redraw();
}

void KimiDisplay::scrollUp() {
  if (_scrollOffset > 0) {
    _scrollOffset--;
    redrawChat();
  }
}

void KimiDisplay::scrollDown() {
  int maxOff = max(0, (int)_lines.size() - maxVisibleLines());
  if (_scrollOffset < maxOff) {
    _scrollOffset++;
    redrawChat();
  }
}

// ---- preset selector ----

void KimiDisplay::showPresetSelector(bool show) {
  _showPresetSelector = show;
  show ? drawPresetSelector() : redraw();
}

void KimiDisplay::cyclePreset(int dir) {
  _selectedPreset = (_selectedPreset + dir + PRESET_COUNT) % PRESET_COUNT;
  drawPresetSelector();
}

String KimiDisplay::getSelectedPresetText() const {
  return String(PRESETS[_selectedPreset]);
}

// ---- rendering ----

void KimiDisplay::redraw() {
  beginDraw(_partialRefreshCount >= 10);
  drawStatusBar("Kimi", "");
  if (_showPresetSelector) {
    drawPresetSelector();
  } else {
    int y = contentTop();
    int startIdx = _scrollOffset;
    for (int i = startIdx; i < (int)_lines.size() && y < contentTop() + contentHeight(); i++) {
      drawLine(y, _lines[i]);
      y += LINE_HEIGHT;
    }
    char buf[16];
    snprintf(buf, sizeof(buf), "lines: %d/%d", _scrollOffset + 1, (int)_lines.size());
    drawFooter(_lines.size() > 0 ? String(buf) : "BtnA:presets  BtnB:send  BtnC:abort");
  }
  M5.Lcd.setEpdMode(lgfx::epd_mode::epd_quality);
}

void KimiDisplay::redrawChat() {
  int ct = contentTop();
  int ch = contentHeight();
  beginDraw(false);
  M5.Lcd.fillRect(0, ct, M5.Lcd.width(), ch, TFT_WHITE);
  int y = ct;
  int startIdx = _scrollOffset;
  for (int i = startIdx; i < (int)_lines.size() && y < ct + ch; i++) {
    drawLine(y, _lines[i]);
    y += LINE_HEIGHT;
  }
  M5.Lcd.setEpdMode(lgfx::epd_mode::epd_quality);
}

void KimiDisplay::drawLine(int y, const DisplayLine& line) {
  M5.Lcd.setTextSize(2);
  M5.Lcd.setTextColor(line.color, TFT_WHITE);
  M5.Lcd.setTextDatum(TL_DATUM);
  M5.Lcd.drawString(line.text, 4, y);
}

void KimiDisplay::drawPresetSelector() {
  int ct = contentTop();
  int ch = contentHeight();
  M5.Lcd.fillRect(0, ct, M5.Lcd.width(), ch, TFT_WHITE);
  M5.Lcd.setTextSize(2);
  M5.Lcd.setTextColor(TFT_BLACK);
  M5.Lcd.setTextDatum(MC_DATUM);
  M5.Lcd.drawString("Select a preset:", M5.Lcd.width() / 2, ct + 16);
  for (int i = 0; i < PRESET_COUNT; i++) {
    int y = ct + 50 + i * 30;
    M5.Lcd.setTextDatum(TL_DATUM);
    String prefix = (i == _selectedPreset) ? " > " : "   ";
    M5.Lcd.drawString(prefix + String(PRESETS[i]), 20, y);
  }
  drawFooter("A:prev  B:confirm  C:next");
}
