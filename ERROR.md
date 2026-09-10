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
