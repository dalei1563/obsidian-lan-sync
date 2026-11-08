# Rocky Linux / 1Panel：使用 GHCR 镜像部署

## 发布状态

2026-11-08：**两个 0.3.1 镜像已发布**，支持 linux/amd64 和 linux/arm64；0.3.1 修复通过 Tailscale 地址安装时的代理绕过问题。源码仓库为 [dalei1563/obsidian-lan-sync](https://github.com/dalei1563/obsidian-lan-sync)。[跨主机测试记录](TAILSCALE_TEST_REPORT.md)。

```text
ghcr.io/dalei1563/obsidian-lan-sync:0.3.1
ghcr.io/dalei1563/obsidian-lan-sync-couchdb:0.3.1
```

发布记录：[GHCR 构建](https://github.com/dalei1563/obsidian-lan-sync/actions/runs/42461228885)；[Windows、macOS 与真实 CouchDB CI](https://github.com/dalei1563/obsidian-lan-sync/actions/runs/42461315953) 均成功。macOS CI 通过不等同于 macOS Obsidian GUI 实机验收。

## 镜像和更新约定

主分支修改 package.json 版本号并提交，或发布匹配版本的 Git 标签，可触发 `.github/workflows/publish-images.yml`；也可在 Actions 手动运行。工作流先构建并运行真实 CouchDB 回归测试，然后发布：

```text
ghcr.io/dalei1563/obsidian-lan-sync:0.3.1
ghcr.io/dalei1563/obsidian-lan-sync-couchdb:0.3.1
```

工作流目标平台为 linux/amd64 和 linux/arm64；实际构建成功后才视为已支持。Tag、package.json 与插件 manifest.json 版本必须一致。使用 GitHub Actions 的 GITHUB_TOKEN，权限限定为发布作业的 packages:write；不在仓库或镜像中写入个人 Token。首次发布后检查两个 Package 的可见性，设为 Public 才能让服务器匿名拉取；公开源码仓库不等于镜像自动公开。

GitHub 官方说明：[发布镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)、[GHCR 可见性和认证](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

## SSH 一条命令部署（局域网 HTTP）

使用 `compose.production.yaml`，其中只有 image，没有 build。生产服务器不需要 Node、npm 或源码编译。

在服务器 SSH 终端执行下面一条命令即可。部署时无需填写 IP、域名或证书：

```bash
curl -fsSL https://raw.githubusercontent.com/dalei1563/obsidian-lan-sync/main/deployment/bootstrap-images.sh | bash
```

脚本下载固定提交的部署模板并校验 SHA-256，自动在 `/opt/lan-note-sync` 生成配置和随机数据库密码，拉取镜像并启动两个容器。快捷安装默认开放宿主机 27123 端口用于局域网 HTTP；CouchDB 不发布端口。1Panel 可以查看容器，无需额外导入或重复创建编排。既有配置不覆盖：若以前已生成回环监听配置，改 `.env` 中 `SYNC_LISTEN_ADDRESS=0.0.0.0` 后运行 `docker compose up -d`。

安装完成后，在客户端浏览器访问 `http://服务器IP:27123` 可检查服务页面。连接设备时，再使用该设备可达的地址生成邀请（替换示例 IP）：

```bash
cd /opt/lan-note-sync
docker compose exec -T sync node dist/server/cli.cjs invite --url http://192.168.1.10:27123
```

`--url` 仅写入本次邀请，不改变监听地址，也不需要重新部署。插件通过这条邀请得知服务器地址。每台设备单独生成邀请。

本机已经安装并运行 Docker 是前提。安装成功后两个容器应为 healthy。主机防火墙需要允许目标局域网设备访问 27123。

## 将数据放到 /data 数据盘

先确认 `/data` 已经挂载为你要使用的数据盘，再执行：

```bash
curl -fsSL https://raw.githubusercontent.com/dalei1563/obsidian-lan-sync/main/deployment/bootstrap-images.sh | bash -s -- --data-dir /data/lan-note-sync
```

不需要手动创建项目子目录。实际布局：

```text
/data/lan-note-sync/
├── couchdb/       # 笔记正文、历史和设备记录
├── gateway/       # 网关身份与默认笔记库等状态
└── deployment/    # compose.yaml、.env、权限初始化标记
```

该方式对 CouchDB 和网关使用两个绑定挂载，数据不再位于本项目的 Docker 命名卷中。配置文件也在数据盘；管理命令需要先 `cd /data/lan-note-sync/deployment`。Docker 镜像、容器日志、缓存仍遵循主机 Docker 的全局目录，本脚本不修改 1Panel 其他服务的 Docker 存储设置。

安装时仅为两个专用数据子目录初始化容器所需的属主和权限，服务仍以非 root 用户运行。Rocky Linux 的绑定挂载附带私有 SELinux `:Z` 标签，不要求关闭 SELinux。权限初始化只运行一次，重跑脚本不会通过临时容器重复更改正在使用的数据标签。

如果已按旧方式启动过，不要把这条命令当成自动迁移：脚本会拒绝跨配置目录接管或把旧命名卷静默改为空目录。需要先停服备份，并成对迁移 CouchDB 和 gateway 数据，以及原 `.env`；保留网关所有权信息和原密码。不能只迁移 CouchDB。

备份时停止这套服务，完整备份 `/data/lan-note-sync`，保留文件属主和权限。换目录或还原数据前先保留原目录。数据盘应设置开机自动挂载，并在重启后确认挂载正常，再启动应用。

## 可选：交给 1Panel 创建编排

这只是面板管理偏好，不是 SSH 安装的必需步骤。需要面板创建编排时，给快捷安装命令追加 `--prepare-only`，它只生成配置，不启动容器。或者上传包根的 `compose.production.yaml` 和 `deployment/setup-images.sh`（保持相对目录），在 Rocky Linux 终端生成配置：

```bash
bash deployment/setup-images.sh \
  --image-prefix ghcr.io/dalei1563/obsidian-lan-sync \
  --version 0.3.1 \
  --expose-lan \
  --out /opt/lan-note-sync \
  --prepare-only
```

脚本生成 `/opt/lan-note-sync/compose.yaml` 和 `.env`，数据库密码自动随机生成，文件仅当前用户可读写。已有配置不覆盖；更改镜像版本需要编辑原 `.env`。`--public-url` 是可选项，只在希望部署后立即生成邀请时填写。

在 **1Panel → 容器 → 编排 → 创建编排** 中使用生成的文件，确保 `.env` 位于同一部署目录，且编排项目名保持 `lan-note-sync-couch`。不同版本 1Panel 的文件导入/环境变量入口可能不同；以编排最终解析出的环境为准。首次启动拉取两个镜像并自动初始化数据库，无需创建 CouchDB 应用、填写 CORS 或开放 5984 端口。

SSH 创建的编排属于外部编排，1Panel 对其编排级启停能力可能与面板创建的编排不同，但不影响查看和管理容器。[1Panel 编排说明](https://1panel-dev.github.io/docs/v2/user_manual/containers/compose/)。

检查：两个服务显示 healthy。在 sync 容器终端执行：

```text
node dist/server/cli.cjs invite --url http://192.168.1.10:27123
```

将生成的 Windows/macOS 安装命令发给用户即可。

## 反向代理和 Rocky Linux

局域网 HTTP 不需要反向代理。选择 HTTPS 部署时，可把 `.env` 中 `SYNC_LISTEN_ADDRESS` 设为 `127.0.0.1`，由宿主机代理转发。域名配置 HTTPS，并把整个根路径转发给网关，包括 `/v1/` 和安装资源路径，允许至少 5 MiB 请求体及 30 秒处理时间。

**如果 1Panel OpenResty 运行在容器中，代理目标 127.0.0.1 指向 OpenResty 自己。** 应把 sync 和 OpenResty 接入同一个用户定义 Docker 网络，给 sync 设置唯一网络别名（如 `lan-note-sync-gateway`），再代理到 `http://lan-note-sync-gateway:27123`。网络名称需根据服务器实际配置确认，不假定一定叫 `1panel-network`。CouchDB 继续只接入应用内部网络。

未指定 `--data-dir` 时使用命名卷；指定后使用带 `:Z` 标签的绑定目录。默认不要求关闭 SELinux。可信 LAN 直接访问需要明确开放监听，并由管理员在 1Panel/主机防火墙配置相应端口；正式公网使用 HTTPS 入口。

## 后续更新

1. 备份 CouchDB 卷、gateway 卷和 `.env`。
2. 修改 `.env` 中 `SYNC_IMAGE` 为已发布的新版本。
3. 在 1Panel 拉取新镜像并更新/重新创建 sync 容器，保持编排项目名、两个数据卷、密码和地址不变。普通重启容器不会替换镜像。
4. 检查健康状态和已有设备同步。CouchDB 镜像仅在相应数据库升级已验证后单独更新。

终端等价操作（在实际编排目录内）：

```bash
docker compose pull sync
docker compose up -d --no-deps sync
```

不默认跟随 latest，不自动重置凭证、不删除数据卷。旧镜像回退是否可行取决于数据格式兼容性，需要结合备份验证。

后端镜像包含对应的 Obsidian 插件和安装脚本。**更新服务端不会自动更新已安装客户端**；客户端需在关闭 Obsidian 后，用生成的安装命令追加 Windows `-Upgrade` / macOS `--upgrade`，保留连接和同步状态。

## 当前本地检查

- 生产 Compose 已使用 Docker Compose 2.39.4 完成 config 校验，无源码 build。
- 镜像配置生成测试通过：固定版本、自动随机密码、重复执行保留原配置、拒绝 latest。
- 数据盘新增测试覆盖目录布局、空格路径、保留既有配置、拒绝隐式迁移和符号链接、受限权限初始化及正常重跑不重新标记数据目录。实际 SELinux enforcing 仍需在 Rocky Linux 主机验收。
- 本次本地 npm test：36 项通过、8 项按环境跳过（7 项真实 CouchDB 单元集成与 1 项 Linux/macOS 链接检查）。测试验证无地址时直接拉取启动、数据盘绑定、已有配置和密码保留，以及拒绝隐式迁移。
- 真实 WSL ext4 绑定挂载验证通过：受限权限初始化、两个服务 healthy、HTTP 配对/提交、强制重启网关及数据库后原始正文与修订保留。运行使用 host-network 覆盖；默认 bridge 和 Rocky SELinux enforcement 尚未实测。
- GHCR 双架构构建发布、匿名 manifest 获取、Windows/macOS/Linux CI 已验证；未在用户实际 Rocky Linux / 1Panel 主机部署验收。
