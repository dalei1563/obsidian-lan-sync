import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from '../../shared/protocol';
import type { Remote } from './remote';
import type { SyncState } from './engine';

export interface StorageReport { history: number; snapshots: number; pending: number; trash: number }
export function storageWarnings(report: StorageReport, thresholdMiB: number): (keyof StorageReport)[] {
  if (!Number.isFinite(thresholdMiB) || thresholdMiB <= 0) return [];
  return (Object.keys(report) as (keyof StorageReport)[]).filter(key => report[key] >= thresholdMiB * 1048576);
}
export function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('容量统计目录包含链接，已停止统计');
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error('容量统计遇到不支持的文件类型');
  return readdirSync(path).reduce((sum, entry) => sum + directoryBytes(join(path, entry)), 0);
}
export async function storageReport(remote: Remote, state: SyncState, snapshots: string, trash: string): Promise<StorageReport> {
  const snapshot = await remote.snapshot();
  if (snapshot.serverId !== state.serverId) throw new Error('服务端身份已变化，无法统计历史');
  const objects = new Map<string, number>(); let seen = 0;
  for (const file of snapshot.files) {
    let before: string | number | undefined;
    for (;;) {
      const page = await remote.history(file.fileId, before);
      for (const item of page) {
        if (item.revision.fileId !== file.fileId) throw new Error('历史文件身份不匹配');
        const r = item.revision;
        if (r.hash !== null) {
          if (objects.has(r.hash) && objects.get(r.hash) !== r.size) throw new Error('历史对象大小不一致');
          objects.set(r.hash, r.size);
        }
      }
      seen += page.length; if (seen > 100000) throw new Error('历史过多，统计已暂停；请联系管理员');
      if (page.length < 100) break;
      const next = page[page.length - 1].seq;
      if (next === before) throw new Error('历史分页未前进');
      before = next;
    }
  }
  let pending = 0;
  for (const item of state.pending) if (item.content !== null) {
    const data = Buffer.from(item.content, 'base64');
    if (hash(data) !== item.revision.hash) throw new Error('待上传快照损坏，无法统计');
    pending += data.length;
  }
  return { history: [...objects.values()].reduce((a, b) => a + b, 0), snapshots: directoryBytes(snapshots), pending, trash: directoryBytes(trash) };
}
export function storageGrowth(previous: { at: number; report: StorageReport } | undefined, current: StorageReport, now: number): StorageReport | null {
  if (!previous || !Number.isFinite(previous.at) || now <= previous.at || !previous.report ||
    !(['history', 'snapshots', 'pending', 'trash'] as const).every(key => Number.isFinite(previous.report[key]) && previous.report[key] >= 0)) return null;
  const scale = 86400000 / (now - previous.at);
  return {history: (current.history - previous.report.history) * scale, snapshots: (current.snapshots - previous.report.snapshots) * scale,
    pending: (current.pending - previous.report.pending) * scale, trash: (current.trash - previous.report.trash) * scale};
}
