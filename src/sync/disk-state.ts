import { mkdirSync, existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { hash, id, validCursor } from '../../shared/protocol';
import type { SyncState } from './engine';

export class DiskState {
  private failure = false;
  private readonly owner = JSON.stringify({ pid: process.pid, instance: id() });
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
    let current = this.directory;
    while (current !== resolve(current, '..')) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('状态目录不能经过符号链接');
      current = resolve(current, '..');
    }
    mkdirSync(this.directory, { recursive: true });
    mkdirSync(join(this.directory, 'snapshots'), { recursive: true });
    const lock = join(this.directory, 'state.lock');
    if (existsSync(lock)) {
      let pid: number;
      try { pid = JSON.parse(readFileSync(lock, 'utf8')).pid; } catch { throw new Error('状态锁损坏，请保留目录并检查运行中的 Obsidian'); }
      let alive = true;
      try { process.kill(pid, 0); } catch (e: any) { if (e.code === 'ESRCH') alive = false; }
      if (alive || !pid) throw new Error('此 Vault 的同步任务仍在运行，请稍后重试');
      unlinkSync(lock);
    }
    writeFileSync(lock, this.owner, { flag: 'wx', mode: 0o600 });
  }
  load(): SyncState | null {
    const path = join(this.directory, 'state.json');
    if (!existsSync(path)) return null;
    try {
      const s = JSON.parse(readFileSync(path, 'utf8')) as SyncState;
      if (s.schema !== 1 || !s.entries || !s.remote || !Array.isArray(s.pending) || !validCursor(s.cursor)) throw new Error();
      return s;
    } catch { throw new Error('同步状态损坏，已暂停。请保留 local-state 目录，勿删除后直接重绑。'); }
  }
  async save(state: SyncState): Promise<void> {
    if (this.failure) throw new Error('本地状态写入曾失败，需修复磁盘并重新加载插件');
    try { this.atomic(join(this.directory, 'state.json'), Buffer.from(JSON.stringify(state))); }
    catch { this.failure = true; throw new Error('无法持久化同步状态，已停止网络提交；请检查磁盘后重新加载插件'); }
  }
  private atomic(path: string, data: Buffer): void {
    const temp = path + '.' + id() + '.tmp';
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    if (process.platform !== 'win32') { const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
  }
  async preserve(data: Buffer): Promise<void> {
    const target = join(this.directory, 'snapshots', hash(data) + '.md');
    if (!existsSync(target)) this.atomic(target, data);
    else if (hash(readFileSync(target)) !== hash(data)) throw new Error('恢复快照损坏，请检查磁盘');
  }
  close(): void {
    const lock = join(this.directory, 'state.lock');
    if (existsSync(lock) && readFileSync(lock, 'utf8') === this.owner) unlinkSync(lock);
  }
}
