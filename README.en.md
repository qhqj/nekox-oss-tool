<p align="center"><img src="public/app-icon.svg" width="96" alt="Nekox OSS Tool" /></p>
<h1 align="center">Nekox OSS Tool</h1>
<p align="center">A small, focused personal desktop companion for Alibaba Cloud OSS.</p>
<p align="center"><a href="README.md">中文</a> · English · <a href="https://github.com/qhqj/nekox-oss-tool/releases/latest">Download</a></p>

## Install

Download `Nekox-OSS-Tool-VERSION-windows-x64-setup.exe` from [Releases](https://github.com/qhqj/nekox-oss-tool/releases). The per-user installer supports Simplified Chinese and English and lets you choose an installation directory.

- Targets Windows 10 / 11 x64. Microsoft Edge WebView2 is required; the installer downloads it if missing.
- Builds are currently unsigned. Windows may show an unknown-publisher warning.
- The application UI is Chinese. The English documentation and installer do not imply an English application UI.

## Features

- Configure Region, Bucket, AccessKey, optional STS Token, Endpoint and public base URL. Paste an OSS hostname to detect the Bucket and Region.
- Browse object prefixes using `delimiter=/`, up to 300 entries per page, displaying names and sizes only.
- Upload to the current prefix with an editable filename; existing names are avoided using `name (n).ext`, with the final Key displayed.
- Multipart uploads for files of 8 MiB or larger, with progress and result details.
- Copy public URLs, preview images on click, and download on demand with a desktop save dialog.
- Remember personal connection settings and attempt to reconnect on startup.
- Warm styling, a consistent application icon and native window controls. No business backend, automatic thumbnails or delete operations.

## Connect

1. Enter your Region, Bucket and AccessKey ID / Secret. Include the STS Token when using temporary credentials.
2. Connect, browse a prefix, then upload, copy a link or download.
3. Public links require anonymously readable objects or a publicly accessible CDN base URL. Private downloads use short-lived signed URLs.

This is a **single-user desktop application**. Connection settings, including the AccessKey Secret and STS Token, are stored **unencrypted** in local WebView storage. Use a trusted personal computer and do not share its application data directory. Source code and installers do not contain your credentials. Expired STS credentials must be entered again.

OSS requests originate directly from the WebView, so Bucket CORS settings may still be required. Allow the actual Origin reported in connection errors, the required GET / PUT / POST / HEAD methods and request headers, and expose response headers such as `ETag` and `x-oss-request-id`. Give a dedicated RAM identity only the necessary Bucket listing, read, write and multipart permissions for your upload workflow.

Name checks and uploads are not atomic; concurrent clients can still race on the same Key. Downloads buffer the entire file in memory, so very large downloads are limited by available memory.

## Develop and build

Requirements: Node.js 22+, stable Rust MSVC, Visual Studio C++ Build Tools and WebView2. Built with Vue 3, Vite, TypeScript, the ali-oss Browser SDK and Tauri 2.

```bash
npm ci
npm run dev:desktop
```

```bash
npm run typecheck
npm run build
npm run build:desktop
```

NSIS output: `src-tauri/target/release/bundle/nsis/`. The local delivery also includes `install/setup.exe`; `install/` is ignored by Git and installers are distributed through Releases. Use `npm run dev` only for frontend development previews.

Regenerate application icons from the editable vector source:

```bash
npx tauri icon public/app-icon.svg
```

## Releases

`.github/workflows/release.yml` runs Windows type checks, frontend and NSIS builds on `v*` tags, then publishes the installer and SHA-256 checksums to GitHub Releases. Keep the application version consistent in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json` before tagging.

```bash
git push origin main
git tag v0.1.0
git push origin v0.1.0
```

Use a new version and tag for subsequent releases. This workflow does not add automatic in-app updates.
