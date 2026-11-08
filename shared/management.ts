import type { FileState, Revision } from './protocol';
import { assertId, SyncError } from './protocol';

export interface VaultSummary {
  id: string;
  name: string;
  createdAt: number | null;
  files: number;
  deletedFiles: number;
  conflicts: number;
  revisionCount: number;
  bytes: number;
  devices: number;
  excludedPaths: string[];
}
export interface ActivityItem {
  id: string;
  vaultId: string;
  vaultName: string;
  fileId: string;
  path: string;
  action: 'create' | 'update' | 'rename' | 'delete' | 'resolve';
  deviceId: string;
  deviceName: string;
  bytes: number;
  createdAt: number | null;
}
export interface ActivityPage { items: ActivityItem[]; nextCursor: string | null }

export function managementName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new SyncError('invalid_name', '仓库名称不能为空，最多 100 个字符', 400);
  return value.trim();
}
export function activityLimit(value = 50): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new SyncError('invalid_limit', '每页记录数量必须为 1 到 100', 400);
  return value;
}
export function activityId(vaultId: string, revisionId: string): string { return vaultId + ':' + revisionId; }
export function parseActivityCursor(value: string): [string, string] {
  const parts = value.split(':');
  if (parts.length !== 2) throw new SyncError('invalid_cursor', '变更记录游标无效，请重新加载', 400);
  assertId(parts[0]); assertId(parts[1]); return [parts[0], parts[1]];
}

export function summarizeFiles(files: FileState[]): Pick<VaultSummary, 'files' | 'deletedFiles' | 'conflicts' | 'bytes'> {
  let live = 0, deletedFiles = 0, conflicts = 0, bytes = 0;
  for (const file of files) {
    if (file.heads.length > 1) conflicts++;
    if (file.heads.every(h => h.deleted)) deletedFiles++;
    else {
      live++;
      // Conflicting live heads are retained data too; deduplicate identical
      // content within this logical file when estimating current-body bytes.
      const seen = new Set<string>();
      for (const h of file.heads) if (!h.deleted && h.hash && !seen.has(h.hash)) { seen.add(h.hash); bytes += h.size; }
    }
  }
  return { files: live, deletedFiles, conflicts, bytes };
}
export function revisionAction(revision: Revision, parent: (id: string) => Revision | undefined): ActivityItem['action'] {
  if (revision.parents.length > 1) return 'resolve';
  if (revision.deleted) return 'delete';
  if (!revision.parents.length) return 'create';
  if (revision.parents.some(id => { const p = parent(id); return p && p.path !== revision.path; })) return 'rename';
  return 'update';
}
