import { assertHash, assertId, Cursor, FileState, hash, id, MAX_BYTES, pathKey, Revision, Snapshot, SyncError, validatePath, validateRevision } from '../../shared/protocol';
import { Remote } from './remote';
import { isExcluded, normalizeExclusions } from '../../shared/exclusions';
import { planOverwrite, type OverwriteMode, type OverwritePlan } from './overwrite-plan';

export interface ApplyRequest { oldPath: string; path: string; expectedHash: string | null; content: Buffer | null }
export interface LocalVault {
  scan(accept?: (path: string) => boolean): Promise<Map<string, Buffer>>;
  read(path: string): Promise<Buffer | null>;
  apply(request: ApplyRequest): Promise<void>;
  preserve(data: Buffer): Promise<void>;
  assertClosed?(paths: string[]): void | Promise<void>;
}
export interface Entry {
  fileId: string;
  path: string;
  basePath: string;
  baseRevision: string | null;
  baseHash: string | null;
  baseDeleted: boolean;
  materialized: boolean;
  blocked?: string;
}
export interface Pending { revision: Revision; content: string | null; applyAfter?: boolean }
export interface SyncState {
  schema: 1;
  serverId: string;
  vaultId: string;
  clientId: string;
  initialized: boolean;
  epoch: string;
  cursor: Cursor;
  remote: Record<string, FileState>;
  entries: Record<string, Entry>;
  pending: Pending[];
  issues: Record<string, string>;
  deletePlan?: { fingerprint: string; paths: string[]; direction: 'local' | 'remote' };
  deleteApproval?: string;
  applying?: { fileId: string; revision: Revision };
  serverExcludedPaths?: string[];
  overwrite?: { plan: OverwritePlan; epoch: string; cursor: Cursor; index: number; operationIds: string[]; fileIds: string[] };
}
export function newState(serverId: string, vaultId: string, clientId: string): SyncState {
  return { schema: 1, serverId, vaultId, clientId, initialized: false, epoch: '', cursor: 0, remote: {}, entries: {}, pending: [], issues: {} };
}
export interface Preview { upload: number; download: number; same: number; conflicts: number; local: number; remote: number }
export interface EngineOptions { excludedPaths?: () => readonly string[]; configDir?: string }
export class Engine {
  private tail: Promise<unknown> = Promise.resolve();
  private running?: Promise<void>;
  private stopped = false;
  constructor(readonly remote: Remote, readonly local: LocalVault, readonly state: SyncState,
    readonly save: (state: SyncState) => Promise<void>, readonly report: (message: string) => void = () => {}, readonly options: EngineOptions = {}) {
    if (state.schema !== 1 || state.vaultId !== remote.vaultId) throw new Error('本地同步状态不匹配，已停止');
    if (state.serverExcludedPaths !== undefined) state.serverExcludedPaths = normalizeExclusions(state.serverExcludedPaths);
  }
  isExcluded(path: string): boolean { return isExcluded(path, [...(this.state.serverExcludedPaths ?? []), ...normalizeExclusions([...(this.options.excludedPaths?.() ?? [])])], this.options.configDir); }
  private policy(rules?: string[]): void {
    // Older gateways omit this field. Keep the last durable policy on downgrade;
    // an explicit empty array is the only way to remove an existing policy.
    if (rules !== undefined || this.state.serverExcludedPaths === undefined) this.state.serverExcludedPaths = normalizeExclusions(rules ?? []);
  }
  private async scan(): Promise<Map<string, Buffer>> {
    const files = await this.local.scan(path => !this.isExcluded(path));
    return new Map([...files].filter(([path]) => !this.isExcluded(path)));
  }
  async previewOverwrite(mode: OverwriteMode): Promise<OverwritePlan> {
    if (this.state.pending.length || Object.keys(this.state.issues).length) throw new Error('请先处理待上传内容和冲突，再执行覆盖');
    if (this.state.overwrite && this.state.overwrite.plan.mode !== mode) throw new Error('已有未完成的覆盖，请先完成原来的方向');
    const snapshot = await this.remote.snapshot(); this.checkIdentity(snapshot); this.policy(snapshot.excludedPaths);
    return planOverwrite(mode, await this.scan(), snapshot, path => this.isExcluded(path));
  }
  startOverwrite(plan: OverwritePlan): Promise<void> {
    return this.exclusive(async () => {
      if (this.stopped) throw new Error('同步已停止，请重新打开插件');
      const snapshot = await this.remote.snapshot(); this.checkIdentity(snapshot); this.policy(snapshot.excludedPaths);
      if (this.state.pending.length || Object.keys(this.state.issues).length) throw new Error('请先处理待上传内容和冲突，再执行覆盖');
      if (this.state.overwrite && this.state.overwrite.plan.mode !== plan.mode) throw new Error('已有未完成的覆盖，请先完成原来的方向');
      const fresh = planOverwrite(plan.mode, await this.scan(), snapshot, path => this.isExcluded(path));
      if (fresh.fingerprint !== plan.fingerprint) throw new Error('预览后笔记或云端发生变化，请重新预览');
      await this.local.assertClosed?.(fresh.actions.map(a => a.path));
      this.state.overwrite = { plan: fresh, epoch: snapshot.epoch, cursor: snapshot.cursor, index: 0,
        operationIds: fresh.actions.map(() => id()), fileIds: fresh.actions.map(a => a.remote?.fileId ?? id()) };
      await this.save(this.state);
      await this.runOverwrite();
    });
  }
  resumeOverwrite(): Promise<void> { return this.exclusive(() => this.runOverwrite()); }
  private async runOverwrite(): Promise<void> {
    const job = this.state.overwrite;
    if (!job || !Array.isArray(job.plan?.actions) || !Array.isArray(job.operationIds) || !Array.isArray(job.fileIds) || !Number.isInteger(job.index) || job.index < 0 || job.index > job.plan.actions.length || job.operationIds.length !== job.plan.actions.length || job.fileIds.length !== job.plan.actions.length) throw new Error('覆盖任务无效，请保留本地状态并联系管理员');
    if (!['cloud-to-local', 'local-to-cloud'].includes(job.plan.mode)) throw new Error('覆盖任务方向无效');
    for (let i = 0; i < job.plan.actions.length; i++) {
      const a = job.plan.actions[i]; validatePath(a.path); assertId(job.operationIds[i]); assertId(job.fileIds[i]);
      if (a.localHash !== null) assertHash(a.localHash);
      if (a.remote !== null) { const remote = validateRevision(a.remote); if (remote.deleted || remote.path !== a.path || remote.fileId !== job.fileIds[i]) throw new Error('覆盖任务远端版本无效'); }
      if (job.plan.mode === 'cloud-to-local' && !((a.type === 'delete-local' && a.localHash !== null && !a.remote) || (a.type === 'download' && !!a.remote))) throw new Error('覆盖任务操作无效');
      if (job.plan.mode === 'local-to-cloud' && !((a.type === 'delete-cloud' && a.localHash === null && !!a.remote) || (a.type === 'upload' && a.localHash !== null))) throw new Error('覆盖任务操作无效');
    }
    for (; job.index < job.plan.actions.length;) {
      if (this.stopped) throw new Error('覆盖已暂停，请重新打开插件继续');
      const action = job.plan.actions[job.index];
      if (this.isExcluded(action.path)) throw new Error('排除规则已变化，请重新预览覆盖');
      await this.local.assertClosed?.([action.path]);
      const local = await this.local.read(action.path), currentHash = local === null ? null : hash(local);
      if (job.plan.mode === 'cloud-to-local') {
        const remote = await this.remote.snapshot(); this.checkIdentity(remote); this.policy(remote.excludedPaths);
        if (remote.epoch !== job.epoch || remote.cursor !== job.cursor || this.isExcluded(action.path)) throw new Error('云端已发生变化，请重新预览覆盖');
        const targetHash = action.type === 'delete-local' ? null : action.remote?.hash ?? null;
        if (currentHash !== targetHash) {
          if (currentHash !== action.localHash) throw new Error(`本地笔记已发生变化，请重新预览：${action.path}`);
          const content = action.type === 'delete-local' ? null : await this.remote.get(action.remote!.hash!);
          await this.local.apply({oldPath: action.path, path: action.path, expectedHash: action.localHash, content});
        }
      } else {
        if (currentHash !== action.localHash) throw new Error(`本地笔记已发生变化，请重新预览：${action.path}`);
        const deleted = action.type === 'delete-cloud', parents = action.remote ? [action.remote.id] : [];
        const revision: Revision = {id: job.operationIds[job.index], fileId: job.fileIds[job.index], parents,
          path: action.path, deleted, hash: deleted ? null : currentHash, size: deleted ? 0 : local!.length, clientId: this.state.clientId};
        if (!deleted) await this.remote.put(local!, currentHash!);
        await this.remote.commitStrict(revision, parents);
      }
      job.index++; await this.save(this.state);
      this.report(`正在覆盖 ${job.index}/${job.plan.actions.length}`);
    }
    const final = await this.remote.snapshot(); this.checkIdentity(final); this.policy(final.excludedPaths);
    const files = await this.scan(), remaining = planOverwrite(job.plan.mode, files, final, path => this.isExcluded(path));
    if (remaining.actions.length) throw new Error('覆盖期间两端发生变化，请重新预览并继续');
    const entries: Record<string, Entry> = Object.fromEntries(Object.entries(this.state.entries).filter(([, e]) => this.isExcluded(e.path)));
    const live = new Map(final.files.flatMap(f => f.heads.length === 1 && !f.heads[0].deleted ? [[pathKey(f.heads[0].path), f.heads[0]] as const] : []));
    for (const [path, bytes] of files) {
      const head = live.get(pathKey(path)); if (!head || head.path !== path || head.hash !== hash(bytes)) throw new Error(`两端尚未一致，请重新预览：${path}`);
      entries[head.fileId] = {fileId: head.fileId, path, basePath: path, baseRevision: head.id, baseHash: head.hash, baseDeleted: false, materialized: true};
    }
    this.state.entries = entries; this.state.remote = Object.fromEntries(final.files.map(f => [f.fileId, f]));
    this.state.epoch = final.epoch; this.state.cursor = final.cursor; this.state.initialized = true; delete this.state.overwrite;
    this.state.issues = {}; await this.save(this.state); this.report('覆盖完成，已同步');
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {}); return result;
  }
  stop(): Promise<unknown> { this.stopped = true; return this.tail; }
  private checkIdentity(s: { serverId: string }) { if (s.serverId !== this.state.serverId) throw new Error('服务端身份已变化，请检查地址或备份恢复情况'); }
  private async snapshot(): Promise<void> {
    const s = await this.remote.snapshot(); this.checkIdentity(s);
    this.policy(s.excludedPaths);
    const bases = Object.values(this.state.entries).filter(e => !!e.baseRevision);
    const known = await this.remote.known([...new Set(bases.map(e => e.baseRevision!))]);
    for (const entry of bases) if (!known.has(entry.baseRevision!)) {
      entry.blocked = '服务器缺少本地已确认的历史版本（可能恢复了旧备份），请选择版本或恢复完整服务端备份';
    }
    this.state.remote = Object.fromEntries(s.files.map(f => [f.fileId, f]));
    this.state.cursor = s.cursor; this.state.epoch = s.epoch;
    await this.save(this.state);
  }
  async preview(): Promise<Preview> {
    const snapshot = await this.remote.snapshot(); this.checkIdentity(snapshot);
    this.policy(snapshot.excludedPaths);
    const files = await this.scan(), remoteFiles = snapshot.files.filter(file => !file.heads.some(head => this.isExcluded(head.path)));
    const result = { upload: 0, download: 0, same: 0, conflicts: 0, local: files.size, remote: remoteFiles.length };
    const matched = new Set<string>();
    for (const file of remoteFiles) {
      if (file.heads.length !== 1) { result.conflicts++; file.heads.forEach(h => matched.add(pathKey(h.path))); continue; }
      const head = file.heads[0], data = [...files].find(([p]) => pathKey(p) === pathKey(head.path));
      if (data) { matched.add(pathKey(data[0])); if (!head.deleted && data[0] === head.path && hash(data[1]) === head.hash) result.same++; else result.conflicts++; }
      else if (!head.deleted) result.download++;
    }
    for (const path of files.keys()) if (!matched.has(pathKey(path))) result.upload++;
    return result;
  }
  initialize(): Promise<void> {
    return this.exclusive(async () => {
      if (this.state.initialized) return;
      await this.snapshot();
      const files = await this.scan();
      for (const [path, data] of files) this.bindUntracked(path, data);
      this.state.initialized = true;
      await this.save(this.state);
    });
  }
  private bindUntracked(path: string, data: Buffer): void {
    const matches = Object.values(this.state.remote).filter(f => f.heads.some(h => pathKey(h.path) === pathKey(path)));
    if (matches.length > 1) throw new Error(`远端路径存在多个身份：${path}`);
    const match = matches[0], fileId = match?.fileId ?? id(), head = match?.heads[0];
    if (this.state.entries[fileId]) throw new Error(`远端目标路径已有本地身份，请先处理移动冲突：${path}`);
    const same = match?.heads.length === 1 && !head?.deleted && head?.path === path && head?.hash === hash(data);
    this.state.entries[fileId] = { fileId, path, basePath: path, baseRevision: head?.id ?? null,
      baseHash: match ? hash(data) : null, baseDeleted: false, materialized: true,
      ...(match && !same ? { blocked: '本地与远端同名但内容或版本不同，请选择保留版本' } : {}) };
  }
  noteRename(oldPath: string, path: string): Promise<void> {
    return this.exclusive(async () => {
      for (const e of Object.values(this.state.entries)) {
        if (e.materialized && (e.path === oldPath || e.path.startsWith(oldPath + '/'))) {
          const next = path + e.path.slice(oldPath.length); if (!this.isExcluded(next)) validatePath(next); e.path = next;
        }
      }
      await this.save(this.state);
    });
  }
  approveDeletes(): Promise<void> {
    return this.exclusive(async () => { this.state.deleteApproval = this.state.deletePlan?.fingerprint; await this.save(this.state); });
  }
  sync(idleCheck = false): Promise<void> {
    if (this.running) return this.running;
    const run = this.exclusive(() => this.work(idleCheck));
    this.running = run.finally(() => { this.running = undefined; }); return this.running;
  }
  private async pull(): Promise<void> {
    if (!this.state.epoch) return this.snapshot();
    for (;;) {
      try {
        const page = await this.remote.changes(this.state.cursor, this.state.epoch); this.checkIdentity(page);
        if (page.epoch !== this.state.epoch) throw new SyncError('resync_required', '服务端代次变化');
        if (page.more && page.cursor === this.state.cursor) throw new Error('远端分页游标未前进，已停止拉取');
        this.policy(page.excludedPaths);
        for (const event of page.changes) this.state.remote[event.file.fileId] = event.file;
        this.state.cursor = page.cursor;
        await this.save(this.state); // Entire remote event payload is durable before advancing cursor.
        if (!page.more) break;
      } catch (e) { if (e instanceof SyncError && e.code === 'resync_required') { await this.snapshot(); break; } throw e; }
    }
  }
  private makePending(e: Entry, content: Buffer | null): Pending {
    return { revision: { id: id(), fileId: e.fileId, parents: e.baseRevision ? [e.baseRevision] : [],
      path: e.path, deleted: content === null, hash: content === null ? null : hash(content), size: content?.length ?? 0, clientId: this.state.clientId },
      content: content === null ? null : content.toString('base64') };
  }
  private async stage(): Promise<void> {
    const files = await this.scan();
    const tracked = new Set(Object.values(this.state.entries).map(e => pathKey(e.path)));
    for (const [path, data] of files) if (!tracked.has(pathKey(path))) this.bindUntracked(path, data);
    const deletions: Pending[] = [];
    for (const e of Object.values(this.state.entries)) {
      if (this.isExcluded(e.path)) continue;
      if (e.blocked && !e.materialized && !files.has(e.path)) delete e.blocked;
      if (e.blocked) { this.state.issues[e.fileId] = e.blocked; continue; }
      if (this.state.pending.some(p => p.revision.fileId === e.fileId)) continue;
      const remote = this.state.remote[e.fileId];
      if (remote && remote.heads.length > 1) { this.state.issues[e.fileId] = '多台设备修改了同一篇笔记，请处理冲突'; continue; }
      // A restored database missing a known file is not an instruction to delete or recreate it.
      if (e.baseRevision && !remote) { this.state.issues[e.fileId] = '服务器缺少已知文件历史，已暂停此文件'; continue; }
      const data = files.get(e.path);
      if (data && !e.materialized) { e.blocked = '下载前本地出现同名文件，请选择保留版本'; this.state.issues[e.fileId] = e.blocked; continue; }
      if (data) {
        if (data.length > MAX_BYTES) throw new Error(`笔记超过 5 MiB：${e.path}`);
        if (!e.baseRevision || e.baseDeleted || hash(data) !== e.baseHash || e.path !== e.basePath) this.state.pending.push(this.makePending(e, data));
      } else if (e.materialized && !e.baseDeleted && e.baseRevision) deletions.push(this.makePending(e, null));
    }
    const count = Object.values(this.state.entries).filter(e => !e.baseDeleted && !this.isExcluded(e.path)).length;
    const protectedBatch = (deletions.length >= 10 && deletions.length / Math.max(count, 1) >= 0.1) || (deletions.length >= 5 && deletions.length / Math.max(count, 1) >= 0.2);
    const fingerprint = hash(JSON.stringify(deletions.map(p => [p.revision.fileId, p.revision.parents, p.revision.path]).sort()));
    if (protectedBatch && this.state.deleteApproval !== fingerprint) {
      this.state.deletePlan = { fingerprint, paths: deletions.map(p => p.revision.path), direction: 'local' };
      this.state.issues.__deletes__ = `批量删除保护：${deletions.length} 篇，等待确认`;
    } else {
      this.state.pending.push(...deletions);
      if (this.state.deletePlan?.direction === 'local') { delete this.state.deletePlan; delete this.state.deleteApproval; }
    }
    await this.save(this.state);
  }
  private acknowledge(revision: Revision): void {
    const e = this.state.entries[revision.fileId];
    e.baseRevision = revision.id; e.basePath = revision.path; e.baseHash = revision.hash;
    e.baseDeleted = revision.deleted; e.materialized = true; delete e.blocked;
  }
  private async flush(): Promise<void> {
    for (const pending of [...this.state.pending]) {
      if (this.stopped) return;
      if (this.isExcluded(pending.revision.path) || this.isExcluded(this.state.entries[pending.revision.fileId]?.path ?? pending.revision.path)) continue;
      try {
        if (pending.content !== null) {
          const data = Buffer.from(pending.content, 'base64');
          if (hash(data) !== pending.revision.hash) throw new Error('本地待上传快照损坏，停止提交');
          await this.remote.put(data, pending.revision.hash!);
        }
        await this.remote.commit(pending.revision);
        if (!pending.applyAfter) this.acknowledge(pending.revision);
        this.state.pending = this.state.pending.filter(p => p.revision.id !== pending.revision.id);
        await this.save(this.state);
      } catch (e) {
        if (e instanceof SyncError && ['path_conflict', 'unknown_parent', 'missing_parent', 'idempotency_conflict'].includes(e.code)) {
          this.state.issues[pending.revision.fileId] = e.message; await this.save(this.state); continue;
        }
        throw e;
      }
    }
  }
  private async recoverApply(): Promise<void> {
    const job = this.state.applying;
    if (!job) return;
    const e = this.state.entries[job.fileId], r = job.revision;
    const target = await this.local.read(r.path);
    const old = e.path === r.path ? target : await this.local.read(e.path);
    if ((r.deleted ? !old : !!target && hash(target) === r.hash && (e.path === r.path || !old))) {
      this.acknowledge(r); e.path = r.path;
    }
    delete this.state.applying; await this.save(this.state);
  }
  private async applyRemote(): Promise<void> {
    const deletions = Object.values(this.state.remote).filter(f => f.heads.length === 1 && !this.isExcluded(f.heads[0].path) && !this.isExcluded(this.state.entries[f.fileId]?.path ?? f.heads[0].path) && f.heads[0].deleted &&
      this.state.entries[f.fileId]?.materialized && !this.state.entries[f.fileId].baseDeleted && this.state.entries[f.fileId].baseRevision !== f.heads[0].id);
    const live = Object.values(this.state.entries).filter(e => !e.baseDeleted && !this.isExcluded(e.path)).length;
    const fingerprint = hash('remote:' + JSON.stringify(deletions.map(f => f.heads[0].id).sort()));
    const blockDeletes = ((deletions.length >= 10 && deletions.length / Math.max(live, 1) >= 0.1) || (deletions.length >= 5 && deletions.length / Math.max(live, 1) >= 0.2)) && this.state.deleteApproval !== fingerprint;
    if (blockDeletes) {
      this.state.deletePlan = { fingerprint, paths: deletions.map(f => f.heads[0].path), direction: 'remote' };
      this.state.issues.__deletes__ = `远端批量删除保护：${deletions.length} 篇，等待确认`;
    }
    for (const file of Object.values(this.state.remote)) {
      if (this.stopped) return;
      let e = this.state.entries[file.fileId];
      if ((e && this.isExcluded(e.path)) || file.heads.some(head => this.isExcluded(head.path))) continue;
      if (file.heads.length !== 1) { this.state.issues[file.fileId] = '存在多个版本，请查看冲突'; continue; }
      const r = file.heads[0];
      if (blockDeletes && r.deleted) continue;
      if (!e && r.deleted) continue;
      if (!e) {
        e = { fileId: file.fileId, path: r.path, basePath: r.path, baseRevision: null, baseHash: null, baseDeleted: true, materialized: false };
        this.state.entries[e.fileId] = e;
      }
      if (e.blocked || this.state.pending.some(p => p.revision.fileId === e.fileId)) continue;
      if (e.baseRevision === r.id) continue;
      const content = r.deleted ? null : await this.remote.get(r.hash!);
      this.state.applying = { fileId: e.fileId, revision: r }; await this.save(this.state);
      try {
        const current = await this.local.read(e.path);
        if (!(e.path === r.path && (content === null ? current === null : current !== null && hash(current) === r.hash))) {
          await this.local.apply({ oldPath: e.path, path: r.path, expectedHash: e.materialized && !e.baseDeleted ? e.baseHash : null, content });
        }
        this.acknowledge(r); e.path = r.path;
      } catch (error) {
        this.state.issues[e.fileId] = error instanceof Error ? error.message : '本地文件变化，等待处理';
      } finally { delete this.state.applying; await this.save(this.state); }
    }
    if (!blockDeletes && this.state.deletePlan?.direction === 'remote') { delete this.state.deletePlan; delete this.state.deleteApproval; }
  }
  private async work(idleCheck: boolean): Promise<void> {
    if (this.stopped || !this.state.initialized) return;
    if (this.state.overwrite) throw new Error('覆盖尚未完成，请在设置中继续或重新预览');
    await this.remote.verifyProtocol();
    if (idleCheck && !this.state.applying && !this.state.pending.length && !Object.keys(this.state.issues).length && !this.state.deletePlan) {
      const before = JSON.stringify([this.state.epoch, this.state.cursor, this.state.serverExcludedPaths]);
      await this.pull();
      if (before === JSON.stringify([this.state.epoch, this.state.cursor, this.state.serverExcludedPaths])) { this.report('已同步'); return; }
    }
    this.report('正在同步…'); this.state.issues = {};
    await this.recoverApply(); await this.pull(); await this.stage(); await this.flush(); await this.pull(); await this.applyRemote();
    // A local edit made while uploading is not yet synced, even if the previous revision succeeded.
    await this.stage();
    await this.save(this.state);
    const count = Object.keys(this.state.issues).length;
    const held = this.state.pending.filter(p => this.isExcluded(p.revision.path) || this.isExcluded(this.state.entries[p.revision.fileId]?.path ?? p.revision.path)).length;
    const uploading = this.state.pending.length - held;
    this.report(count ? `${count} 项需处理` : uploading ? `待上传 ${uploading} 项` : held ? `已同步，${held} 项已排除并保留待上传快照` : '已同步');
  }
  retryRenamed(fileId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.pull();
      const e = this.state.entries[fileId];
      const pending = this.state.pending.filter(p => p.revision.fileId === fileId);
      if (!e || this.state.remote[fileId] || !pending.length || pending.some(p => p.revision.path === e.path)) throw new Error('请先将冲突的新文件改为未占用的名称');
      for (const p of pending) if (p.content !== null) await this.local.preserve(Buffer.from(p.content, 'base64'));
      this.state.pending = this.state.pending.filter(p => p.revision.fileId !== fileId);
      e.baseRevision = null; e.baseHash = null; delete e.blocked;
      await this.save(this.state);
    });
  }
  resolve(fileId: string, choice: 'local' | Revision): Promise<void> {
    return this.exclusive(async () => {
      await this.remote.verifyProtocol();
      await this.pull();
      const e = this.state.entries[fileId], file = this.state.remote[fileId];
      if (!e || !file || !file.heads.length) throw new Error('无法找到文件版本');
      if (this.isExcluded(e.path) || file.heads.some(head => this.isExcluded(head.path)) || (choice !== 'local' && this.isExcluded(choice.path))) throw new Error('该文件在排除规则内，请先调整规则再选择版本');
      const local = await this.local.read(e.path);
      if (local) await this.local.preserve(local);
      // Preserve even a not-yet-acknowledged upload before explicitly replacing it.
      for (const p of this.state.pending.filter(p => p.revision.fileId === fileId)) if (p.content !== null) await this.local.preserve(Buffer.from(p.content, 'base64'));
      const selected = choice === 'local' ? null : choice;
      if (selected && selected.fileId !== fileId) throw new Error('历史版本身份不匹配');
      const content = choice === 'local' ? local : selected!.deleted ? null : await this.remote.get(selected!.hash!);
      const revision: Revision = { id: id(), fileId, parents: file.heads.map(h => h.id).sort(), path: selected?.path ?? e.path,
        deleted: content === null, hash: content === null ? null : hash(content), size: content?.length ?? 0, clientId: this.state.clientId };
      // Do not mutate the local baseline until downloaded bytes are safely applied.
      if (content !== null) await this.remote.put(content, revision.hash!);
      // Resolution operation must also be restartable if its response is lost.
      this.state.pending = this.state.pending.filter(p => p.revision.fileId !== fileId);
      this.state.pending.push({ revision, content: content === null ? null : content.toString('base64'), applyAfter: true });
      delete e.blocked;
      // Keep expected local bytes until reconcile, unlike normal upload acknowledgement.
      e.baseHash = local ? hash(local) : null; e.baseDeleted = local === null; e.materialized = true;
      await this.save(this.state);
      // A resolution is published by normal flush, but its local application uses the preserved expectation.
      await this.flush();
      await this.pull(); await this.applyRemote(); await this.save(this.state);
    });
  }
}
