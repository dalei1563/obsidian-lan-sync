# LAN Note Sync 0.5：CouchDB + 独立 Obsidian 插件

**项目路线：只开发自建 LAN Note Sync。原飞书云盘／多维表格方案已于 2026-11-10 废弃；原 SPEC 仅作历史归档，不是后续需求或验收依据。** 现行设计见 [LAN 同步设计](docs/LAN_SYNC_DESIGN.md) 与 [CouchDB 设计](docs/COUCHDB_DESIGN.md)。

原 SPEC 在本工作区中被 Git 忽略且未跟踪，已在本地文件顶部标注废弃；它不随仓库提交或构建包分发。

目标是把配置留在服务端：管理员部署一次，Windows 和 macOS 用户运行一条安装命令、选择笔记库，在 Obsidian 中启用插件并确认首次同步。

这是一套独立实现，不依赖或派生自 Self-hosted LiveSync。CouchDB 负责持久化，插件和网关使用本项目自己的同步协议。当前是可试用版本，尚未完成 macOS 实机和长期运行验收。

0.5 新增双向覆盖预览、后台文件和整库历史恢复、插件自动下载更新，以及 ZIP 手动安装。已有设备首次升级到 0.5 仍需运行一次安装命令；之后插件可自动下载新版，重启 Obsidian 后生效。

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
4. 插件自动读取连接信息；选择云端覆盖本地或本地覆盖云端，查看变化后确认。云端覆盖前需自行备份本地笔记库。HTTP 内网连接另有一次明文连接提示。

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
- 首次及已绑定仓库均可选择覆盖方向，执行前列出变化；发送和接收两侧有批量删除确认。
- 管理后台可预览文件和单个文件历史，也可将整个仓库恢复到一次变更后的状态；恢复会追加新版本。
- 插件从服务自动下载更新（默认开启），重启 Obsidian 后生效；管理后台也提供 ZIP 手动安装。
- 一次性连接码、设备独立凭证和撤销；永久凭证保存在 Obsidian 密钥存储。
- CouchDB 自动初始化，Docker 数据卷持久化，网关异常重启后重新核对基线。

首版仅面向 Windows/macOS 桌面端 **Markdown**；不含图片/PDF 等附件、移动端、配置同步、端到端加密、自动服务器迁移或多网关高可用。每个文件最大 5 MiB，每库最多 10,000 个逻辑文件（包括已删除文件身份）；历史和快照不自动清理。

插件提供容量采样和可配置告警，也可在预览、明确确认后清理本机恢复快照。该清理不可从原目录撤销，可能删除尚未提交内容的唯一恢复副本；先确认独立备份。历史容量是已引用正文的去重逻辑估算，不能代替服务器物理磁盘监测；回收站统计不含系统回收站。详见[保留策略](docs/RETENTION_POLICY.md)。

插件不直连 CouchDB。结构为：`Obsidian 插件 → HTTP(S) 网关 → CouchDB`。客户端不接触 CouchDB 管理员密码，也不需要配置 CouchDB CORS。Compose 只发布网关端口，数据库留在内部网络。

运行时固定 Node.js 24.15.0、CouchDB 3.5.3；Obsidian 最低 1.11.4。网关使用 TypeScript + Node 原生 HTTP；没有额外 Web 框架。CouchDB 是持久化底座，文件应用、冲突和断线恢复仍由本项目实现和验证。

## 验证结果

本加固分支最近一次 Windows 本机检查：`npm.cmd test` 129 项，117 通过、0 失败、12 跳过；`npm.cmd run build` 通过。跳过的 11 项需要真实 CouchDB，另 1 项因本机创建符号链接返回 `EPERM`。**本加固分支的 CouchDB 行为未在真实 CouchDB 上验证。** 现有 SQLite 和模拟测试不能代替该验证。

历史测试记录曾报告旧版本 Windows Obsidian、真实 CouchDB、Docker 镜像及远端 CI 验证；这些结果不能证明当前分支通过。macOS Obsidian GUI、用户实际 Rocky Linux/1Panel、跨机 HTTPS、长期运行及当前分支强杀恢复尚待验收。发布前逐项核对[验收清单](docs/RELEASE_CHECKLIST.md)。

详见[设计](docs/COUCHDB_DESIGN.md)、[部署与运维](docs/SERVER_QUICKSTART.md)、[测试记录](docs/COUCHDB_TEST_REPORT.md)。

## 开发

```text
npm ci
npm run build
npm test
```

真实 CouchDB 集成测试需要先在 `.test-runtime/couch-test.json` 配置专用测试数据库的 `{url,user,password}`，再执行 `npm run test:couch`。不要使用生产数据库凭证或生产数据库。测试创建随机数据库并清理。

默认后端是 CouchDB。旧 SQLite 后端仅保留为显式 `SYNC_BACKEND=sqlite` 的开发/旧版本兼容路径；没有从 v0.2 数据库到 CouchDB 的自动迁移。旧版文档为归档，不再作为当前部署指南。

`src/feishu/auth.ts` 和 `tests/auth.test.cjs` 是已废弃的飞书 POC 鉴权探针及其独立模拟测试，保留作历史参考。它们不被 `src/main.ts` 或 LAN 运行时引用，探针不打入插件包，也不属于默认 `npm test`；TypeScript 检查仍包含 `src/feishu/auth.ts`。不要把该探针用于正式接入或据此判断飞书同步已实现。

不要删除 `data.json` / `local-state` 来修复连接，也不要把插件状态复制到第二台设备。先用测试笔记库验证，正式切换时保留原库和服务数据，并停止同一目录的其他同步工具。
