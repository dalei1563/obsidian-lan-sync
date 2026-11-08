# Rocky Linux / 1Panel：使用 GHCR 镜像部署

## 发布状态

项目已提供版本化镜像发布工作流和纯拉取的 Compose；**当前尚未发布到 GHCR**。下面的账号/仓库是示例，须替换成最终发布地址，并确认两个镜像均发布成功后部署。

## 镜像和更新约定

发布 Git 标签 `v0.3.0` 后，`.github/workflows/publish-images.yml` 先构建并运行真实 CouchDB 回归测试，然后发布：

```text
ghcr.io/账号/仓库:0.3.0
ghcr.io/账号/仓库-couchdb:0.3.0
```

工作流目标平台为 linux/amd64 和 linux/arm64；实际构建成功后才视为已支持。Tag、package.json 与插件 manifest.json 版本必须一致。使用 GitHub Actions 的 GITHUB_TOKEN，权限限定为发布作业的 packages:write；不在仓库或镜像中写入个人 Token。首次发布后检查两个 Package 的可见性，设为 Public 才能让服务器匿名拉取；公开源码仓库不等于镜像自动公开。

GitHub 官方说明：[发布镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)、[GHCR 可见性和认证](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

## 1Panel 部署

使用 `compose.production.yaml`，其中只有 image，没有 build。生产服务器不需要 Node、npm 或源码编译。

可先上传包根的 `compose.production.yaml` 和 `deployment/setup-images.sh`（保持相对目录），在 Rocky Linux 终端生成配置：

```bash
bash deployment/setup-images.sh \
  --image-prefix ghcr.io/账号/仓库 \
  --version 0.3.0 \
  --public-url https://notes.example.com \
  --out /opt/lan-note-sync \
  --prepare-only
```

脚本生成 `/opt/lan-note-sync/compose.yaml` 和 `.env`，数据库密码自动随机生成，文件仅当前用户可读写。已有配置不覆盖；更改镜像版本需要编辑原 `.env`。仅需临时内网 HTTP 时可改 PublicUrl 并加 `--expose-lan`。

在 **1Panel → 容器 → 编排 → 创建编排** 中使用生成的文件，确保 `.env` 位于同一部署目录，且编排项目名保持 `lan-note-sync-couch`。不同版本 1Panel 的文件导入/环境变量入口可能不同；以编排最终解析出的环境为准。首次启动拉取两个镜像并自动初始化数据库，无需创建 CouchDB 应用、填写 CORS 或开放 5984 端口。

如果直接用终端部署，去掉 `--prepare-only`，脚本会执行 pull、up 和生成邀请；这属于外部创建的编排，1Panel 对其编排级启停能力可能与面板创建的编排不同。[1Panel 编排说明](https://1panel-dev.github.io/docs/v2/user_manual/containers/compose/)。

检查：两个服务显示 healthy。在 sync 容器终端执行：

```text
node dist/server/cli.cjs invite
```

将生成的 Windows/macOS 安装命令发给用户即可。

## 反向代理和 Rocky Linux

默认网关只发布到宿主机 `127.0.0.1:27123`，适合宿主机进程代理。域名配置 HTTPS，并把整个根路径转发给网关，包括 `/v1/` 和安装资源路径，允许至少 5 MiB 请求体及 30 秒处理时间。

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
- 本次 npm test：29 项通过、7 项真实 CouchDB 测试未启动（此前 CouchDB 版本的 35 项完整测试已通过）。
- 未在实际 Rocky Linux / 1Panel 或 GHCR 远端发布环境验收。
