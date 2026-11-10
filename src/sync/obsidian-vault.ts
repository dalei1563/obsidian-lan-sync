import { App, FileSystemAdapter, MarkdownView, TFile } from 'obsidian';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { hash, MAX_BYTES, MAX_FILES, pathKey, validatePath } from '../../shared/protocol';
import { ApplyRequest, LocalVault } from './engine';
import { DiskState } from './disk-state';
import { isExcluded } from '../../shared/exclusions';

export class ObsidianVault implements LocalVault {
  applying = false;
  readonly root: string;
  constructor(readonly app: App, readonly disk: DiskState) {
    if (!(app.vault.adapter instanceof FileSystemAdapter)) throw new Error('首版仅支持桌面文件系统 Vault');
    this.root = realpathSync(app.vault.adapter.getBasePath());
  }
  private safe(path: string): void {
    validatePath(path);
    const target = resolve(this.root, path);
    const rel = relative(this.root, target);
    if (!rel || rel.startsWith('..' + sep) || rel === '..' || resolve(this.root, rel) !== target) throw new Error('路径越出 Vault');
    let current = this.root;
    for (const part of path.split('/')) {
      current = join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`不支持符号链接：${path}`);
    }
  }
  async scan(accept?: (path: string) => boolean): Promise<Map<string, Buffer>> {
    const result = new Map<string, Buffer>(), keys = new Set<string>(); let total = 0;
    const files = this.app.vault.getMarkdownFiles();
    if (files.length > MAX_FILES) throw new Error('首版最多支持 10000 个 Markdown 文件');
    for (const file of files) {
      if (isExcluded(file.path, [], this.app.vault.configDir) || (accept && !accept(file.path))) continue;
      this.safe(file.path);
      if (keys.has(pathKey(file.path))) throw new Error(`文件路径大小写冲突：${file.path}`);
      keys.add(pathKey(file.path));
      if (file.stat.size > MAX_BYTES) throw new Error(`笔记超过 5 MiB：${file.path}`);
      const data = Buffer.from(await this.app.vault.readBinary(file));
      total += data.length;
      if (total > 128 * 1024 * 1024) throw new Error('首版每个 Vault 的 Markdown 正文合计最多 128 MiB');
      if (data.length > MAX_BYTES || !Buffer.from(data.toString('utf8')).equals(data)) throw new Error(`正文超限或不是有效 UTF-8：${file.path}`);
      result.set(file.path, data);
    }
    return result;
  }
  async read(path: string): Promise<Buffer | null> {
    this.safe(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) return Buffer.from(await this.app.vault.readBinary(file));
    if (existsSync(join(this.root, path))) throw new Error(`路径已存在但尚未被 Obsidian 识别：${path}`);
    return null;
  }
  preserve(data: Buffer): Promise<void> { return this.disk.preserve(data); }
  private ensureClosed(path: string): void {
    if (this.app.workspace.getLeavesOfType('markdown').some(l => l.view instanceof MarkdownView && l.view.file?.path === path)) {
      throw new Error(`笔记正在编辑器中打开，请关闭后同步：${path}`);
    }
  }
  assertClosed(paths: string[]): void { for (const path of paths) this.ensureClosed(path); }
  private async folders(path: string): Promise<void> {
    const parts = path.split('/'); parts.pop(); let current = '';
    for (const part of parts) {
      current = current ? current + '/' + part : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }
  async apply(r: ApplyRequest): Promise<void> {
    this.safe(r.oldPath); this.safe(r.path); this.ensureClosed(r.oldPath); this.ensureClosed(r.path);
    const current = await this.read(r.oldPath);
    if ((current ? hash(current) : null) !== r.expectedHash) throw new Error(`下载期间本地发生变化，请查看版本：${r.oldPath}`);
    if (r.path !== r.oldPath && await this.read(r.path)) throw new Error(`移动目标已存在：${r.path}`);
    if (current) await this.preserve(current);
    if (r.content && !Buffer.from(r.content.toString('utf8')).equals(r.content)) throw new Error('远端内容不是有效 UTF-8');
    this.applying = true;
    try {
      if (r.content === null) {
        const file = this.app.vault.getAbstractFileByPath(r.oldPath);
        if (file instanceof TFile) {
          this.ensureClosed(r.oldPath);
          if (hash(Buffer.from(await this.app.vault.readBinary(file))) !== r.expectedHash) throw new Error('删除前本地文件发生变化');
          await this.app.fileManager.trashFile(file);
        }
      } else if (current && r.path === r.oldPath) {
        const file = this.app.vault.getAbstractFileByPath(r.path);
        if (!(file instanceof TFile)) throw new Error('本地文件不再存在');
        this.ensureClosed(r.path);
        await this.app.vault.process(file, text => {
          this.ensureClosed(r.path);
          if (hash(Buffer.from(text, 'utf8')) !== r.expectedHash) throw new Error('本地内容或 BOM/换行语义不同，停止自动覆盖');
          return r.content!.toString('utf8');
        });
      } else {
        await this.folders(r.path); this.safe(r.path); this.ensureClosed(r.path);
        await this.app.vault.createBinary(r.path, Uint8Array.from(r.content).buffer);
        if (current && r.path !== r.oldPath) {
          const old = this.app.vault.getAbstractFileByPath(r.oldPath); this.ensureClosed(r.oldPath);
          if (!(old instanceof TFile) || hash(Buffer.from(await this.app.vault.readBinary(old))) !== r.expectedHash) throw new Error('移动中原文件变化，已保留双方');
          await this.app.fileManager.trashFile(old);
        }
      }
      const actual = await this.read(r.path);
      if (r.content !== null && (!actual || hash(actual) !== hash(r.content))) {
        await this.preserve(r.content); throw new Error('落盘字节校验失败，双方内容已保留，暂停此文件');
      }
    } finally { this.applying = false; }
  }
}
