# Release Notes - v1.0.0

### Ultra-Lightweight Architecture
- Re-engineered into a single-renderer architecture, eliminating the secondary `<webview>` process and saving ~40 MB of memory.
- Added `--enable-low-end-device-mode` to instruct Chromium to enforce mobile-tier cache conservation.
- Capped JavaScript old space heap at 128 MB (`--max-old-space-size=128`).
- Merged audio subprocesses with `--disable-features=AudioServiceOutOfProcess`.
- Deep Pseudo-Sleep RAM purge: flushes in-memory image decodes, HTTP caches, and bytecode caches on minimize while retaining login session and active call listeners.
