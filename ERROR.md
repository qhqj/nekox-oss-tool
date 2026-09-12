# ERROR.md

用于记录开发过程中真正影响实现的错误、根因与最终修复，避免 Agent 重复试错。

## 记录模板

### YYYY-MM-DD — 简短标题

- **现象**：
- **根因**：
- **修复**：
- **验证**：
- **不要重复的尝试**：

---

## 常见运行问题

### CORS / Network Error

- **现象**：连接配置正确，但浏览器报跨域、Network Error、preflight 失败。
- **优先检查**：Bucket CORS 是否允许当前页面 Origin、GET/PUT/POST/HEAD、Headers `*`。
- **注意**：这通常不是 Vite 代理问题；本项目设计为浏览器直连 OSS。

### SignatureDoesNotMatch

- **优先检查**：Region、Endpoint、AccessKey、STS Token 是否匹配；系统时间是否异常。
- **注意**：项目默认启用 V4 签名。

### AccessDenied

- **优先检查**：RAM 用户是否具备当前 Bucket 的 List/Get/Put 权限，以及 Resource 范围是否覆盖当前 Prefix。

## 2026-09-10 — Tauri 构建参数转发

- **现象**：`npm run build:desktop -- --locked` 报 unexpected argument。
- **根因**：`--locked` 是 Cargo 参数，需要越过 npm 与 Tauri 两层参数解析。
- **修复**：使用 `npm run build:desktop -- -- --locked`，CI 同步使用此命令。
- **验证**：修正后通过前端构建并进入 Cargo 编译。

## 2026-09-12 — 多账号凭证持久化与错误提示

- **现象**：旧单账号实现将 Secret / STS Token 明文写入 localStorage；SDK 原始错误可能将请求信息带入 UI。
- **根因**：旧配置序列化未区分凭证与元数据，错误格式化直接显示 SDK message。
- **修复**：Windows 使用当前用户 DPAPI 加密账号库；旧数据成功迁移后清理。Web 仅保存允许的非敏感字段，凭证留在会话。OSS 错误只按已知代码与网络类型给出固定提示，不回显原始请求内容。
- **验证**：合成凭证测试覆盖迁移成功/失败、明文清理、异常格式、存储失败、错误脱敏；原生测试覆盖加解密、篡改拒绝、替换与保存失败保留旧库。

## 2026-09-12 — Windows 单元测试中的 public 资源路径

- **现象**：Vue 单元测试将 `/app-icon.svg` 当作 `file:///app-icon.svg` 导入，Windows 路径解析失败。
- **根因**：测试中的 Vue 模板资源转换与实际 Vite public 文件服务不同。
- **修复**：仅在 Vitest 的 Vue 插件中关闭模板资源 URL 转换；生产构建仍使用原配置。
- **验证**：App 账号切换与上传隔离测试通过。
