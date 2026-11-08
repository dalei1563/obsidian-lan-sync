import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { id } from '../shared/protocol';

function startSignature(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'); return text.slice(text.lastIndexOf(')') + 2).split(/\s+/)[19]; } catch { return null; }
}
/** Best-effort single-process lock, including PID reuse after container restart.
 * Deployment supports one gateway replica per data volume, not shared-volume HA. */
export function processLock(file: string): () => void {
  const owner = { pid: process.pid, signature: startSignature(process.pid), instance: id() };
  if (existsSync(file)) {
    let previous: any;
    try { const raw = readFileSync(file, 'utf8'); previous = raw.trim().startsWith('{') ? JSON.parse(raw) : { pid: Number(raw) }; }
    catch { throw new Error('Server lock is invalid; inspect the gateway data directory.'); }
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Server lock is invalid.');
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (e: any) { if (e.code === 'ESRCH') alive = false; }
    if (alive && process.platform === 'linux' && previous.signature && startSignature(previous.pid) !== previous.signature) alive = false;
    // A legacy PID-only lock from the prior container's PID 1 cannot belong to
    // this newly starting CLI invocation. Normal live processes remain protected.
    if (alive && previous.pid === process.pid && !previous.signature && process.platform === 'linux') alive = false;
    if (alive) throw new Error('Gateway data directory is already in use; wait for the previous process to stop.');
    unlinkSync(file);
  }
  const serialized = JSON.stringify(owner); writeFileSync(file, serialized, { flag: 'wx', mode: 0o600 });
  return () => { if (existsSync(file) && readFileSync(file, 'utf8') === serialized) unlinkSync(file); };
}
