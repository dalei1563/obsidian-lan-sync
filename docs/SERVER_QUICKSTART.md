# LAN Note Sync 部署与运维

本文适用于现行 LAN 路线。提交 `1df81c4` 已在隔离 Linux 上通过 11 项真实 CouchDB 3.5.3 测试，但阶段 2 部分故障注入、容量与协议场景仍只在 SQLite／模拟环境测试；实际 Rocky Linux / 1Panel、跨机 HTTPS、macOS Obsidian GUI 和生产跨版本升级尚未验收。投入实际使用前请完成[发布前验收清单](RELEASE_CHECKLIST.md)。下面是部署步骤，不代表已在目标环境执行。

1Panel / Rocky Linux 使用预构建镜像时，见 [GHCR 镜像部署指南](ONEPANEL_GHCR.md)。下面为源码构建部署，生产镜像部署不需要在服务器编译。

## 管理员首次部署

要求 Docker 已安装并运行，Compose v2 支持 `--wait`。不需要在主机安装 Node 或手动安装 CouchDB。解压完整服务包，在包含 `compose.yaml` 的目录执行：

Windows：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deployment\setup.ps1
```

macOS / Linux：

```bash
bash deployment/setup.sh
```

默认只有本机能访问 `http://127.0.0.1:27123`。脚本生成随机数据库密码并保存在本地 `.env`，构建/启动 CouchDB 与网关，等待健康检查，再生成接入命令。首次镜像下载需要联网；已有配置和数据会保留。

