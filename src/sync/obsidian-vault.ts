import { App, FileSystemAdapter, FileView, TFile, TFolder } from 'obsidian';
import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { hash, MAX_BYTES, MAX_FILES, NodeKind, pathKey, validatePath } from '../../shared/protocol';
import { ApplyRequest, LocalVault } from './engine';
import { DiskState } from './disk-state';
import { isExcluded } from '../../shared/exclusions';

export class ObsidianVault implements LocalVault {
  applying = false;
  readonly root: string;
  readonly protectedDirectories = new Set<string>();
  constructor(readonly app: App, readonly disk: DiskState) {
    if (!(app.vault.adapter instanceof FileSystemAdapter)) throw new Error('仅支持桌面文件系统笔记库');
    this.root = realpathSync(app.vault.adapter.getBasePath());
  }
  private safe(path: string): void {
    validatePath(path);
    const target = resolve(this.root, path), rel = relative(this.root, target);
    if (!rel || rel.startsWith('..' + sep) || rel === '..' || resolve(this.root, rel) !== target) throw new Error('路径越出笔记库');
    let current = this.root;
    for (const part of path.split('/')) {
      current = join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`不支持符号链接：${path}`);
    }
  }
  kind(path: string): NodeKind {
    this.safe(path);
    return existsSync(join(this.root, path)) && lstatSync(join(this.root, path)).isDirectory() ? 'directory' : 'file';
  }
  async scan(accept?: (path: string) => boolean): Promise<Map<string, Buffer>> {
    this.protectedDirectories.clear();
    const result = new Map<string, Buffer>(), keys = new Set<string>(); let total = 0;
    const protectParents = (path: string) => {
      const parts = path.split('/'); parts.pop();
      while (parts.length) { this.protectedDirectories.add(parts.join('/')); parts.pop(); }
    };
    const walk = async (parent: string): Promise<void> => {
      for (const entry of readdirSync(join(this.root, parent), {withFileTypes: true})) {
        const path = parent ? parent + '/' + entry.name : entry.name;
        if (isExcluded(path, [], this.app.vault.configDir) || (accept && !accept(path))) { protectParents(path); continue; }
        this.safe(path);
        if (keys.has(pathKey(path))) throw new Error(`路径大小写冲突：${path}`);
        keys.add(pathKey(path));
        if (keys.size > MAX_FILES) throw new Error('文件和文件夹合计不能超过 10000 项');
        if (entry.isDirectory()) { result.set(path, Buffer.alloc(0)); await walk(path); }
        else if (entry.isFile()) {
          if (lstatSync(join(this.root, path)).size > MAX_BYTES) throw new Error(`文件超过 5 MiB，覆盖已停止：${path}`);
          const data = await this.read(path);
          if (data === null || this.kind(path) !== 'file') throw new Error(`扫描期间文件发生变化：${path}`);
          total += data.length;
          if (total > 128 * 1024 * 1024) throw new Error('单个笔记库同步内容合计不能超过 128 MiB');
          if (data.length > MAX_BYTES) throw new Error(`文件超过 5 MiB：${path}`);
          result.set(path, data);
        } else throw new Error(`不支持的文件类型：${path}`);
      }
    };
    await walk('');
    for (const path of this.protectedDirectories) result.delete(path);
    return result;
  }
  async read(path: string): Promise<Buffer | null> {
    this.safe(path);
    if (!existsSync(join(this.root, path))) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFolder && this.kind(path) === 'directory') return Buffer.alloc(0);
    if (file instanceof TFile && this.kind(path) === 'file') return Buffer.from(await this.app.vault.readBinary(file));
    throw new Error(`路径已变化或尚未被 Obsidian 识别，请稍后重试：${path}`);
  }
  preserve(data: Buffer): Promise<void> { return this.disk.preserve(data); }
  private ensureClosed(path: string): void {
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof FileView && leaf.view.file && (leaf.view.file.path === path || leaf.view.file.path.startsWith(path + '/'))) {
        throw new Error(`文件正在打开，请关闭后同步：${leaf.view.file.path}`);
      }
    });
  }
  assertClosed(paths: string[]): void { for (const path of paths) this.ensureClosed(path); }
  private async folders(path: string): Promise<void> {
    const parts = path.split('/'); parts.pop(); let current = '';
    for (const part of parts) {
      current = current ? current + '/' + part : part; this.safe(current);
      const item = this.app.vault.getAbstractFileByPath(current);
      if (!item) await this.app.vault.createFolder(current);
      else if (!(item instanceof TFolder)) throw new Error(`父路径被文件占用：${current}`);
    }
  }
  private async remove(path: string, expectedHash: string, expectedKind: NodeKind): Promise<void> {
    this.safe(path); this.ensureClosed(path);
    const current = await this.read(path), item = this.app.vault.getAbstractFileByPath(path);
    if (!current || hash(current) !== expectedHash || this.kind(path) !== expectedKind) throw new Error(`删除前本地发生变化：${path}`);
    if (item instanceof TFolder) {
      // Never recurse: a newly created or excluded child must stop the deletion.
      if (readdirSync(join(this.root, path)).length) throw new Error(`文件夹仍有内容，已停止删除：${path}`);
      // Obsidian 1.15.1 implements adapter.rmdir(false) using fs.rm(false),
      // which rejects directories with EISDIR. Native rmdir only removes an
      // empty directory, including when a child appears after the check above.
      this.safe(path);
      try { rmdirSync(resolve(this.root, path)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') throw new Error(`文件夹出现了新内容，已停止删除，请重新预览：${path}`);
        if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') throw new Error(`文件夹被占用或无删除权限，请关闭相关程序后重试：${path}`);
        throw new Error(`无法删除空文件夹，请重新预览：${path}（${code ?? '未知错误'}）`);
      }
      // Wait for Obsidian's filesystem watcher before reusing the same path.
      for (let i = 0; i < 80 && this.app.vault.getAbstractFileByPath(path); i++) await new Promise(done => setTimeout(done, 25));
      if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`文件夹已删除，等待 Obsidian 刷新后继续：${path}`);
    } else if (item instanceof TFile) await this.app.fileManager.trashFile(item);
    else throw new Error(`路径已变化：${path}`);
  }
  async apply(r: ApplyRequest): Promise<void> {
    this.safe(r.oldPath); this.safe(r.path); this.ensureClosed(r.oldPath); this.ensureClosed(r.path);
    const current = await this.read(r.oldPath), currentKind = this.kind(r.oldPath), kind = r.kind ?? 'file';
    if ((current ? hash(current) : null) !== r.expectedHash || (current && currentKind !== (r.expectedKind ?? 'file'))) throw new Error(`下载期间本地发生变化，请重新预览：${r.oldPath}`);
    const target = r.path === r.oldPath ? current : await this.read(r.path);
    if (r.path !== r.oldPath && target && !(kind === 'directory' && this.kind(r.path) === 'directory')) throw new Error(`移动目标已存在：${r.path}`);
    if (current && currentKind === 'file') await this.preserve(current);
    this.applying = true;
    try {
      if (r.content === null) {
        if (current) await this.remove(r.oldPath, r.expectedHash!, currentKind);
      } else {
        if (current && r.path === r.oldPath && currentKind !== kind) await this.remove(r.oldPath, r.expectedHash!, currentKind);
        await this.folders(r.path); this.safe(r.path); this.ensureClosed(r.path);
        const existing = this.app.vault.getAbstractFileByPath(r.path);
        if (kind === 'directory') {
          if (r.content.length) throw new Error('目录内容无效');
          if (!existing) await this.app.vault.createFolder(r.path);
          else if (!(existing instanceof TFolder)) throw new Error(`目录路径被文件占用：${r.path}`);
        } else if (existing instanceof TFile && r.path === r.oldPath && currentKind === 'file') {
          if (existing.extension.toLowerCase() === 'md' && current && Buffer.from(current.toString('utf8')).equals(current) && Buffer.from(r.content.toString('utf8')).equals(r.content)) {
            await this.app.vault.process(existing, text => {
              this.ensureClosed(r.path);
              if (hash(Buffer.from(text, 'utf8')) !== r.expectedHash) throw new Error('本地内容已变化，停止覆盖');
              return r.content!.toString('utf8');
            });
          } else {
            const latest = Buffer.from(await this.app.vault.readBinary(existing));
            if (hash(latest) !== r.expectedHash) throw new Error('写入前本地内容已变化，停止覆盖');
            this.ensureClosed(r.path);
            await this.app.vault.modifyBinary(existing, Uint8Array.from(r.content).buffer);
          }
        } else {
          if (existing) throw new Error(`目标路径已被占用：${r.path}`);
          await this.app.vault.createBinary(r.path, Uint8Array.from(r.content).buffer);
        }
        if (current && r.path !== r.oldPath) await this.remove(r.oldPath, r.expectedHash!, currentKind);
        const actual = await this.read(r.path);
        if (!actual || hash(actual) !== hash(r.content) || this.kind(r.path) !== kind) {
          await this.preserve(r.content); throw new Error('落盘校验失败，内容已备份，暂停同步');
        }
      }
    } finally { this.applying = false; }
  }
}
