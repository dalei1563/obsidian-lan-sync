import { hash, pathKey, type Revision, type NodeKind, type Snapshot } from '../../shared/protocol';

export type OverwriteMode = 'cloud-to-local' | 'local-to-cloud';
export interface OverwriteAction {
  type: 'upload' | 'download' | 'delete-local' | 'delete-cloud';
  path: string;
  kind?: NodeKind;
  localKind?: NodeKind;
  localHash: string | null;
  remote: Revision | null;
}
export interface OverwritePlan {
  mode: OverwriteMode;
  local: number;
  cloud: number;
  unchanged: number;
  actions: OverwriteAction[];
  fingerprint: string;
}

/** A read-only plan. Excluded paths are outside the scope of reconciliation. */
export function planOverwrite(mode: OverwriteMode, local: Map<string, Buffer>, snapshot: Snapshot, excluded: (path: string) => boolean, kindOf: (path: string) => NodeKind = () => 'file'): OverwritePlan {
  if (mode !== 'cloud-to-local' && mode !== 'local-to-cloud') throw new Error('覆盖方向无效');
  const locals = new Map<string, {path: string; hash: string; kind: NodeKind}>();
  for (const [path, bytes] of local) {
    if (excluded(path)) continue;
    const key = pathKey(path); if (locals.has(key)) throw new Error(`本地路径大小写冲突：${path}`);
    locals.set(key, {path, hash: hash(bytes), kind: kindOf(path)});
  }
  const clouds = new Map<string, Revision>();
  for (const file of snapshot.files) {
    if (file.heads.some(h => excluded(h.path))) continue;
    if (file.heads.length !== 1) throw new Error('云端存在多个冲突版本，请先在客户端处理冲突，再执行覆盖');
    const head = file.heads[0]; if (head.deleted) continue;
    const key = pathKey(head.path); if (clouds.has(key)) throw new Error(`云端存在重复路径：${head.path}`);
    clouds.set(key, head);
  }
  const actions: OverwriteAction[] = []; let unchanged = 0;
  const descendant = (paths: string[], path: string) => paths.some(p => pathKey(p).startsWith(pathKey(path) + '/'));
  for (const [key, item] of locals) {
    const remote = clouds.get(key), remoteKind = remote?.kind ?? 'file';
    if (!remote && item.kind === 'directory' && mode === 'cloud-to-local' && descendant([...clouds.values()].map(r => r.path), item.path)) { unchanged++; continue; }
    if (remote && remote.path === item.path && remoteKind === item.kind && remote.hash === item.hash) { unchanged++; continue; }
    const replacement = remote && (remoteKind !== item.kind || remote.path !== item.path);
    if (replacement) {
      if (mode === 'cloud-to-local') {
        actions.push({type: 'delete-local', path: item.path, localHash: item.hash, localKind: item.kind, kind: item.kind, remote: null});
        actions.push({type: 'download', path: remote.path, localHash: null, kind: remoteKind, remote});
      } else {
        actions.push({type: 'delete-cloud', path: remote.path, localHash: null, kind: remoteKind, remote});
        actions.push({type: 'upload', path: item.path, localHash: item.hash, localKind: item.kind, kind: item.kind, remote: null});
      }
    } else if (mode === 'local-to-cloud') actions.push({type: 'upload', path: item.path, localHash: item.hash, localKind: item.kind, kind: item.kind, remote: remote ?? null});
    else if (remote) actions.push({type: 'download', path: remote.path, localHash: item.hash, localKind: item.kind, kind: remoteKind, remote});
    else actions.push({type: 'delete-local', path: item.path, localHash: item.hash, localKind: item.kind, kind: item.kind, remote: null});
  }
  for (const [key, remote] of clouds) if (!locals.has(key)) {
    if (remote.kind === 'directory' && mode === 'local-to-cloud' && descendant([...locals.values()].map(r => r.path), remote.path)) { unchanged++; continue; }
    actions.push({type: mode === 'cloud-to-local' ? 'download' : 'delete-cloud', path: remote.path, localHash: null, kind: remote.kind ?? 'file', remote});
  }
  // Delete children before parents, then create parents before children.
  actions.sort((a, b) => {
    const da = a.type.startsWith('delete-'), db = b.type.startsWith('delete-');
    return Number(!da) - Number(!db) || (da ? b.path.split('/').length - a.path.split('/').length : a.path.split('/').length - b.path.split('/').length) || a.path.localeCompare(b.path);
  });
  const fingerprint = hash(JSON.stringify({mode, serverId: snapshot.serverId, epoch: snapshot.epoch, cursor: snapshot.cursor,
    local: [...locals].sort(([a], [b]) => a.localeCompare(b)), cloud: [...clouds].sort(([a], [b]) => a.localeCompare(b))}));
  return {mode, local: locals.size, cloud: clouds.size, unchanged, actions, fingerprint};
}
