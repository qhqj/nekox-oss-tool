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
- 多账号列表：每个账号可保存名称、备注、Bucket 与 AccessKey ID；Secret / STS Token 仅保留在本次会话。侧栏一键切换，连接失败保留原连接。
- 批量上传文件，或选择文件夹自动递归，保留根文件夹及子目录结构，上传到当前 Prefix；空文件夹不会生成 OSS 对象。
- 上传队列显示每个文件的进度、成功、失败与跳过状态，可移除待上传项、重试失败项、在当前文件完成后暂停。
- 发现同名文件弹窗选择“覆盖 / 不上传 / 自动重命名”，可应用到本轮后续冲突；改名按 `name (n).ext` 递增。成功项显示最终 Object Key 与公共链接。
- 8 MiB 及以上文件使用分片上传，显示进度与结果。
- 复制公共 URL，主动点击才预览图片或下载文件；桌面下载支持保存位置选择。
- Windows 使用当前用户的 DPAPI 加密保存账号资料，重启后需重新输入 Secret / STS Token。暖色界面、统一应用图标、原生窗口控制。
- 无业务后端，无自动缩略图，无删除功能。

## 首次使用

1. 打开“管理账号”，新增账号，填写名称、备注、Region、Bucket、AccessKey ID / Secret；使用临时凭证时同时填写 STS Token。
2. 保存并连接，进入目标目录，点击“上传文件 / 文件夹”，选择文件后确认开始上传。文件夹会保留自己的根目录，例如 `photos/2026/a.jpg`。
3. 需要公共链接时，对象必须能够匿名访问，或填写可公开访问的 CDN 基础地址。私有对象的下载使用短期签名 URL。

Windows 桌面端将非敏感账号资料通过 **DPAPI 加密**保存到应用本地数据目录的 `accounts-v1.dpapi`，解密绑定当前 Windows 用户。Secret / STS Token 仅在当前会话中保留，保存到账号库时对应字段为空。旧加密库中的凭据不会恢复使用，单纯读取账号列表不会改写旧库；下次成功保存账号时会清除库中的旧凭据。旧版 WebView 单账号配置在升级后运行时迁移：凭据迁入当次会话，账号资料成功写入加密库后才清理旧配置。账号库不是跨用户可恢复的备份；重启或 STS 过期后需重新填写凭据。

Web 开发预览仅保存账号名称、备注及非敏感连接元数据，Secret 与 STS Token 仅在当前页面会话中保留，刷新页面后需要重新填写。长期 AccessKey 直连适用于可信本机/内网使用；正式公网部署应使用 STS。

Endpoint 和公共访问基础地址仅接受 HTTPS；省略协议的域名会规范为 HTTPS。Endpoint 不能带路径，公共地址允许 CDN 路径前缀；两者均拒绝用户名、密码、查询参数与片段。不自动更改 Bucket 的 CORS 或 RAM 权限。

账号切换和目录切换在上传弹窗打开期间锁定。移除账号只删除本机配置，不会删除 Bucket 中的对象。

桌面端仍通过 WebView 直接请求 OSS，因此 Bucket 可能需要配置 CORS。发生跨域错误时，按应用错误提示中的实际 Origin 设置允许来源；允许所需 GET / PUT / POST / HEAD、请求头，以及暴露 `ETag`、`x-oss-request-id` 等响应头。按实际上传方式为专用 RAM 身份配置目标 Bucket 的列表、读取、写入及所需分片操作权限。

同名检测仅使用 ListObjectsV2，不额外读取对象内容。未选择覆盖时上传附带 `x-oss-forbid-overwrite`；普通 Bucket 可借此拒绝检测后的并发覆盖。**OSS 在已开启或暂停版本控制的 Bucket 中会忽略此请求头**，因此这些 Bucket 的并发同名保护仍有局限。参见 [阿里云同名覆盖说明](https://help.aliyun.com/zh/oss/developer-reference/prevent-objects-from-being-overwritten-by-objects-with-the-same-names)。选择覆盖会写入用户确认的同名 Key。

防覆盖头同时传到普通 PUT、分片初始化和分片完成请求。发生服务端同名冲突时最多尝试 5 次写入；自动重命名会排除此前被服务端拒绝的 Key，避免列表暂未更新时反复尝试同名。不会对未知网络错误自动重传整个文件。桌面保存仅新增必要的写文件命令权限，目标路径仍由用户保存对话框授权，不放开任意文件路径。

批量上传逐文件进行，大文件内部使用分片并行；“暂停”等待当前文件完成，不立即中断网络请求。队列保留在当前弹窗内，关闭后不会持久化未完成任务。文件夹中空目录不会上传；文件名按相对路径校验。下载先在内存中读取完整文件，超大文件受可用内存限制。

## 本地开发与打包

需要 Node.js 22+、Rust stable MSVC、Visual Studio C++ Build Tools 和 WebView2。项目使用 Vue 3、Vite、TypeScript、ali-oss Browser SDK 和 Tauri 2。

```bash
npm ci
npm run dev:desktop
```

```bash
npm run typecheck
npm test
npm run build
npm run build:desktop
```

NSIS 安装包位于 `src-tauri/target/release/bundle/nsis/`。本地交付副本与 SHA-256 位于 `install/`；此目录不提交 Git。`npm run dev` 仅用于前端开发预览。自动化测试使用模拟 OSS 请求及合成凭证，不代表真实 Bucket 联调。

仅验证构建、避免读取本机 `.env` 时，运行 `npm run build -- --config tests/build.config.ts`。Vitest 也禁用 `.env` 加载。

Windows 也可运行 `powershell -ExecutionPolicy Bypass -File scripts/package-desktop.ps1`：自动发现项目本地 Rust（如存在）及已安装的 C++ 工具链，执行加密账号库测试、构建安装包并生成校验文件，不修改系统环境变量。仅验证原生账号库可追加 `-NativeTestsOnly`。

图标源文件为 `public/app-icon.svg`，重新生成各尺寸图标：

```bash
npx tauri icon public/app-icon.svg
```

## 发布

`.github/workflows/release.yml` 在推送 `v*` 标签时执行 Windows 类型检查、前端与 NSIS 构建，上传安装包和 SHA-256 校验文件到 GitHub Release。发布前保持 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json` 的应用版本一致。

```bash
git push origin main
git tag v0.2.0
git push origin v0.2.0
```

后续版本使用新的版本号与标签；发布记录不提供应用内自动更新。
