import { randomBytes, createHmac } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { assertHash, assertId, Changes, CommitResult, Cursor, FileState, hash, id, MAX_BYTES, MAX_FILES, PairResult, pathsOverlap, PROTOCOL, Revision, Snapshot, SyncError, validateRevision, validCursor } from '../shared/protocol';
import type { Backend, DeviceInfo } from './backend';

export interface CouchOptions { url: string; user: string; password: string; database: string; root: string }
type Doc = Record<string, any>;
type RevisionDoc = Doc & { type: 'revision'; vaultId: string; revision: Revision; fileAfter: FileState };

/** Immutable business revisions are authoritative. CouchDB _rev is used only for
 * CAS of control records, never as user-visible version history. A database is
 * owned by one gateway data volume; horizontally scaled writers are rejected. */
export class CouchStore implements Backend {
  readonly kind = 'couchdb';
  serverId = '';
  readonly epoch = id();
  readonly root: string;
  private readonly base: string;
  private readonly auth: string;
  private meta!: Doc;
  private cursor: Cursor = 0;
  private readonly records = new Map<string, { doc: RevisionDoc; seq: Cursor }>();
  private readonly files = new Map<string, Map<string, Map<string, Revision>>>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(readonly options: CouchOptions) {
    const url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('CouchDB URL must be an HTTP(S) root without embedded credentials');
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(options.database)) throw new Error('Invalid CouchDB database name');
    if (!options.user || !options.password) throw new Error('CouchDB server credentials missing');
    this.base = url.origin + '/' + options.database;
    this.auth = 'Basic ' + Buffer.from(options.user + ':' + options.password).toString('base64');
    this.root = resolve(options.root); mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  static async open(options: CouchOptions): Promise<CouchStore> {
    const store = new CouchStore(options);
    await store.raw('?n=1&q=1', 'PUT', undefined, [201, 202, 412]);
    const ownerFile = join(store.root, 'gateway-owner');
    if (!existsSync(ownerFile)) { try { writeFileSync(ownerFile, id(), { flag: 'wx', mode: 0o600 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; } }
    const owner = readFileSync(ownerFile, 'utf8').trim(); assertId(owner);
    let meta = await store.doc('control');
    if (!meta) {
      const proposed = { _id: 'control', type: 'control', schema: 1, serverId: id(), owner, pairSecret: randomBytes(32).toString('hex') };
      try { await store.put(proposed); } catch (e) { if (!(e instanceof SyncError && e.code === 'couch_conflict')) throw e; }
      meta = await store.doc('control');
    }
    if (!meta || meta.schema !== 1 || meta.type !== 'control') throw new Error('Unsupported CouchDB storage schema');
    if (meta.owner !== owner) throw new Error('此数据库已绑定另一套网关数据目录，请恢复原数据卷；禁止同时运行多个网关写入');
    store.meta = meta; store.serverId = meta.serverId;
    await store.refresh(); return store;
  }
  private async raw(path: string, method = 'GET', body?: unknown, accepted = [200, 201, 202]): Promise<Response> {
    let response: Response;
    try { response = await fetch(this.base + path, { method, headers: { Authorization: this.auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' }); }
    catch { throw new SyncError('couch_unavailable', '同步数据库暂时无法连接，请稍后重试或联系管理员', 503); }
    if (!accepted.includes(response.status)) {
      if (response.status === 409) throw new SyncError('couch_conflict', '数据库记录发生并发修改，请重试');
      if (response.status === 400) throw new SyncError('couch_bad_request', '数据库请求或同步游标无效', 400);
      throw new SyncError('couch_unavailable', '同步数据库尚未就绪或服务端凭证无效，请联系管理员', 503);
    }
    return response;
  }
  private async doc(key: string): Promise<Doc | null> {
    const response = await this.raw('/' + encodeURIComponent(key), 'GET', undefined, [200, 404]);
    return response.status === 404 ? null : response.json();
  }
  private async put(doc: Doc): Promise<void> { await this.raw('/' + encodeURIComponent(doc._id), 'PUT', doc); }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => { if (this.closed) throw new Error('Storage closed'); return action(); });
    this.tail = run.catch(() => {}); return run;
  }
  private key(vaultId: string, kind: string, value: string): string { assertId(vaultId); return `${kind}:${vaultId}:${value}`; }
  private collect(doc: Doc, seq: Cursor): void {
    if (doc.type !== 'revision') return;
    const r = validateRevision(doc.revision); assertId(doc.vaultId);
    if (doc._id !== this.key(doc.vaultId, 'revision', r.id)) throw new SyncError('couch_corrupt', '数据库版本标识不一致，已停止同步', 503);
    const key = doc._id, previous = this.records.get(key);
    if (previous && JSON.stringify(previous.doc.revision) !== JSON.stringify(r)) throw new SyncError('couch_corrupt', '已提交版本被修改，已停止同步', 503);
    if (previous) return;
    let vault = this.files.get(doc.vaultId); if (!vault) this.files.set(doc.vaultId, vault = new Map());
    let file = vault.get(r.fileId); if (!file) vault.set(r.fileId, file = new Map());
    file.set(r.id, r); this.records.set(key, { doc: { ...doc, revision: r } as RevisionDoc, seq });
  }
  private async refresh(): Promise<void> {
    for (;;) {
      const page = await (await this.raw(`/_changes?since=${encodeURIComponent(this.cursor)}&include_docs=true&limit=500`)).json() as any;
      if (!validCursor(page.last_seq) || !Array.isArray(page.results)) throw new SyncError('couch_corrupt', '数据库变化流无效', 503);
      for (const row of page.results) {
        if (row.deleted && String(row.id).startsWith('revision:')) throw new SyncError('couch_corrupt', '修订历史被外部删除，已停止同步', 503);
        if (row.doc && validCursor(row.seq)) this.collect(row.doc, row.seq);
      }
      if (page.pending > 0 && page.last_seq === this.cursor) throw new Error('CouchDB cursor did not advance');
      this.cursor = page.last_seq;
      if (!page.pending) break;
    }
  }
  private file(vaultId: string, fileId: string): FileState {
    const revisions = this.files.get(vaultId)?.get(fileId) ?? new Map<string, Revision>();
    const heads = new Map(revisions);
    for (const r of revisions.values()) for (const parent of r.parents) {
      if (!revisions.has(parent)) throw new SyncError('couch_corrupt', '数据库缺少父版本，请恢复完整备份', 503);
      heads.delete(parent);
    }
    return { fileId, heads: [...heads.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  }
  createPair(name: string, vaultId?: string): Promise<{ code: string; vaultId: string; expires: number }> {
    return this.serial(async () => {
      if (!name.trim() || name.length > 100) throw new Error('Vault name required (max 100 characters)');
      const vid = vaultId ?? id(); assertId(vid);
      const vaultKey = 'vault:' + vid;
      if (!await this.doc(vaultKey)) {
        if (vaultId) throw new Error('指定的远端笔记库不存在，请检查 Vault ID');
        await this.put({ _id: vaultKey, type: 'vault', name, vaultId: vid });
      }
      const code = randomBytes(12).toString('hex'), expires = Date.now() + 10 * 60 * 1000;
      await this.put({ _id: 'pair:' + hash(code), type: 'pair', vaultId: vid, deviceId: id(), expires });
      return { code, vaultId: vid, expires };
    });
  }
  pair(code: string, name: string, requestId: string = id()): Promise<PairResult> {
    return this.serial(async () => {
      if (!/^[a-f0-9]{24}$/.test(code) || !name.trim() || name.length > 100) throw new SyncError('pair_denied', '连接码无效或已过期，请向管理员重新获取', 401);
      assertId(requestId);
      let pairing = await this.doc('pair:' + hash(code));
      if (!pairing || pairing.expires <= Date.now() || (pairing.requestId && pairing.requestId !== requestId)) throw new SyncError('pair_denied', '连接码无效或已被其他设备使用', 401);
      if (!pairing.requestId) {
        pairing = { ...pairing, requestId, deviceName: name };
        try { await this.put(pairing); }
        catch (e) {
          if (!(e instanceof SyncError && e.code === 'couch_conflict')) throw e;
          pairing = await this.doc(pairing._id);
          if (!pairing || pairing.requestId !== requestId) throw new SyncError('pair_denied', '连接码已被其他设备使用', 401);
        }
      }
      const token = createHmac('sha256', this.meta.pairSecret).update(code).digest('hex');
      const key = 'device:' + hash(token);
      let device = await this.doc(key);
      if (!device) { await this.put({ _id: key, type: 'device', id: pairing!.deviceId, vaultId: pairing!.vaultId, name: pairing!.deviceName, revoked: false }); device = await this.doc(key); }
      if (!device || device.revoked) throw new SyncError('pair_denied', '设备已被撤销，请向管理员获取新的连接码', 401);
      const vault = await this.doc('vault:' + device.vaultId);
      return { token, deviceId: device.id, vaultId: device.vaultId, vaultName: vault?.name ?? 'Notes', serverId: this.serverId };
    });
  }
  async authenticate(token: string): Promise<{ vaultId: string; deviceId: string }> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new SyncError('unauthorized', '设备未授权或已撤销', 401);
    const device = await this.doc('device:' + hash(token));
    if (!device || device.type !== 'device' || device.revoked) throw new SyncError('unauthorized', '设备未授权或已撤销', 401);
    return { vaultId: device.vaultId, deviceId: device.id };
  }
  async putObject(vaultId: string, sha: string, data: Buffer): Promise<void> {
    assertHash(sha); assertId(vaultId);
    if (data.length > MAX_BYTES || hash(data) !== sha || !Buffer.from(data.toString('utf8')).equals(data)) throw new SyncError('invalid_object', '正文超限、哈希不符或不是有效 UTF-8', 400);
    const key = this.key(vaultId, 'object', sha), previous = await this.doc(key);
    if (previous) { const actual = await this.getObject(vaultId, sha); if (!actual.equals(data)) throw new Error('Object mismatch'); return; }
    try { await this.put({ _id: key, type: 'object', vaultId, hash: sha, size: data.length,
      _attachments: { body: { content_type: 'application/octet-stream', data: data.toString('base64') } } }); }
    catch (e) { if (!(e instanceof SyncError && e.code === 'couch_conflict')) throw e; if (!(await this.getObject(vaultId, sha)).equals(data)) throw new Error('Object mismatch'); }
  }
  async getObject(vaultId: string, sha: string): Promise<Buffer> {
    assertHash(sha); const key = this.key(vaultId, 'object', sha);
    const response = await this.raw('/' + encodeURIComponent(key) + '/body', 'GET', undefined, [200, 404]);
    if (response.status === 404) throw new SyncError('object_missing', '正文不存在', 404);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_BYTES || hash(data) !== sha) throw new SyncError('couch_corrupt', '数据库正文校验失败', 503);
    return data;
  }
  snapshot(vaultId: string): Promise<Snapshot> {
    return this.serial(async () => { await this.refresh(); const files = [...(this.files.get(vaultId)?.keys() ?? [])].sort().map(f => this.file(vaultId, f));
      if (files.length > MAX_FILES) throw new SyncError('vault_too_large', '文件数量超过首版上限', 413);
      return { protocol: PROTOCOL, serverId: this.serverId, epoch: this.epoch, cursor: this.cursor, files }; });
  }
  changes(vaultId: string, after: Cursor, epoch: string): Promise<Changes> {
    return this.serial(async () => {
      if (epoch !== this.epoch || !validCursor(after)) throw new SyncError('resync_required', '服务已重新启动，请重新核对基线');
      await this.refresh(); let page: any;
      try { page = await (await this.raw(`/_changes?since=${encodeURIComponent(after)}&include_docs=true&limit=100`)).json(); }
      catch (e) { if (e instanceof SyncError && e.code === 'couch_bad_request') throw new SyncError('resync_required', '数据库游标已失效，请重新核对'); throw e; }
      const changes = [];
      for (const row of page.results) if (row.doc?.type === 'revision' && row.doc.vaultId === vaultId) changes.push({ seq: row.seq as Cursor, file: this.file(vaultId, row.doc.revision.fileId) });
      return { serverId: this.serverId, epoch: this.epoch, cursor: page.last_seq, more: page.pending > 0, changes };
    });
  }
  commit(vaultId: string, input: unknown, deviceId: string): Promise<CommitResult> {
    return this.serial(async () => {
      const revision = validateRevision(input); assertId(vaultId);
      if (revision.clientId !== deviceId) throw new SyncError('wrong_device', '修订必须属于当前设备', 403);
      await this.refresh(); const key = this.key(vaultId, 'revision', revision.id), previous = this.records.get(key);
      if (previous) { if (JSON.stringify(previous.doc.revision) !== JSON.stringify(revision)) throw new SyncError('idempotency_conflict', '修订标识被用于不同内容'); return { revision, file: previous.doc.fileAfter, seq: previous.seq }; }
      const existing = this.file(vaultId, revision.fileId);
      if (existing.heads.length && !revision.parents.length) throw new SyncError('missing_parent', '已有文件不能创建第二个无父版本');
      if (!existing.heads.length && (this.files.get(vaultId)?.size ?? 0) >= MAX_FILES) throw new SyncError('vault_too_large', '文件数量达到首版上限', 413);
      for (const parent of revision.parents) if (this.records.get(this.key(vaultId, 'revision', parent))?.doc.revision.fileId !== revision.fileId) throw new SyncError('unknown_parent', '父修订不存在或不属于此文件');
      if (!revision.deleted) {
        const obj = await this.doc(this.key(vaultId, 'object', revision.hash!));
        if (!obj || obj.type !== 'object' || obj.size !== revision.size || !obj._attachments?.body) throw new SyncError('object_missing', '正文尚未持久化');
        for (const fileId of this.files.get(vaultId)?.keys() ?? []) if (fileId !== revision.fileId && this.file(vaultId, fileId).heads.some(h => !h.deleted && pathsOverlap(h.path, revision.path))) throw new SyncError('path_conflict', '目标路径已被其他逻辑文件占用');
      }
      const fileAfter = { fileId: revision.fileId, heads: [...existing.heads.filter(h => !revision.parents.includes(h.id)), revision].sort((a, b) => a.id.localeCompare(b.id)) };
      const doc: RevisionDoc = { _id: key, type: 'revision', vaultId, revision, fileAfter };
      try { await this.put(doc); }
      catch (e) {
        // An ambiguous write must be reconciled, never followed by a new revision ID.
        const found = await this.doc(key).catch(() => null);
        if (!found || JSON.stringify(found.revision) !== JSON.stringify(revision)) throw e;
      }
      await this.refresh(); const saved = this.records.get(key);
      if (!saved) throw new SyncError('couch_unavailable', '提交已接收，正在等待数据库确认，请重试', 503);
      return { revision, file: saved.doc.fileAfter, seq: saved.seq };
    });
  }
  known(vaultId: string, ids: unknown): Promise<string[]> {
    return this.serial(async () => { if (!Array.isArray(ids) || ids.length > 100) throw new SyncError('invalid_check', '每次最多核对 100 个版本', 400);
      ids.forEach(assertId); await this.refresh(); return ids.filter(value => this.records.has(this.key(vaultId, 'revision', value))); });
  }
  history(vaultId: string, fileId: string, before?: Cursor): Promise<{ seq: Cursor; revision: Revision }[]> {
    return this.serial(async () => { assertId(fileId); await this.refresh();
      const list = [...this.records.values()].filter(r => r.doc.vaultId === vaultId && r.doc.revision.fileId === fileId).reverse();
      const start = before === undefined ? 0 : list.findIndex(r => String(r.seq) === String(before)) + 1;
      if (before !== undefined && start === 0) throw new SyncError('invalid_cursor', '历史游标已失效，请重新打开历史记录', 400);
      return list.slice(start, start + 100).map(r => ({ seq: r.seq, revision: r.doc.revision })); });
  }
  private async prefix(prefix: string): Promise<Doc[]> {
    const result: Doc[] = []; let after: string | undefined;
    for (;;) {
      const qs = new URLSearchParams({ include_docs: 'true', limit: '100', startkey: JSON.stringify(after ?? prefix), endkey: JSON.stringify(prefix + '\ufff0'), ...(after ? { skip: '1' } : {}) });
      const page = await (await this.raw('/_all_docs?' + qs)).json() as any;
      result.push(...page.rows.map((r: any) => r.doc)); if (page.rows.length < 100) return result; after = page.rows[page.rows.length - 1].id;
    }
  }
  async devices(): Promise<DeviceInfo[]> { return (await this.prefix('device:')).map(d => ({ id: d.id, vault_id: d.vaultId, name: d.name, revoked: d.revoked ? 1 : 0 })); }
  async revoke(deviceId: string): Promise<void> { assertId(deviceId); const device = (await this.prefix('device:')).find(d => d.id === deviceId); if (!device) throw new Error('Device not found'); await this.put({ ...device, revoked: true }); }
  async health(): Promise<void> { await this.raw(''); }
  async backup(destination: string): Promise<void> {
    const target = resolve(destination); if (target === this.root || target.startsWith(this.root + sep)) throw new Error('Backup must be outside data directory');
    mkdirSync(target, { recursive: false, mode: 0o700 });
    const file = join(target, 'couchdb.jsonl'), objects = new Set<string>(), revisions: { vaultId: string; revision: Revision }[] = [];
    writeFileSync(file, '', { mode: 0o600 }); let after: string | undefined;
    for (;;) {
      const qs = new URLSearchParams({ include_docs: 'true', attachments: 'true', limit: '20', ...(after ? { startkey: JSON.stringify(after), skip: '1' } : {}) });
      const page = await (await this.raw('/_all_docs?' + qs)).json() as any;
      for (const row of page.rows) {
        const d = row.doc; if (!d || d._deleted) continue;
        if (d.type === 'object') { const bytes = Buffer.from(d._attachments?.body?.data ?? '', 'base64'); if (bytes.length !== d.size || hash(bytes) !== d.hash) throw new Error('Backup object verification failed'); objects.add(d._id); }
        if (d.type === 'revision') revisions.push({ vaultId: d.vaultId, revision: validateRevision(d.revision) });
        const { _rev, ...document } = d; appendFileSync(file, JSON.stringify(document) + '\n');
      }
      if (page.rows.length < 20) break; after = page.rows[page.rows.length - 1].id;
    }
    const seen = new Set(revisions.map(r => this.key(r.vaultId, 'revision', r.revision.id)));
    for (const { vaultId, revision: r } of revisions) {
      if ((!r.deleted && !objects.has(this.key(vaultId, 'object', r.hash!))) || r.parents.some(p => !seen.has(this.key(vaultId, 'revision', p)))) throw new Error('Backup raced with a new commit; retry. This backup is incomplete.');
    }
    const fd = openSync(file, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    writeFileSync(join(target, 'gateway-owner'), this.meta.owner, { mode: 0o600 });
    writeFileSync(join(target, 'backup.json'), JSON.stringify({ schema: 1, backend: this.kind, serverId: this.serverId, complete: true, createdAt: new Date().toISOString(), revisions: revisions.length }));
  }
  async close(): Promise<void> { await this.tail; this.closed = true; }
}
