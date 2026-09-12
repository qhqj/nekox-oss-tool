## 中文

Nekox OSS Tool 0.2.0：多账号与批量上传体验更新。

- 下载下方 `windows-x64-setup.exe` 安装，向导支持简体中文 / English。
- 账号列表支持名称、备注、独立 AccessKey / STS 配置与切换。
- 支持多文件上传、文件夹递归与目录结构保留。
- 同名文件弹窗选择覆盖、不上传或自动改名，可应用到后续冲突。
- 队列显示进度与最终 Key / URL，支持失败重试与当前文件结束后暂停。
- Windows 账号库使用当前用户 DPAPI 加密，旧单账号配置迁移成功后清理。
- 上传弹窗打开期间锁定账号与目录，避免传错位置。
- 附 `SHA256SUMS.txt` 校验文件。
- 未签名安装包；缺失 WebView2 时安装程序需要联网下载运行环境。

## English

A personal Windows x64 OSS desktop tool with a unified icon and warm interface.

- Download the `windows-x64-setup.exe` asset. The installer supports Simplified Chinese and English; the application UI is Chinese.
- Browse prefixes, upload, copy public links, and explicitly preview images or download files.
- Named accounts support notes, switching and per-user DPAPI encrypted credential storage on Windows. Legacy settings are migrated before plaintext cleanup.
- Upload multiple files or folders recursively with preserved paths. Choose overwrite, skip or rename for conflicts, apply to later conflicts, retry failures or pause after the current file.
- Account and target directory stay fixed while the upload dialog is open.
- Verify your download using `SHA256SUMS.txt`.
- Unsigned build. Internet access is needed to install WebView2 if it is missing.
