# LAN Note Sync 加固基线

日期：2026-11-10；分支：`chore/lan-hardening`；基线提交：`c330206`。

路线：仅继续 LAN Note Sync；飞书云盘及多维表格方案已废弃。路线及原文档的正式标注将在文档阶段处理。

## 本机检查

- Windows，Node.js 24.15.0；PowerShell 的执行策略阻止直接调用 `npm.ps1`，因此使用 `npm.cmd`。
- `npm.cmd test`：111 项，97 通过、2 失败、12 跳过、0 取消。退出码 1。
- 失败：`Windows installer discovers one registered Vault without requiring a path or changing the registry` 和 `powershell installer preserves notes and existing connection during install and update`。两项均显示系统执行策略阻止运行 `deployment/install.ps1`；尚未判定是否存在其他问题。
- 跳过：8 项真实 CouchDB、3 项 CouchDB 管理测试，以及 1 项符号链接目录测试。默认测试未配置真实 CouchDB；其余环境条件以测试代码为准。
- `npm.cmd run build`：成功，退出码 0；输出 `Built server and installable plugin: dist/`，没有报告 warning。

## 工作区已有文档

开始前 `docs/OBSIDIAN_P0.md`、`docs/SYNC_OPTIONS_RESEARCH.md`、`docs/TEST_REPORT.md` 是未跟踪文件。保留原样，不删除，也不在本阶段提交；后续处理前应确认归属和用途。

## 下一步

检查 Windows 安装器测试与执行策略的交互，在不改变机器级策略的前提下修复或明确环境限制，再重新运行完整测试和构建。
