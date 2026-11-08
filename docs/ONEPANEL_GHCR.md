# Rocky Linux / 1Panel：使用 GHCR 镜像部署

## 发布状态

2026-11-08：**两个 0.3.0 镜像已发布，匿名拉取验证通过**，均包含 linux/amd64 和 linux/arm64。源码仓库为 [dalei1563/obsidian-lan-sync](https://github.com/dalei1563/obsidian-lan-sync)。

```text
ghcr.io/dalei1563/obsidian-lan-sync:0.3.0
ghcr.io/dalei1563/obsidian-lan-sync-couchdb:0.3.0
```

发布记录：[GHCR 构建](https://github.com/dalei1563/obsidian-lan-sync/actions/runs/42461228885)；[Windows、macOS 与真实 CouchDB CI](https://github.com/dalei1563/obsidian-lan-sync/actions/runs/42461315953) 均成功。macOS CI 通过不等同于 macOS Obsidian GUI 实机验收。

## 镜像和更新约定

主分支修改 package.json 版本号并提交，或发布匹配版本的 Git 标签，可触发 `.github/workflows/publish-images.yml`；也可在 Actions 手动运行。工作流先构建并运行真实 CouchDB 回归测试，然后发布：

```text
ghcr.io/dalei1563/obsidian-lan-sync:0.3.0
ghcr.io/dalei1563/obsidian-lan-sync-couchdb:0.3.0
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

## 可选：交给 1Panel 创建编排

这只是面板管理偏好，不是 SSH 安装的必需步骤。需要面板创建编排时，给快捷安装命令追加 `--prepare-only`，它只生成配置，不启动容器。或者上传包根的 `compose.production.yaml` 和 `deployment/setup-images.sh`（保持相对目录），在 Rocky Linux 终端生成配置：

```bash
bash deployment/setup-images.sh \
  --image-prefix ghcr.io/dalei1563/obsidian-lan-sync \
  --version 0.3.0 \
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

本版使用 Docker 命名卷，避免依赖 Rocky Linux 宿主目录的 SELinux 标签。默认不要求关闭 SELinux。可信 LAN 直接访问需要明确开放监听，并由管理员在 1Panel/主机防火墙配置相应端口；正式公网使用 HTTPS 入口。

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
- 本次 npm test：30 项通过、7 项真实 CouchDB 测试未启动。新增测试验证无地址时直接执行拉取和启动，并将邀请生成延后；已有配置和密码保留。
- GHCR 双架构构建发布、匿名 manifest 获取、Windows/macOS/Linux CI 已验证；未在用户实际 Rocky Linux / 1Panel 主机部署验收。