提供给其他电脑时，**127.0.0.1 不能作为连接地址**。可信局域网试用时，替换以下示例 IP 为服务器地址：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deployment\setup.ps1 -PublicUrl http://192.168.1.10:27123 -ExposeLan
```

```bash
bash deployment/setup.sh --public-url http://192.168.1.10:27123 --expose-lan
```

此模式使用 HTTP，客户端首次接入会提示明文传输。正式使用建议部署可信 HTTPS 反向代理，保持网关回环绑定，原样转发服务根路径下所有路由（包括 `/v1/`、`/install/`、`/install.ps1`、`/install.sh` 和 `/admin/`）。代理应允许至少 5 MiB 请求、30 秒处理时间，并保持 Authorization 请求头。TLS 终止在代理上，CouchDB 不向客户端开放。向设备提供可访问的 HTTPS 根地址；管理台经 HTTPS 使用时将 `.env` 的 `SYNC_ADMIN_SECURE_COOKIE` 设为 `true`，更改后重新创建网关。证书、DNS、反向代理及防火墙需按实际环境配置，本项目不自动配置。

已有 `.env` 时 setup 不会覆盖任何配置，也不会应用新的 PublicUrl/ExposeLan 参数。需要改地址时，编辑其中 `SYNC_PUBLIC_URL`（设备可达的根 HTTP(S) URL，不含子路径）和 `SYNC_LISTEN_ADDRESS`（`127.0.0.1` 或 `0.0.0.0`），然后执行：

```text
docker compose up -d --wait
```

保留原 `COUCHDB_USER` / `COUCHDB_PASSWORD`。不要通过删除 `.env` 重置部署，否则旧数据库的凭证会失配。更换已经绑定设备的服务器地址目前没有一键迁移。

## 发给用户的一条命令

```text
docker compose exec -T sync node dist/server/cli.cjs invite
```

输出完整连接码，以及 Windows / macOS 各一条安装命令。每台设备单独生成，10 分钟有效。重复执行默认接入同一个远端库，无需手填 Vault ID。

用户操作：先在 Obsidian 创建或打开目标库 → 运行对应命令 → 选择库（Windows 唯一登记库自动选择）→ 在 Obsidian 启用 LAN Note Sync → 查看首次预览并确认。安装后插件自动接入，客户端不填数据库参数。用户可以手动传 `-VaultPath 'D:\Notes'` 或 `--vault '/Users/me/Notes'`，自定义 Obsidian 配置目录用 `-ConfigDir` / `--config-dir`。

安装器只安装目标库内 `.obsidian/plugins/lan-note-sync`，校验三个插件文件的 SHA-256，不修改笔记、其他插件和 `community-plugins.json`。首次启用第三方插件需用户在 Obsidian 完成；受限模式需要先由用户关闭。尚未发布公共下载地址，安装脚本和插件由本次部署的网关提供。

一条邀请不能给多台设备共用。连接码可能出现在本机终端历史中，但它有时效且绑定首次认领；长期设备令牌不进入安装命令、插件普通配置或日志。

创建另一个独立远端库：

```text
docker compose exec -T sync node dist/server/cli.cjs invite --new-vault --name "Work Notes"
```

此命令不会替换原默认库。后续设备加入新库使用输出的 Vault ID：

```text
docker compose exec -T sync node dist/server/cli.cjs invite --vault <vault-id>
```

## 检查和设备管理

```text
docker compose ps
docker compose logs --tail 50 sync
docker compose exec -T sync node dist/server/cli.cjs devices
docker compose exec -T sync node dist/server/cli.cjs revoke --device <device-id>
```

网关的 `/v1/health` 会同时检查 CouchDB 连通性。`invite` 可重试，过期就重新生成。插件内“连接诊断与恢复 → 检查连接”可检查服务版本和健康。

如果已配对设备失去凭证或需要改绑，先保留整个插件状态目录和笔记，不要删除基线来重试。当前没有安全的一键重新绑定流程。

## 更新

服务端：更新前记录当前镜像或源码版本、Compose 项目名和数据位置，停止服务并对 CouchDB、gateway 数据及 `.env` 做一致备份。源码部署将新源码包解压到新目录并复制原 `.env`，核对项目名仍是 `lan-note-sync-couch` 和原卷映射，再在新目录执行 `docker compose up -d --build --wait`。镜像部署按 [1Panel 指南](ONEPANEL_GHCR.md) 使用已验证的固定版本。不要同时启动两个网关副本连接同一数据库，也不要同时运行两个不同版本的同步插件。更新后检查两个服务健康、协议版本、测试 Vault 的双向同步和历史恢复。

客户端：从 0.4 首次升级至 0.5 时，先关闭 Obsidian，使用后台提供的对应系统安装命令，选择原 Vault；当前安装器不要求追加 `-Upgrade` / `--upgrade`。已绑定时安装器保留原连接与本地状态，并将旧插件目录留在 Vault 配置目录下的 `lan-note-sync-backups`。0.5 以后插件默认从已连接服务下载更新，重启 Obsidian 生效；也可在设置中手动检查。升级前保留独立备份，先在测试 Vault 验证。

## 回滚

回滚前停止新写入并保存当前故障现场和完整数据备份，不直接删除状态或覆盖原数据。先在隔离环境检查旧服务／插件是否支持当前数据和协议：兼容时，可将服务镜像或源码固定回记录的版本，并恢复对应配置；若数据格式不兼容，需在隔离环境成对恢复升级前的 CouchDB、gateway 及 `.env` 一致备份。恢复旧备份会丢失备份之后的服务端变更，必须先保存并核对这些变更，不能静默覆盖。客户端可在关闭 Obsidian 后检查安装器或自动更新保留的备份，但旧插件是否能读取当前本地状态必须先验证；不要把其他设备的状态复制过来。先完成测试 Vault 的历史、凭证和双向同步验证，再决定是否切回实际环境。当前没有自动回滚或数据库导入工具。

## 持久化和备份

必须同时保留：

- Compose 项目对应的 `couch-data` 卷：正文、修订、邀请和设备记录。
- `gateway-data` 卷：网关所有权标识、默认远端库 ID 等。
- `.env` 和部署配置：数据库访问凭证、地址等。

推荐停服后对这两卷及配置做一致的外部备份，恢复到空的新卷并保持相同权限，再启动并验证。可用 Docker 主机或 NAS 的卷快照/备份工具；快照时两个服务均需停止。不要运行 `docker compose down -v`，该命令会删除数据卷。普通 `docker compose down` / `up` 保留命名卷。

网关另提供数据库文档导出：

```text
docker compose exec -T sync node dist/server/cli.cjs backup --out /tmp/couch-export-new
docker compose cp sync:/tmp/couch-export-new ./couch-export-new
```

输出目录必须不存在。导出包含原始正文、历史、设备记录及敏感控制信息，并核验正文哈希和修订引用；只有 `backup.json` 中 `complete: true` 才是完整导出。繁忙写入导致引用校验失败时需停止写入后重试新目录。

**文档导出不等于 Docker 数据卷备份。当前没有自动导入/恢复命令，不能把导出目录直接当 `--data` 启动。** 灾备应保留两卷与 `.env`；在没有导入工具的本版中，不要把 JSONL 导出作为唯一备份。仅复制 CouchDB 卷或丢失网关所有权文件，会因绑定检查而停止启动。

## 当前验收范围

当前为 0.5 试用路线，仅同步桌面端 Markdown，不含附件和端到端加密。旧版本曾在 Windows、真实 CouchDB 和 WSL 隔离 Docker 的 host-network 环境验证；这些历史记录不能证明当前加固分支通过。当前提交 `1df81c4` 的 11 项真实 CouchDB 测试已在隔离 Linux 通过，覆盖范围和剩余未验证项见 `docs/RELEASE_CHECKLIST.md`；macOS 实机、目标机默认 bridge 网络、跨机 HTTPS、NAS 权限和长期运行仍需实际验收。
