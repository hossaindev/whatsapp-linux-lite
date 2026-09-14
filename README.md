# WhatsApp Lite for Linux

An ultra-lightweight WhatsApp Desktop client for Linux built for minimal memory consumption while preserving 100% full WhatsApp voice and video call support.

## Key Optimizations

- **Single-Renderer Architecture**: Eliminates redundant `<webview>` wrapper processes, instantly cutting ~40 MB of baseline RAM overhead.
- **Aggressive Low-Memory Engine Tuning**:
  - `--enable-low-end-device-mode`: Caps in-memory image decodes and limits graphics memory allocations.
  - `--max-old-space-size=128`: Enforces strict 128 MB V8 heap boundaries.
  - `--disable-features=AudioServiceOutOfProcess`: Merges audio process into main browser process to eliminate helper processes.
- **Deep Pseudo-Sleep RAM Purge**:
  - Automatically clears in-memory decoded image caches (`session.clearCache()`) and bytecode caches (`session.clearCodeCaches()`) when minimized or closed to tray.
  - Dispatches full V8 and Blink garbage collection passes.
  - Keeps WebSocket, DOM observers, and incoming call handlers alive so you never miss calls or notifications.
- **Full Call & Notification Support**: Native desktop notifications, audio/video call ringing dialogs, and call controls.
- **System Tray & Autostart**: System tray icon with unread badges, StatusNotifierWatcher panel recovery, and optional startup at login.

## Installation

Download the latest `.deb` package from the [Releases](https://github.com/hossaindev/whatsapp-linux-lite/releases) page:

```bash
sudo dpkg -i WhatsApp_Lite_*_amd64.deb
```
