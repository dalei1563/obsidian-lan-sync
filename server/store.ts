import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, cpSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assertHash, assertId, Changes, CommitResult, Cursor, FileState, hash, id, MAX_BYTES, MAX_FILES, PairResult, pathsOverlap, PROTOCOL, Revision, Snapshot, SyncError, validateRevision } from '../shared/protocol';
import type { Backend, DeviceInfo } from './backend';

type Row = Record<string, any>;
export class Store implements Backend {
  readonly kind = 'sqlite';
  readonly db: DatabaseSync;
  readonly root: string;
  readonly serverId: string;
  readonly epoch: string;
  constructor(root: string, newEpoch = false) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.root, 'sync.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vaults(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pairing(code_hash TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS objects(vault_id TEXT NOT NULL REFERENCES vaults(id), hash TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(vault_id,hash));
      CREATE TABLE IF NOT EXISTS revisions(vault_id TEXT NOT NULL REFERENCES vaults(id), id TEXT NOT NULL, file_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(vault_id,id));
      CREATE INDEX IF NOT EXISTS revision_file ON revisions(vault_id,file_id);
      CREATE TABLE IF NOT EXISTS heads(vault_id TEXT NOT NULL, file_id TEXT NOT NULL, revision_id TEXT NOT NULL, PRIMARY KEY(vault_id,revision_id), FOREIGN KEY(vault_id,revision_id) REFERENCES revisions(vault_id,id));
      CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, vault_id TEXT NOT NULL, file_id TEXT NOT NULL, revision_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS change_vault ON changes(vault_id,seq);
      CREATE TABLE IF NOT EXISTS operations(vault_id TEXT NOT NULL, revision_id TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(vault_id,revision_id));`);
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as Row | undefined;
    if (version && version.value !== '1') throw new Error('Unsupported database schema');
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('schema','1')").run();
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('serverId',?)").run(id());
    this.serverId = (this.db.prepare("SELECT value FROM meta WHERE key='serverId'").get() as Row).value;
    if (newEpoch) this.db.prepare("INSERT OR REPLACE INTO meta VALUES ('epoch',?)").run(id());
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('epoch',?)").run(id());
    this.epoch = (this.db.prepare("SELECT value FROM meta WHERE key='epoch'").get() as Row).value;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  createPair(vaultName: string, vaultId?: string): { code: string; vaultId: string; expires: number } {
    const vid = vaultId ?? id(); assertId(vid);
    if (!vaultName.trim() || vaultName.length > 100) throw new Error('Vault name required (max 100 characters)');
    const code = randomBytes(12).toString('hex');
    const expires = Date.now() + 10 * 60 * 1000;
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO vaults VALUES (?,?)').run(vid, vaultName);
      this.db.prepare('DELETE FROM pairing WHERE expires < ?').run(Date.now());
      this.db.prepare('INSERT INTO pairing VALUES (?,?,?)').run(hash(code), vid, expires);
    });
    return { code, vaultId: vid, expires };
  }
  pair(code: string, deviceName: string): PairResult {
    if (!/^[a-f0-9]{24}$/.test(code) || !deviceName.trim() || deviceName.length > 100) throw new SyncError('pair_denied', '配对码无效或已过期', 401);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT p.vault_id,v.name FROM pairing p JOIN vaults v ON v.id=p.vault_id WHERE code_hash=? AND expires>?').get(hash(code), Date.now()) as Row | undefined;
      if (!row) throw new SyncError('pair_denied', '配对码无效或已过期', 401);
      const token = randomBytes(32).toString('hex'), deviceId = id();
      this.db.prepare('INSERT INTO devices(id,vault_id,name,token_hash) VALUES (?,?,?,?)').run(deviceId, row.vault_id, deviceName, hash(token));
      this.db.prepare('DELETE FROM pairing WHERE code_hash=?').run(hash(code));
      return { token, deviceId, vaultId: row.vault_id, vaultName: row.name, serverId: this.serverId };
    });
  }
  authenticate(token: string): { vaultId: string; deviceId: string } {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new SyncError('unauthorized', '设备未授权或已撤销', 401);
    const row = this.db.prepare('SELECT id,vault_id FROM devices WHERE token_hash=? AND revoked=0').get(hash(token)) as Row | undefined;
    if (!row) throw new SyncError('unauthorized', '设备未授权或已撤销', 401);
    return { vaultId: row.vault_id, deviceId: row.id };
  }
  objectPath(vaultId: string, sha: string): string { assertId(vaultId); assertHash(sha); return join(this.root, 'objects', vaultId, sha.slice(0, 2), sha); }
  putObject(vaultId: string, sha: string, data: Buffer): void {
    assertHash(sha);
    if (data.length > MAX_BYTES || hash(data) !== sha || !Buffer.from(data.toString('utf8'), 'utf8').equals(data)) throw new SyncError('invalid_object', '正文超限、哈希不符或不是有效 UTF-8', 400);
    const target = this.objectPath(vaultId, sha), dir = join(this.root, 'objects', vaultId, sha.slice(0, 2));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(target)) {
      const tmp = target + '.' + id() + '.tmp';
      const fd = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      try { renameSync(tmp, target); } finally { if (existsSync(tmp)) unlinkSync(tmp); }
      // POSIX directory durability; Windows cannot fsync directories this way.
      if (process.platform !== 'win32') { const d = openSync(dir, 'r'); try { fsyncSync(d); } finally { closeSync(d); } }
    } else if (hash(readFileSync(target)) !== sha) throw new SyncError('corrupt_object', '服务端对象损坏，暂停同步', 503);
    this.db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?,?)').run(vaultId, sha, data.length);
  }
  getObject(vaultId: string, sha: string): Buffer {
    assertHash(sha);
    if (!this.db.prepare('SELECT 1 FROM objects WHERE vault_id=? AND hash=?').get(vaultId, sha)) throw new SyncError('object_missing', '正文不存在', 404);
    const data = readFileSync(this.objectPath(vaultId, sha));
    if (hash(data) !== sha) throw new SyncError('corrupt_object', '服务端对象损坏', 503);
    return data;
  }
  file(vaultId: string, fileId: string): FileState {
    const rows = this.db.prepare('SELECT r.payload FROM heads h JOIN revisions r ON r.vault_id=h.vault_id AND r.id=h.revision_id WHERE h.vault_id=? AND h.file_id=? ORDER BY r.id').all(vaultId, fileId) as Row[];
    return { fileId, heads: rows.map(r => JSON.parse(r.payload)) };
  }
  snapshot(vaultId: string): Snapshot {
    // Synchronous code inside a SQLite read transaction: consistent files and cursor.
    this.db.exec('BEGIN');
    try {
      const rows = this.db.prepare('SELECT DISTINCT file_id FROM heads WHERE vault_id=? ORDER BY file_id LIMIT ?').all(vaultId, MAX_FILES + 1) as Row[];
      if (rows.length > MAX_FILES) throw new SyncError('vault_too_large', '首版最多支持 10000 个逻辑文件', 413);
      const cursor = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM changes WHERE vault_id=?').get(vaultId) as Row).n);
      const result = { protocol: PROTOCOL, serverId: this.serverId, epoch: this.epoch, cursor, files: rows.map(r => this.file(vaultId, r.file_id)) };
      this.db.exec('COMMIT'); return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  changes(vaultId: string, afterInput: Cursor, epoch: string, limit = 100): Changes {
    const after = Number(afterInput);
    if (!Number.isSafeInteger(after) || after < 0 || epoch !== this.epoch) throw new SyncError('resync_required', '服务器已重启或恢复，请重新核对基线');
    const max = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM changes WHERE vault_id=?').get(vaultId) as Row).n);
    if (after > max) throw new SyncError('resync_required', '同步游标超出服务器历史');
    const rows = this.db.prepare('SELECT seq,payload FROM changes WHERE vault_id=? AND seq>? ORDER BY seq LIMIT ?').all(vaultId, after, limit + 1) as Row[];
    const page = rows.slice(0, limit);
    return { serverId: this.serverId, epoch: this.epoch, cursor: page.length ? Number(page[page.length - 1].seq) : after,
      more: rows.length > limit, changes: page.map(r => ({ seq: Number(r.seq), file: JSON.parse(r.payload) })) };
  }
  commit(vaultId: string, input: unknown, deviceId: string): CommitResult {
    const revision = validateRevision(input);
    if (revision.clientId !== deviceId) throw new SyncError('wrong_device', '修订必须属于当前设备', 403);
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT payload FROM revisions WHERE vault_id=? AND id=?').get(vaultId, revision.id) as Row | undefined;
      if (previous) {
        if (previous.payload !== JSON.stringify(revision)) throw new SyncError('idempotency_conflict', '修订标识被用于不同内容');
        return JSON.parse((this.db.prepare('SELECT result FROM operations WHERE vault_id=? AND revision_id=?').get(vaultId, revision.id) as Row).result);
      }
      const existing = this.file(vaultId, revision.fileId);
      if (existing.heads.length && !revision.parents.length) throw new SyncError('missing_parent', '已有文件不能创建第二个无父版本');
      if (!existing.heads.length) {
        const count = Number((this.db.prepare('SELECT COUNT(DISTINCT file_id) n FROM heads WHERE vault_id=?').get(vaultId) as Row).n);
        if (count >= MAX_FILES) throw new SyncError('vault_too_large', '文件数量达到首版上限', 413);
      }
      for (const parent of revision.parents) {
        const row = this.db.prepare('SELECT file_id FROM revisions WHERE vault_id=? AND id=?').get(vaultId, parent) as Row | undefined;
        if (!row || row.file_id !== revision.fileId) throw new SyncError('unknown_parent', '父修订不存在或不属于此文件');
      }
      if (!revision.deleted) {
        const obj = this.db.prepare('SELECT size FROM objects WHERE vault_id=? AND hash=?').get(vaultId, revision.hash!) as Row | undefined;
        if (!obj || obj.size !== revision.size || !existsSync(this.objectPath(vaultId, revision.hash!))) throw new SyncError('object_missing', '正文未持久化');
        const paths = this.db.prepare('SELECT r.payload FROM heads h JOIN revisions r ON r.vault_id=h.vault_id AND r.id=h.revision_id WHERE h.vault_id=? AND h.file_id<>?').all(vaultId, revision.fileId) as Row[];
        if (paths.some(p => { const r: Revision = JSON.parse(p.payload); return !r.deleted && pathsOverlap(r.path, revision.path); })) throw new SyncError('path_conflict', '目标路径已被其他逻辑文件占用');
      }
      this.db.prepare('INSERT INTO revisions VALUES (?,?,?,?)').run(vaultId, revision.id, revision.fileId, JSON.stringify(revision));
      // Existing heads form an antichain: no current head can be an ancestor of an
      // existing non-head parent. Direct-parent removal is sufficient and avoids
      // walking the full history on every keystroke batch.
      for (const head of existing.heads) if (revision.parents.includes(head.id)) this.db.prepare('DELETE FROM heads WHERE vault_id=? AND revision_id=?').run(vaultId, head.id);
      this.db.prepare('INSERT INTO heads VALUES (?,?,?)').run(vaultId, revision.fileId, revision.id);
      const file = this.file(vaultId, revision.fileId);
      const seq = Number(this.db.prepare('INSERT INTO changes(vault_id,file_id,revision_id,payload) VALUES (?,?,?,?)').run(vaultId, revision.fileId, revision.id, JSON.stringify(file)).lastInsertRowid);
      const result = { revision, file, seq };
      this.db.prepare('INSERT INTO operations VALUES (?,?,?)').run(vaultId, revision.id, JSON.stringify(result));
      return result;
    });
  }
  history(vaultId: string, fileId: string, beforeInput?: Cursor): { seq: number; revision: Revision }[] {
    const before = beforeInput === undefined ? Number.MAX_SAFE_INTEGER : Number(beforeInput);
    if (!Number.isSafeInteger(before) || before < 0) throw new SyncError('invalid_cursor', '历史游标无效', 400);
    assertId(fileId);
    return (this.db.prepare('SELECT c.seq,r.payload FROM changes c JOIN revisions r ON r.vault_id=c.vault_id AND r.id=c.revision_id WHERE c.vault_id=? AND c.file_id=? AND c.seq<? ORDER BY c.seq DESC LIMIT 100').all(vaultId, fileId, before) as Row[])
      .map(r => ({ seq: Number(r.seq), revision: JSON.parse(r.payload) }));
  }
  known(vaultId: string, ids: unknown): string[] {
    if (!Array.isArray(ids) || ids.length > 100) throw new SyncError('invalid_check', '每次最多核对 100 个版本', 400);
    ids.forEach(assertId);
    const query = this.db.prepare('SELECT 1 FROM revisions WHERE vault_id=? AND id=?');
    return ids.filter(value => query.get(vaultId, value));
  }
  backup(destination: string): void {
    const target = resolve(destination);
    if (target === this.root || target.startsWith(this.root + require('node:path').sep)) throw new Error('Backup must be outside data directory');
    mkdirSync(target, { recursive: false, mode: 0o700 });
    this.db.prepare('VACUUM INTO ?').run(join(target, 'sync.sqlite'));
    if (existsSync(join(this.root, 'objects'))) cpSync(join(this.root, 'objects'), join(target, 'objects'), { recursive: true, filter: s => !s.endsWith('.tmp') && !lstatSync(s).isSymbolicLink() });
    writeFileSync(join(target, 'backup.json'), JSON.stringify({ protocol: PROTOCOL, serverId: this.serverId, createdAt: new Date().toISOString(), complete: true }, null, 2));
  }
  close(): void { this.db.close(); }
  devices(): DeviceInfo[] { return this.db.prepare('SELECT id,vault_id,name,revoked FROM devices').all() as unknown as DeviceInfo[]; }
  revoke(deviceId: string): void { assertId(deviceId); this.db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(deviceId); }
  health(): void { this.db.prepare('SELECT 1').get(); }
}
