#pragma once

#include <Arduino.h>
#include <M5Unified.h>
#include <vector>

#define STATUS_BAR_HEIGHT 28
#define LINE_HEIGHT 22
#define FOOTER_HEIGHT 28

struct DisplayLine {
  String text;
  uint32_t color = TFT_BLACK;
};

class KimiDisplay {
public:
  KimiDisplay();
  void begin();

  // status
  void drawStatusBar(const String& left, const String& right);
  void drawFooter(const String& text);

  // chat
  void appendText(const String& text);
  void appendLine(const String& line, uint32_t color = TFT_BLACK);
  void appendThinking(const String& text);
  void appendToolCall(const String& name, const String& args);
  void appendToolResult(const String& output);
  void clearChat();

  // scroll
  void scrollUp();
  void scrollDown();
  int getLineCount() const { return _lines.size(); }
  int getScrollOffset() const { return _scrollOffset; }

  // preset selector
  void showPresetSelector(bool show);
  bool isPresetSelectorVisible() const { return _showPresetSelector; }
  void cyclePreset(int dir);
  int getSelectedPreset() const { return _selectedPreset; }
  String getSelectedPresetText() const;

  // refresh
  void refresh();
  void showSplash(const String& message);

  static const int PRESET_COUNT = 6;
  static const char* PRESETS[PRESET_COUNT];

private:
  std::vector<DisplayLine> _lines;
  int _scrollOffset = 0;
  int _partialRefreshCount = 0;

  bool _showPresetSelector = false;
  int _selectedPreset = 0;

  int contentTop() const;
  int contentHeight() const;
  int maxVisibleLines() const;

  void redraw();
  void redrawChat();
  void drawLine(int y, const DisplayLine& line);
  void drawPresetSelector();
  void beginDraw(bool full);
};
