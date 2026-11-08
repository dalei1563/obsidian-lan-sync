# LAN Note Sync 0.3 验证记录

日期：2026-11-08（北京时间）。结论：独立 CouchDB 版已形成可部署试用包；未宣称完成跨平台生产验收。

补充：GHCR 0.3.0 双架构镜像已发布，匿名拉取 manifest 验证通过。[发布工作流](https://github.com/dalei1563/obsidian-lan-sync/actions/runs/42461228885) 与 [Windows/macOS/真实 CouchDB CI](https://github.com/dalei1563/obsidian-lan-sync/actions/runs/42461315953) 均通过。新增镜像部署配置测试后，共有 36 项测试；各平台按依赖跳过不可运行项。Mac 原生安装脚本路径已在 CI 执行，Obsidian GUI 和用户 Rocky Linux/1Panel 尚未验收。下文为最初本地验收记录。

## 环境

- Windows、Node.js 24.15.0、Obsidian 1.12.7，插件 0.3.0，协议版本 2。
- 真实 apache/couchdb:3.5.3，WSL Ubuntu 中隔离 Docker 28.3.3 守护进程。
- Compose 2.39.4；生产网关基于 node:24.15.0-bookworm-slim，生产数据库镜像加入项目配置并以 couchdb 用户运行。
- 测试库、网关目录、Obsidian 配置和笔记库均隔离在 `.test-runtime`；未使用用户正式笔记库。

## 自动化

`npm run build` 通过。`npm run test:couch`：**35 项通过，0 失败，0 跳过**。

覆盖范围：

- 连接码格式、端点约束、安装引导信息 BOM、认领请求跨重启保持一致。
- 真实 CouchDB 的邀请幂等认领、拒绝其他认领、设备撤销、Vault 隔离。
- 双设备原始字节往返：中文、BOM、CRLF、空正文，游标为字符串。
- 并发编辑保留双方、解决冲突响应丢失后恢复、服务重启后重新核对。
- 真实 CouchDB compaction 后业务历史保留；导出校验正文和修订引用。
- 拒绝另一套网关数据目录复用数据库；多页增量与历史、修订去重、父版本与路径校验。
- 重复 CLI 邀请重用默认远端库，并生成 Windows/macOS 安装命令。
- 本地原子状态、锁、离线队列、写入中断日志、下载期间本地编辑保护、双向批量删除确认、改名与冲突恢复。
- Windows PowerShell 和 Bash 安装脚本在中文/空格目录实际执行，保留笔记和其他插件，拒绝隐式覆盖，损坏下载不形成正式安装。
- Windows 自动发现唯一登记笔记库，且不修改 Obsidian 全局登记文件。
- 旧 SQLite 后端的协议、历史及备份恢复回归仍保留。这不代表 CouchDB JSONL 已提供恢复导入器。

测试发现 Windows PowerShell 5 默认读取无 BOM UTF-8 登记文件会误解中文路径，已改为显式 UTF-8 并回归通过。

## 真实 Docker 集成

两个生产 Dockerfile 都已从源码实际构建。使用生产 Compose 配置和 host-network 测试覆盖启动，健康检查通过。因隔离守护进程禁用 bridge/iptables，测试覆盖仅改变网络模式及内部地址，不代表默认 bridge 网络已实测。

在运行的网关上实际完成：

1. 连续生成邀请，确认指向同一个默认远端库。
2. HTTP 认领设备、保存原始正文并提交业务修订。
3. 对网关容器发送 SIGKILL，再启动同一个容器。
4. 验证原设备仍可访问、serverId 保持、epoch 更新、正文 SHA-256 与提交前相同、修订仍存在。
5. 检查安装清单和三个下载文件的大小/哈希。
6. 执行网关实际输出的 Windows 一行命令，自动发现测试库并安装最终构建；实际输出的 Bash 命令追加显式测试路径后执行成功。两者均留下正确协议的 bootstrap，原笔记未变化。

以上在最终代码构建镜像上再次通过。修复了容器重启时 PID 1 被复用造成旧锁误判的问题，Linux 锁增加进程启动标识；这仍不构成跨容器共享卷的分布式锁。

## Windows Obsidian 实机

独立笔记库 `LAN Couch Test`：

- 安装生成的插件，启用后自动读取 bootstrap、配对并展示首次同步预览。
- 本地和远端各一篇笔记的合并同步成功；远端修改可下载到本地，正文哈希一致。
- 最终协议 2 构建重新加载后，连接诊断通过，状态为“已同步”，游标为字符串，引导文件已移除。
- 普通插件配置不含永久令牌；使用 Obsidian 密钥存储。
- `dev:errors` 与调试控制台无错误。
- 预览和最终设置截图已实际检查，界面无需填写 CouchDB 参数。

截图：[首次预览](screenshots/v0.3-enrollment-preview.png)、[最终设置](screenshots/v0.3-settings.png)。

## 尚未验收和限制

- 没有 Mac 实机；Bash 脚本核心路径在 Git Bash 验证，原生 osascript 选库与 macOS Obsidian 待验收。
- Windows/macOS CI 已执行通过，记录见顶部补充。
- 默认 Docker bridge、实际跨机 HTTPS、NAS 文件权限、持续运行、万人规模/大型历史库未验收。
- 仅 Markdown，不含图片/PDF 附件、移动端、E2EE、自动升级或多副本网关。
- JSONL 文档导出经过引用与哈希校验；没有自动恢复导入命令。灾备须完整备份两卷与配置。
- SQLite 到 CouchDB 的历史和绑定没有自动迁移。

这些限制不影响本机试用，但不能把当前结果表述为“所有平台长期稳定”或“零前置条件的一键部署”。
