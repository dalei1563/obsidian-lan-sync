import { createHash, randomUUID } from 'node:crypto';

export const PROTOCOL = 2;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 10000;
export const id = () => randomUUID();
export const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
export type Cursor = number | string;
export const validCursor = (value: unknown): value is Cursor =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
  (typeof value === 'string' && value.length > 0 && value.length <= 2048);

export class SyncError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

export interface Revision {
  id: string;
  fileId: string;
  parents: string[];
  path: string;
  deleted: boolean;
  hash: string | null;
  size: number;
  clientId: string;
}
export interface FileState { fileId: string; heads: Revision[] }
export interface Snapshot {
  protocol: number;
  serverId: string;
  epoch: string;
  cursor: Cursor;
  files: FileState[];
  excludedPaths?: string[];
}
export interface Changes {
  serverId: string;
  epoch: string;
  cursor: Cursor;
  more: boolean;
  changes: { seq: Cursor; file: FileState }[];
  excludedPaths?: string[];
}
export interface CommitResult { revision: Revision; file: FileState; seq: Cursor }
export interface PairResult { token: string; deviceId: string; vaultId: string; vaultName: string; serverId: string }

export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value) && !Object.prototype.hasOwnProperty.call(Object.prototype, value);
}
export function assertId(value: unknown): asserts value is string {
  if (!validId(value)) throw new SyncError('invalid_id', '标识无效', 400);
}
export function assertHash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new SyncError('invalid_hash', '内容哈希无效', 400);
}
export function validatePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || value !== value.normalize('NFC') || !value.endsWith('.md')) {
    throw new SyncError('invalid_path', '仅支持 NFC 格式的相对 .md 路径（最长 512 字符）', 400);
  }
  const segments = value.split('/');
  if (segments.some(s => !s || s.startsWith('.') || s !== s.trim() || /[. ]$/.test(s) ||
    /[\\<>:"|?*\x00-\x1f\x7f]/.test(s) || s.length > 200 ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s))) {
    throw new SyncError('invalid_path', '路径包含隐藏目录、保留名称或非法字符', 400);
  }
  return value;
}
export const pathKey = (path: string) => path.normalize('NFC').toLowerCase();
export function pathsOverlap(a: string, b: string): boolean {
  const x = pathKey(a), y = pathKey(b);
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}
export function validateRevision(input: unknown): Revision {
  const r = input as Revision;
  if (!r || typeof r !== 'object') throw new SyncError('invalid_revision', '修订无效', 400);
  assertId(r.id); assertId(r.fileId); assertId(r.clientId); validatePath(r.path);
  if (!Array.isArray(r.parents) || r.parents.length > 32 || new Set(r.parents).size !== r.parents.length) {
    throw new SyncError('invalid_parents', '父修订列表无效', 400);
  }
  r.parents.forEach(assertId);
  if (r.parents.includes(r.id) || typeof r.deleted !== 'boolean' || !Number.isInteger(r.size) || r.size < 0 || r.size > MAX_BYTES) {
    throw new SyncError('invalid_revision', '修订字段无效', 400);
  }
  if (r.deleted) {
    if (r.hash !== null || r.size !== 0) throw new SyncError('invalid_delete', '删除修订不能包含正文', 400);
  } else assertHash(r.hash);
  // Canonical shape: no caller-controlled extra properties in idempotency comparisons.
  return { id: r.id, fileId: r.fileId, parents: [...r.parents].sort(), path: r.path,
    deleted: r.deleted, hash: r.hash, size: r.size, clientId: r.clientId };
}
