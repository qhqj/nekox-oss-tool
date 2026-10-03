# Offline Windows desktop acceptance

This opt-in suite runs the actual Vue app in a separate Tauri/WebView2 test executable. It uses the installed Browser SDK, production upload transport and production native vault/download implementations. It does not launch or install the user application.

From this repository on D:, with the existing Node/MSVC/Rust/WebView2 toolchain:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-desktop.ps1
```

The execution-policy argument applies to this process only. No dependency or system component is installed. Cargo uses `--locked --offline`; Vite disables `.env` loading. The `desktop-integration` feature gates the executable, so ordinary Cargo tests and product builds do not launch it. `-SkipBuild` is diagnostic reuse of the last test binary, not current-source acceptance.

Each invocation creates a fresh `test-results/desktop-<guid>` directory on D:. The native test checks that root and redirects its vault, WebView profile, downloads and temporary files there, without loading the user's account storage. Test-only path overrides are not compiled into the product. Results contain case identifiers and booleans, not URLs, headers or credentials. The script controls native save dialogs belonging to its own test process; it neither sends global keystrokes nor captures the screen. A four-minute runtime deadline stops only that test process.

Remote fetch is replaced with synthetic OSS XML, multipart responses and download streams; XHR fails closed. Only POST to the exact local Tauri IPC origin retains its native transport. The test CSP also blocks external network connections. Synthetic credentials are explicitly test fixtures.

The suite verifies:

- A real Tauri WebView, account locking during upload, HTTP abort, saved-part recovery and ignored late callbacks.
- Account/upload dialog focus, isolated background navigation, bidirectional Tab cycling, Escape close/pause, preserved queues while Escape repeats, and focus restoration. Keyboard events are synthetic; the actual WebView owns focus and DOM behavior.
- Session credential availability, empty credential fields in the independently encrypted vault, no credentials in test browser storage, and absence after an actual page reload.
- Native save cancellation and existing targets causing zero signature/GET; successful streaming; failure and cancellation after bytes were written; a destination created before final commit surviving unchanged.
- Binary IPC chunks at most 128 KiB, exact saved bytes, removal of owned temporary files, and preservation of both existing-target fixtures.

There are 29 report rows (28 distinct case names: the Tauri check repeats after reload). Passing requires a zero process exit code, `done` stage, and no failing rows. Inspect `results.jsonl`, `stage.json`, `build.log` and `stderr.log` in the reported run directory. Passing does not establish visual accessibility, physical keyboard/screen-reader behavior, live OSS/CORS compatibility, physical network failure handling, multi-GiB memory usage, installation/upgrade behavior, or other Windows versions/filesystems.

The test executable embeds its own Common Controls v6 manifest. Cargo integration-test binaries do not inherit the resource Tauri adds to the normal product executable; without it, this Windows test target failed before entry with `0xC0000139`. The fix affects test linking only and requests `asInvoker`, without changing Windows components or security settings.
