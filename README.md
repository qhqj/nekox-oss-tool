# nekox-oss-tool

一个纯前端、面向本地/内网使用的阿里云 OSS 快速文件工具。

## 已包含

- Vue 3 + Vite + TypeScript。
- 浏览器直接连接阿里云 OSS。
- Region / Bucket / AccessKey ID / AccessKey Secret / STS Token / Endpoint / 公共域名可在 UI 中修改。
- 凭证默认只存在当前页面内存，不写入 localStorage。
- 文件夹按需浏览；目录列表默认只显示文件名与大小。
- 不生成缩略图、不自动预览、不自动下载对象内容。
- 上传弹窗：选择文件、修改上传文件名、显示目标路径。
- 同名文件自动重命名：`a.png` → `a (1).png` → `a (2).png`。
- 大文件自动使用 multipartUpload，并显示上传进度。
- 上传完成后输出公共访问 URL，可一键复制。
- 文件操作只保留“复制链接 / 下载”；首版不做删除、移动、重命名，避免误操作。
- 单目录超过 300 项时支持继续翻页。

## 快速启动

```bash
npm install
npm run dev
```

构建静态文件：

```bash
npm run build
```

产物位于 `dist/`，可直接交给 Nginx / 宝塔静态站点托管。

## OSS 侧需要准备

### 1. CORS

浏览器会直接请求 OSS，Bucket 必须配置 CORS。建议：

- Allowed Origins：本地开发域名与实际部署域名，例如 `http://localhost:5173`、`https://oss-tool.example.com`。
- Allowed Methods：`GET`、`PUT`、`POST`、`HEAD`。
- Allowed Headers：`*`。
- Expose Headers：至少可加入 `ETag`、`x-oss-request-id`、`x-oss-version-id`。

### 2. 权限

不要使用主账号 AccessKey。建议创建专用 RAM 用户，并且只给目标 Bucket 必要权限：

- `oss:ListObjects`
- `oss:GetObject`
- `oss:PutObject`

如果未来增加删除/移动，再单独追加对应权限，不要预先放大权限。

### 3. 公共读

本工具上传完成后给出的“公共链接”假设对象可以匿名读取：

- Bucket / 对象 ACL 已允许公共读；或
- 已配置可公开访问的 CDN / 自定义域名，并在“公共访问基础地址”中填写。

如果 Bucket 是私有读，“复制公共链接”不会自动变成长期可访问链接；下载按钮则使用当前凭证生成短期签名 URL。

## 安全边界

**纯前端静态 AccessKey Secret 会暴露给浏览器环境。**

当前项目保留 AccessKey ID / Secret 输入，是为了满足可信本地工具、内网工具、个人运维页等快速场景；不建议把长期 Secret 直接部署到公开网站并交给不受信任用户使用。

正式公网场景建议保持前端不变，仅把认证方式换成：

1. 前端向一个极小的 STS 接口获取临时凭证；
2. 用临时 `AccessKeyId + AccessKeySecret + SecurityToken` 初始化 OSS SDK；
3. 临时权限只允许指定 Bucket / Prefix / 操作，并设置较短有效期。

项目已经预留 `STS Token` 字段，后续改造不会影响文件浏览和上传模块。

## 设计取舍

### 为什么目录页不做预览

本工具目标是“快速上传和定位对象”，不是图库。目录浏览只请求对象列表元数据，避免用户只是打开页面就触发大量文件 GET 和外网流量。

### 为什么首版不做删除

上传工具最容易出现的高风险操作是误删，尤其当使用高权限 AccessKey 时。首版主动收窄为 List / Get / Put，后续确实需要再加入删除，并增加二次确认与权限开关。

## 可以继续补充的功能

建议按需要再做，不要首版一次堆满：

- 拖拽上传 / 多文件队列。
- 上传到指定 Prefix，而不必先进入目录。
- 新建“目录”占位对象。
- 最近上传记录（只保存 key / URL，不保存凭证）。
- 自定义上传 Content-Type / Cache-Control。
- 文件搜索（Prefix 搜索）。
- 删除 / 移动 / 重命名（必须独立开关 + 二次确认）。
- STS 自动刷新。
- 多 Bucket 配置档案，但敏感凭证仍不持久化。

## 目录结构

```text
nekox-oss-tool/
├─ src/
│  ├─ components/
│  │  ├─ ConfigModal.vue
│  │  └─ UploadModal.vue
│  ├─ services/
│  │  └─ oss.ts
│  ├─ types/
│  │  └─ oss.ts
│  ├─ utils/
│  │  └─ file.ts
│  ├─ App.vue
│  ├─ main.ts
│  └─ style.css
├─ AGENTS.md
├─ ERROR.md
├─ package.json
└─ vite.config.ts
```
