# AGENTS.md — nekox-oss-tool

## 项目目标

维护一个“足够简单、可快速构建”的纯前端 OSS 文件工具。核心动作只有：

1. 连接 OSS。
2. 按 Prefix 浏览对象结构。
3. 上传文件。
4. 复制公共链接。
5. 用户主动点击时下载文件。

不要把项目演变成完整 OSS 管理后台。

## 技术边界

- Vue 3 + Vite + TypeScript。
- 使用 `ali-oss` Browser.js SDK。
- 不新增业务后端。
- 除非需求明确变化，否则不引入大型 UI 框架。
- 保持 `npm run build` 与 `npm run typecheck` 可通过。

## 安全约束

- 不允许把 AccessKey Secret、STS Token 写进源码、`.env`、localStorage、IndexedDB、日志或错误上报。Windows 桌面端仅通过当前用户 DPAPI 加密账号库保存；Web 预览仅在会话内保留凭证。
- UI 中 Secret 使用 password 输入框。
- 长期 AccessKey 直连仅视为本地/内网兼容模式；正式公网方案优先 STS。
- 不主动扩大 RAM 权限。
- 首版不实现删除、批量删除、清空 Bucket。

## 成本约束

- 文件列表只读取 ListObjects/ListObjectsV2 返回的元数据。
- 不为每个对象额外调用 HEAD/GET 来补充信息。
- 不自动加载图片、视频、音频、PDF 预览。
- 不自动下载文件。
- 用户点击“下载”才生成下载 URL 并触发浏览器访问。

## OSS 行为

- 目录只是 Object Key Prefix，不假设存在真实文件夹。
- 浏览目录使用 `delimiter=/`。
- 上传文件默认进入当前 Prefix。
- 用户手动输入的上传文件名不允许包含路径分隔符；文件夹上传仅接收选择器提供且校验过的相对路径，保留根文件夹与子目录，不允许绝对路径或 `..`。
- 同名对象由用户在弹窗中选择覆盖、跳过或按 `name (n).ext` 自动改名；默认不覆盖。允许将选择应用到本轮后续冲突。
- 上传弹窗打开期间固定账号和 Prefix，禁止切换账号或目录。成功项显示最终 Key 和 URL，失败项可重试。
- 公共 URL 优先使用 `publicBaseUrl`，否则按 `https://{bucket}.{region}.aliyuncs.com/{key}` 生成。

## UI 约束

- 默认文件列表仅显示：文件名、大小。
- 文件夹大小显示 `—`。
- 允许显示操作按钮，但不要默认展示对象内容详情。
- 配置、上传使用弹窗。
- 上传完成必须显示最终 Object Key 与公共 URL。
- 同名自动重命名后必须提示用户。

## 建议提交格式

```text
feat: 增加 OSS 多文件上传队列

上传弹窗支持多文件选择并按当前 Prefix 生成目标 Key
队列显示等待/上传中/成功/失败状态，失败项可单独重试
保持同名自动重命名策略，不覆盖已有对象
不增加文件预览与自动下载请求
npm run typecheck 与 npm run build 通过
```

## 修改流程

1. 先确认是否会增加额外 OSS 请求或外网流量。
2. 确认是否扩大凭证暴露面或 RAM 权限。
3. 修改代码。
4. 执行 `npm run typecheck`。
5. 执行 `npm run build`。
6. 若出现问题，在 `ERROR.md` 记录根因与最终修复，不记录无意义的重复尝试。
