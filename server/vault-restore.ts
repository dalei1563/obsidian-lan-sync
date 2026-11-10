import { hash, pathsOverlap, SyncError, type FileState, type Revision, type Snapshot } from '../shared/protocol';
import { isExcluded } from '../shared/exclusions';

export interface VaultRestoreAction { fileId: string; before: Revision; target: Revision | null; predelete: boolean }
export interface VaultRestorePlan { point: string; fingerprint: string; actions: VaultRestoreAction[] }

function same(a: Revision, b: Revision | null): boolean {
  if (a.deleted && (!b || b.deleted)) return true;
  return !!b && a.deleted === b.deleted && a.path === b.path && a.hash === b.hash && a.size === b.size;
}
export function restoreFingerprint(snapshot: Snapshot): string {
  return hash(JSON.stringify({serverId: snapshot.serverId, rules: snapshot.excludedPaths ?? [], files: snapshot.files.map(f => [f.fileId, f.heads.map(h => h.id).sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))}));
}
export function planVaultRestore(point: string, snapshot: Snapshot, historical: FileState[]): VaultRestorePlan {
  const old = new Map(historical.map(f => [f.fileId, f]));
  const desired: {fileId: string; head: Revision}[] = [];
  for (const file of historical) {
    if (file.heads.some(h => isExcluded(h.path, snapshot.excludedPaths ?? []))) continue;
    if (file.heads.length !== 1) throw new SyncError('history_conflict', '所选时间点存在冲突，请先选择其他时间点', 409);
    if (!file.heads[0].deleted) desired.push({fileId: file.fileId, head: file.heads[0]});
  }
  for (const file of snapshot.files) if (file.heads.some(h => isExcluded(h.path, snapshot.excludedPaths ?? []))) {
    if (file.heads.some(h => !h.deleted && desired.some(d => d.fileId !== file.fileId && pathsOverlap(h.path, d.head.path)))) throw new SyncError('path_excluded', '历史路径被排除同步的文件占用，请先调整排除规则', 409);
  }
  const actions: VaultRestoreAction[] = [];
  for (const file of snapshot.files) {
    const previous = old.get(file.fileId);
    if (file.heads.some(h => isExcluded(h.path, snapshot.excludedPaths ?? [])) || previous?.heads.some(h => isExcluded(h.path, snapshot.excludedPaths ?? []))) continue;
    if (file.heads.length !== 1 || (previous && previous.heads.length !== 1)) throw new SyncError('history_conflict', '仓库存在冲突，请先处理冲突再整库恢复', 409);
    const before = file.heads[0], target = previous?.heads[0] ?? null;
    if (same(before, target)) continue;
    const predelete = !before.deleted && (!target || target.deleted);
    actions.push({fileId: file.fileId, before, target, predelete});
  }
  for (const file of historical) if (!snapshot.files.some(current => current.fileId === file.fileId)) throw new SyncError('history_missing', '当前仓库缺少历史文件，无法安全恢复', 409);
  // Never emit a temporary deletion for a file that must be live in the target.
  // A gateway crash must leave every already-committed change at its final state.
  for (const d of desired) for (const file of snapshot.files) {
    if (file.fileId === d.fileId) continue;
    const occupied = file.heads.some(h => !h.deleted && pathsOverlap(h.path, d.head.path));
    if (occupied && !actions.some(a => a.fileId === file.fileId && a.predelete)) throw new SyncError('restore_path_conflict', '历史路径被其他当前文件占用，请先处理文件重命名后重试', 409);
  }
  return {point, fingerprint: hash(JSON.stringify({point, current: restoreFingerprint(snapshot)})), actions};
}
