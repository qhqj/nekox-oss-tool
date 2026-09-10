<p align="center"><img src="public/app-icon.svg" width="96" alt="Nekox OSS Tool" /></p>
<h1 align="center">Nekox OSS Tool</h1>
<p align="center">一个轻巧、专注的阿里云 OSS 个人桌面文件工具。</p>
<p align="center">中文 · <a href="README.en.md">English</a> · <a href="https://github.com/qhqj/nekox-oss-tool/releases/latest">下载安装包</a></p>

## 安装

在 [Releases](https://github.com/qhqj/nekox-oss-tool/releases) 下载 `Nekox-OSS-Tool-版本-windows-x64-setup.exe`，双击安装。安装向导支持简体中文和英文，可选择安装位置，按当前用户安装。

- 面向 Windows 10 / 11 x64，依赖 Microsoft Edge WebView2；缺失时安装程序会联网下载运行环境。
- 当前安装包没有代码签名证书，Windows 可能显示未知发布者提示。
- 软件界面为中文；英文 README 和英文安装向导不代表软件已提供英文界面。

## 功能

- 连接 OSS：支持 Region、Bucket、AccessKey、STS Token、自定义 Endpoint 与公共域名，粘贴 OSS 域名可识别 Bucket 和地域。
- 按目录 Prefix 浏览，使用 `delimiter=/`，每页最多 300 项；只读取文件名和大小元数据。
- 上传至当前目录，可修改文件名；同名时按 `name (n).ext` 尝试避让并提示最终 Key。
- 8 MiB 及以上文件使用分片上传，显示进度与结果。
- 复制公共 URL，主动点击才预览图片或下载文件；桌面下载支持保存位置选择。
- 保留个人连接配置，下次启动自动尝试连接。暖色界面、统一应用图标、原生窗口控制。
- 无业务后端，无自动缩略图，无删除功能。

## 首次使用

1. 打开连接配置，填写自己的 Region、Bucket、AccessKey ID / Secret；使用临时凭证时同时填写 STS Token。
2. 点击“连接并刷新”，进入目录后上传文件或复制链接。
3. 需要公共链接时，对象必须能够匿名访问，或填写可公开访问的 CDN 基础地址。私有对象的下载使用短期签名 URL。

这是**单人桌面应用**：连接信息（包含 AccessKey Secret 和 STS Token）会以未加密形式保存在本机 WebView 存储中。仅在自己的可信电脑上使用，不要分享应用用户数据目录。源码与安装包不包含你的实际凭证。STS 过期后需要重新填写。

桌面端仍通过 WebView 直接请求 OSS，因此 Bucket 可能需要配置 CORS。发生跨域错误时，按应用错误提示中的实际 Origin 设置允许来源；允许所需 GET / PUT / POST / HEAD、请求头，以及暴露 `ETag`、`x-oss-request-id` 等响应头。按实际上传方式为专用 RAM 身份配置目标 Bucket 的列表、读取、写入及所需分片操作权限。

同名检测与上传不是原子操作，多客户端同时写同一 Key 时仍可能竞争。下载先在内存中读取完整文件，因此超大文件受可用内存限制。

## 本地开发与打包

需要 Node.js 22+、Rust stable MSVC、Visual Studio C++ Build Tools 和 WebView2。项目使用 Vue 3、Vite、TypeScript、ali-oss Browser SDK 和 Tauri 2。

```bash
npm ci
npm run dev:desktop
```

```bash
npm run typecheck
npm run build
npm run build:desktop
```

NSIS 安装包位于 `src-tauri/target/release/bundle/nsis/`。本次交付另提供 `install/setup.exe`；`install/` 不提交 Git，安装包通过 Releases 分发。`npm run dev` 仅用于前端开发预览。

图标源文件为 `public/app-icon.svg`，重新生成各尺寸图标：

```bash
npx tauri icon public/app-icon.svg
```

## 发布

`.github/workflows/release.yml` 在推送 `v*` 标签时执行 Windows 类型检查、前端与 NSIS 构建，上传安装包和 SHA-256 校验文件到 GitHub Release。发布前保持 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json` 的应用版本一致。

```bash
git push origin main
git tag v0.1.0
git push origin v0.1.0
```

后续版本使用新的版本号与标签；发布记录不提供应用内自动更新。
