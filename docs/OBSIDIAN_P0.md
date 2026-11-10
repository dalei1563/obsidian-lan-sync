# Obsidian 本地文件 API P0 核验

状态：**文档调查完成；Windows/macOS 实机字节和竞争测试未完成。** 不能据此启用同步或认定 P0 已通过。

## 文档依据

- [Vault 指南](https://docs.obsidian.md/Plugins/Vault) 说明 `Vault.process()` 在同步回调内对读取及写入提供保护。需要异步处理时，应先读取，再在 `process` 回调内比较当前内容，变化时放弃修改。
- [Vault API](https://docs.obsidian.md/Reference/TypeScript%2BAPI/App/vault) 列出 `readBinary`、`createBinary` 和 `modifyBinary`，但未为二进制读写提供同等的条件写入保证；先 `readBinary`、再 `modifyBinary` 之间仍可能发生竞争。
- 文档未承诺文本 API 能在所有平台上原样保留 UTF-8 BOM 与 CRLF。不能仅凭 API 名称认定满足逐字节往返。
- 回收使用 `FileManager.trashFile` 或 `Vault.trash`，不要用永久删除；重命名优先使用 `FileManager.renameFile` 并测试双链更新。

## 真机测试方案

仅在新建、无用户资料的测试 Vault 中执行。记录 Obsidian 和系统版本。Windows 与 macOS 分别执行：

1. 用独立脚本生成包含 UTF-8 BOM、CRLF、中文、YAML、双链、标签及代码块的 `.md`，另生成无 BOM、LF 和零字节样本；记录磁盘 SHA-256 和文件长度。
2. 在桌面插件上下文使用 `readBinary` 读取，比较字节和哈希。测试 `Vault.read` → 原样 `Vault.process` 和 `Vault.create` 往返后，再从磁盘独立读取并比较。分别覆盖新建和已有文件；不使用文本视图显示结果来代替字节比较。
3. 模拟下载间隙修改：先读取笔记，再在 `process` 前通过另一独立写入修改；回调比较失败时中止，确认原修改仍保留且产生冲突项。还需测试下载期间编辑器未落盘的修改，以及另一个进程竞争写入，记录实际行为和限制。
4. 检查插件自己的 `create` / `modify` / `rename` 事件及重启后的回声抑制。验证 `renameFile` 对双链的影响和 `trashFile` 的恢复行为。
5. 如文本 API 无法逐字节保留，或 `process` 对必须支持的竞争场景无法保证安全，停止覆盖实现；提出可验证的原始字节保护设计，而不是使用无条件 `modifyBinary`。

当前机器发现 Obsidian CLI，但没有正在运行的 Obsidian 实例；因此未在桌面进程中执行以上步骤。
