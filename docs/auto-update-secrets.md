# 自动更新 Secrets 配置

本项目的自动更新使用阿里云 OSS 作为更新源，macOS 构建启用签名与公证。

## GitHub Secrets

在仓库 `Settings -> Secrets and variables -> Actions` 中添加以下 Secrets：

### macOS 签名

- `CSC_LINK`
  `.p12` 证书文件的 base64 内容，或 electron-builder 支持的证书下载地址。
- `CSC_KEY_PASSWORD`
  `.p12` 证书密码。

### macOS 公证

- `APPLE_ID`
  Apple Developer 账号邮箱。
- `APPLE_APP_SPECIFIC_PASSWORD`
  Apple ID 的 app-specific password。
- `APPLE_TEAM_ID`
  Apple Developer Team ID。

### 阿里云 OSS

- `ALIYUN_OSS_KEY_ID`
  OSS AccessKey ID。
- `ALIYUN_OSS_KEY_SECRET`
  OSS AccessKey Secret。
- `ALIYUN_OSS_BUCKET`
  用于承载更新文件的 Bucket 名称。
- `ALIYUN_OSS_ENDPOINT`
  OSS 上传 Endpoint，例如 `https://oss-cn-shanghai.aliyuncs.com`。
- `ALIYUN_OSS_UPDATE_URL`
  客户端访问更新文件的公开 URL，例如 `https://your-bucket.oss-cn-shanghai.aliyuncs.com/releases`。

## OSS 目录约定

CI 会把 `dist/` 中的更新产物上传到 `ALIYUN_OSS_UPDATE_URL` 对应的路径下，至少包括：

- `latest.yml`（Windows）
- `latest-linux.yml`（Linux）
- `latest-mac.yml`（仅 macOS）
- `*.zip`、`*.dmg`、`*.exe`、`*.blockmap`

如果 `ALIYUN_OSS_UPDATE_URL` 是 `https://your-bucket.oss-cn-shanghai.aliyuncs.com/releases`，那么 Windows / Linux 产物落在 Bucket 的 `releases/` 前缀下。

### macOS：按架构分子目录（重要）

GitHub Actions 上 **ARM64 与 Intel 两条 macOS 任务并行**，若二者都把 `latest-mac.yml` 传到同一前缀，**后完成的 job 会覆盖先完成的**，导致另一种架构的应用读到错误的元数据。`electron-updater` 在「元数据里没有任何带 `arm64` 的 zip」时，会在 Apple 芯片机型上退而安装 Intel 包。

因此 CI 会为 macOS 自动把更新基址设为：

- Apple 芯片：`{ALIYUN_OSS_UPDATE_URL}/mac-arm64/`（内含该架构的 `latest-mac.yml` 与 zip）
- Intel：`{ALIYUN_OSS_UPDATE_URL}/mac-x64/`

打包时会把上述带路径的 URL 写入应用内的更新配置，客户端只拉取本架构的 `latest-mac.yml`。

## 注意事项

- macOS 自动更新依赖 `zip` 包和对应目录下的 `latest-mac.yml`，首次安装仍建议分发 `dmg`。
- `latest*.yml` 建议通过 CDN/OSS 设置为 `Cache-Control: no-cache`，避免客户端读取到旧元数据。
- Windows 当前未接入签名证书，但自动更新流程仍可工作；如果后续补签名，可直接在工作流中追加对应环境变量。
