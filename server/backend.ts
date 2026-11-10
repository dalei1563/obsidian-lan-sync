import type { Changes, CommitResult, Cursor, FileState, PairResult, Revision, Snapshot } from '../shared/protocol';
import type { VaultSummary, ActivityPage } from '../shared/management';
export type Awaitable<T> = T | Promise<T>;
export interface DeviceInfo { id: string; vault_id: string; name: string; revoked: number }
export interface Backend {
  readonly serverId: string;
  readonly epoch: string;
  readonly kind: string;
  listVaults(): Awaitable<VaultSummary[]>;
  createVault(name: string): Awaitable<{ id: string; name: string }>;
  renameVault(vaultId: string, name: string): Awaitable<void>;
  archiveVault(vaultId: string): Awaitable<void>;
  setExclusions(vaultId: string, input: unknown): Awaitable<string[]>;
  activity(vaultId?: string, before?: string, limit?: number): Awaitable<ActivityPage>;
  createPair(name: string, vaultId?: string): Awaitable<{ code: string; vaultId: string; expires: number }>;
  pair(code: string, name: string, requestId?: string): Awaitable<PairResult>;
  authenticate(token: string): Awaitable<{ vaultId: string; deviceId: string }>;
  putObject(vaultId: string, sha: string, data: Buffer): Awaitable<void>;
  getObject(vaultId: string, sha: string): Awaitable<Buffer>;
  snapshot(vaultId: string): Awaitable<Snapshot>;
  changes(vaultId: string, after: Cursor, epoch: string): Awaitable<Changes>;
  commit(vaultId: string, input: unknown, deviceId: string, expectedHeads?: string[]): Awaitable<CommitResult>;
  known(vaultId: string, ids: unknown): Awaitable<string[]>;
  history(vaultId: string, fileId: string, before?: Cursor): Awaitable<{ seq: Cursor; revision: Revision; createdAt?: number | null }[]>;
  historyPoint(vaultId: string, revisionId: string): Awaitable<FileState[]>;
  devices(): Awaitable<DeviceInfo[]>;
  revoke(deviceId: string): Awaitable<void>;
  backup(destination: string): Awaitable<void>;
  health(): Awaitable<void>;
  close(): Awaitable<void>;
}
