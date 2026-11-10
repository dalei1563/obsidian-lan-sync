# LAN Note Sync 加固基线

日期：2026-11-10；分支：`chore/lan-hardening`；基线提交：`c330206`。

路线：仅继续 LAN Note Sync；飞书云盘及多维表格方案已废弃。本工作区原 SPEC 已标注为历史归档；该文件原本被 Git 忽略且未跟踪，未强制加入仓库。

## 本机检查

- Windows，Node.js 24.15.0；PowerShell 的执行策略阻止直接调用 `npm.ps1`，因此使用 `npm.cmd`。
- `npm.cmd test`：111 项，97 通过、2 失败、12 跳过、0 取消。退出码 1。
- 失败：`Windows installer discovers one registered Vault without requiring a path or changing the registry` 和 `powershell installer preserves notes and existing connection during install and update`。两项均显示系统执行策略阻止运行 `deployment/install.ps1`；尚未判定是否存在其他问题。
- 跳过：8 项真实 CouchDB、3 项 CouchDB 管理测试，以及 1 项符号链接目录测试。默认测试未配置真实 CouchDB；其余环境条件以测试代码为准。
- `npm.cmd run build`：成功，退出码 0；输出 `Built server and installable plugin: dist/`，没有报告 warning。

## 工作区已有文档

开始前 `docs/OBSIDIAN_P0.md`、`docs/SYNC_OPTIONS_RESEARCH.md`、`docs/TEST_REPORT.md` 是未跟踪文件。保留原样，不删除，也不在本阶段提交；后续处理前应确认归属和用途。

## 阶段 1 结果

- 安装器测试在每次启动 PowerShell 时显式传入 `-ExecutionPolicy Bypass`，只影响子进程，未修改机器策略。损坏下载的反向测试还要求输出中包含完整性校验失败，避免执行策略阻止脚本导致误报通过。
- 单独运行两个原失败用例：2 通过、0 失败、0 跳过。
- `npm.cmd test`：111 项，99 通过、0 失败、12 跳过；`npm.cmd run build` 成功且未报告 warning。
- `docker version`：找不到 Docker 命令，默认 Docker Desktop CLI 路径也不存在，因此未创建容器、未运行真实 CouchDB 测试。本机 WSL 状态查询返回访问被拒绝，不能证明其内部是否安装 Docker。
- 11 项 CouchDB 测试因未提供 `COUCH_TEST_CONFIG` 而跳过。它们会创建并删除随机的 `lnstest_...` 数据库，必须仅连接专用测试实例，不使用生产凭据。
- 阶段 1 时符号链接测试对所有 Windows 无条件跳过；阶段 2 已改为先尝试创建链接，见下方最终结果。

## 阶段 2 最终结果

- Windows 本机 `npm.cmd test`：**129 项，117 通过、0 失败、12 跳过、0 取消**。11 项因未连接真实 CouchDB 而跳过；1 项符号链接测试实际尝试创建时返回 `EPERM` 而跳过。
- `npm.cmd run build`：成功，退出码 0，未报告 warning。
- 本加固分支的 **CouchDB 行为未在真实 CouchDB 上验证**。Linux 测试机 `huoying-ubuntu` 可通过 SSH 访问，但当次环境检查中 Node/npm 不在 PATH，账号无法直接访问 Docker socket，因此没有运行真实数据库测试，也没有创建测试容器。不得把历史版本 CI 结果当作当前分支结果。
- 测试范围与生产前待办见 [LAN 同步可靠性检查](LAN_HARDENING_RELIABILITY.md) 和 [发布前验收清单](RELEASE_CHECKLIST.md)。

### 在隔离 Linux Docker 环境验证 CouchDB

使用 Node.js 24.15.0、已安装项目依赖、可用 Docker daemon 的 Linux 测试机；确认本机 15984 端口空闲且能获取 `apache/couchdb:3.5.3` 镜像。下面的容器名和配置路径随机生成，仅监听回环地址；容器使用匿名卷，`--rm` 会在容器停止时清理匿名卷。密码只用于临时测试。以下步骤尚未在本机执行：

```bash
set -eu
test_dir=$(mktemp -d)
container_id=''
cleanup() {
  if [ -n "$container_id" ]; then docker stop "$container_id" >/dev/null; fi
  rm -f "$test_dir/couch-test.json"
  rmdir "$test_dir"
}
trap cleanup EXIT
container_id=$(docker run -d --rm --name "lan-couch-test-$(basename "$test_dir")" \
  -p 127.0.0.1:15984:5984 -e COUCHDB_USER=ci_test_admin \
  -e COUCHDB_PASSWORD=ci-only-ephemeral-test-password \
  -v /opt/couchdb/data apache/couchdb:3.5.3)
for attempt in $(seq 1 30); do
  if curl -fsS -u ci_test_admin:ci-only-ephemeral-test-password http://127.0.0.1:15984/_up >/dev/null; then break; fi
  sleep 2
done
curl -fsS -u ci_test_admin:ci-only-ephemeral-test-password http://127.0.0.1:15984/_up >/dev/null
printf '%s\n' '{"url":"http://127.0.0.1:15984","user":"ci_test_admin","password":"ci-only-ephemeral-test-password"}' > "$test_dir/couch-test.json"
COUCH_TEST_CONFIG="$test_dir/couch-test.json" npm run test:couch
```

核对测试汇总和 11 项 CouchDB 用例实际结果；如端口被占用，换一个未使用的端口并同时更新 URL。清理只针对该次创建的容器及临时配置。
