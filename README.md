# LAN Note Sync 0.4：CouchDB + 独立 Obsidian 插件

目标是把配置留在服务端：管理员部署一次，Windows 和 macOS 用户运行一条安装命令、选择笔记库，在 Obsidian 中启用插件并确认首次同步。

这是一套独立实现，不依赖或派生自 Self-hosted LiveSync。CouchDB 负责持久化，插件和网关使用本项目自己的同步协议。当前是可试用版本，尚未完成 macOS 实机和长期运行验收。

## 部署和接入

**Rocky Linux / 1Panel 镜像部署**：使用 [GHCR 和 1Panel 指南](docs/ONEPANEL_GHCR.md) 及 `compose.production.yaml`；以下为本地源码构建方式。0.4 新增[管理员后台、多仓库和排除规则](docs/ADMIN_GUIDE.md)，浏览器打开服务地址的 `/admin/` 即可管理。

数据盘安装可在快捷 SSH 安装命令末尾加 `--data-dir /data/lan-note-sync`，将数据库、网关状态和部署配置都放到该目录；已有部署不会自动迁移，详见指南。

先安装并启动 Docker Desktop（Linux 服务器使用 Docker Engine + Compose v2），解压服务部署包，在包根目录执行：

Windows PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deployment\setup.ps1
```

macOS / Linux：

```bash
bash deployment/setup.sh
```

脚本自动生成 CouchDB 密码、创建数据卷、构建两个容器、等待数据库与网关健康，并输出 Windows / macOS 安装命令。首次需要下载基础镜像和构建依赖。默认只允许本机访问。

发给其他电脑使用时，需要一个它们能够访问的服务地址。可信局域网试用示例（替换示例 IP）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deployment\setup.ps1 -PublicUrl http://192.168.1.10:27123 -ExposeLan
```

```bash
bash deployment/setup.sh --public-url http://192.168.1.10:27123 --expose-lan
```

局域网和 Tailscale 可直接使用 HTTP；公开到互联网时使用 HTTPS。脚本不会自动申请域名、配置公网穿透或处理防火墙。已有 `.env` 会保留；更改地址和监听范围的方法见[部署说明](docs/SERVER_QUICKSTART.md)。

管理员把生成的对应系统安装命令发给用户。用户无需填写数据库地址、账号、密码或同步参数：

1. 在 Obsidian 建立或打开目标笔记库。
2. 运行安装命令。Windows 只有一个已登记笔记库时自动选择，否则弹窗；macOS 弹窗选择。
3. 在 Obsidian 的第三方插件中启用 **LAN Note Sync**。已有窗口未发现新插件时重新打开笔记库。
4. 插件自动读取连接信息，展示首次同步预览；确认后开始同步。HTTP 内网连接另有一次明文连接提示。

首次启用第三方插件仍需用户操作。安装器不会替用户关闭受限模式或修改插件启用列表。

给第二台设备生成新邀请：

```text
docker compose exec -T sync node dist/server/cli.cjs invite
```

重复邀请默认加入同一个远端笔记库。每台设备独立邀请，10 分钟有效；不要转发同一条命令给多人。已安装插件的用户也可以只粘贴完整 `lansync:` 连接码。创建独立远端笔记库使用 `invite --new-vault`；后续加入该库用 `--vault <ID>`。

## 当前功能和范围

- 一个管理员密码管理后台：总览、独立仓库、一次性设备接入、修订记录、撤销授权与排除同步。
- 每个本地 Vault 独立绑定；多个 Vault 可连接同一个服务，远端数据按仓库隔离。
- Markdown 新建、修改、移动、删除；保留 UTF-8 原始字节、BOM、CRLF 和空笔记。
- 离线后重试、提交幂等、并发冲突保留、显式版本选择、历史预览及恢复。
- 首次同步预览、发送和接收两侧的批量删除确认、本地替换快照、打开中的笔记延迟替换。
- 一次性连接码、设备独立凭证和撤销；永久凭证保存在 Obsidian 密钥存储。
- CouchDB 自动初始化，Docker 数据卷持久化，网关异常重启后重新核对基线。

首版仅面向 Windows/macOS 桌面端 **Markdown**；不含图片/PDF 等附件、移动端、配置同步、端到端加密、自动升级、自动服务器迁移或多网关高可用。每个文件最大 5 MiB，每库最多 10,000 个逻辑文件（包括已删除文件身份）；历史和快照不自动清理。

插件不直连 CouchDB。结构为：`Obsidian 插件 → HTTP(S) 网关 → CouchDB`。客户端不接触 CouchDB 管理员密码，也不需要配置 CouchDB CORS。Compose 只发布网关端口，数据库留在内部网络。

运行时固定 Node.js 24.15.0、CouchDB 3.5.3；Obsidian 最低 1.11.4。网关使用 TypeScript + Node 原生 HTTP；没有额外 Web 框架。CouchDB 是持久化底座，文件应用、冲突和断线恢复仍由本项目实现和验证。

## 验证结果

2026-11-08：35 项自动化测试通过，包含真实 CouchDB 测试、Windows PowerShell 安装器和 Bash 安装器测试。Windows Obsidian 1.12.7 已验证自动接入、首次预览、同步和设置界面。

两个生产 Docker 镜像已实际构建并运行，通过强制终止网关再启动后的身份、正文及历史保留验证。当前 Docker 集成环境使用 WSL 隔离守护进程和 host-network 测试覆盖；用户实际 Rocky Linux/1Panel 尚未验收。GHCR 双架构发布及 Windows/macOS/真实 CouchDB 远端 CI 已通过；macOS 安装脚本已在原生 CI 执行，但 macOS Obsidian GUI 尚未实机验收。

详见[设计](docs/COUCHDB_DESIGN.md)、[部署与运维](docs/SERVER_QUICKSTART.md)、[测试记录](docs/COUCHDB_TEST_REPORT.md)。

## 开发

```text
npm ci
npm run build
npm test
```

真实 CouchDB 集成测试需要先在 `.test-runtime/couch-test.json` 配置专用测试数据库的 `{url,user,password}`，再执行 `npm run test:couch`。不要使用生产数据库凭证或生产数据库。测试创建随机数据库并清理。

默认后端是 CouchDB。旧 SQLite 后端仅保留为显式 `SYNC_BACKEND=sqlite` 的开发/旧版本兼容路径；没有从 v0.2 数据库到 CouchDB 的自动迁移。旧版文档为归档，不再作为当前部署指南。

不要删除 `data.json` / `local-state` 来修复连接，也不要把插件状态复制到第二台设备。先用测试笔记库验证，正式切换时保留原库和服务数据，并停止同一目录的其他同步工具。
