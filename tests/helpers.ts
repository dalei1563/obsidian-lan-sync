import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { TestContext } from 'node:test';
import { AddressInfo } from 'node:net';
import { Store } from '../server/store';
import { makeServer } from '../server/http';
import type { Distribution } from '../server/distribution';
import { ApplyRequest, Engine, LocalVault, newState, SyncState } from '../src/sync/engine';
import { Remote, Transport } from '../src/sync/remote';
import { hash, id, Revision } from '../shared/protocol';

export const transport: Transport = async (url, method, headers, body) => {
  const response = await fetch(url, { method, headers, body: body ? Uint8Array.from(body) : undefined, signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
};
export async function fixture(t: TestContext, distribution?: Distribution) {
  const runtime = resolve('.test-runtime'); mkdirSync(runtime, { recursive: true });
  const root = join(runtime, 'test-' + id()); mkdirSync(root);
  const store = new Store(join(root, 'data'), true), server = makeServer(store, undefined, distribution);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const pair = store.createPair('Test');
  const first = store.pair(pair.code, 'A');
  const second = store.pair(store.createPair('Test', first.vaultId).code, 'B');
  const remoteA = new Remote(url, first.vaultId, first.token, transport), remoteB = new Remote(url, second.vaultId, second.token, transport);
  t.after(async () => {
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); store.close();
    const checked = resolve(root);
    if (!checked.startsWith(runtime + sep)) throw new Error('Unsafe test cleanup target');
    rmSync(checked, { recursive: true, force: true });
  });
  return { root, store, server, url, first, second, remoteA, remoteB };
}
export class MemoryVault implements LocalVault {
  files = new Map<string, Buffer>();
  preserved: Buffer[] = [];
  trash: Buffer[] = [];
  beforeApply?: () => void;
  async scan() { return new Map([...this.files].map(([p, b]) => [p, Buffer.from(b)])); }
  async read(path: string) { const d = this.files.get(path); return d ? Buffer.from(d) : null; }
  async preserve(data: Buffer) { this.preserved.push(Buffer.from(data)); }
  async apply(r: ApplyRequest) {
    this.beforeApply?.();
    const current = this.files.get(r.oldPath);
    if ((current ? hash(current) : null) !== r.expectedHash) throw new Error('Local changed during download');
    if (r.path !== r.oldPath && this.files.has(r.path)) throw new Error('Target occupied');
    if (current) { this.preserved.push(Buffer.from(current)); this.trash.push(Buffer.from(current)); }
    this.files.delete(r.oldPath);
    if (r.content !== null) this.files.set(r.path, Buffer.from(r.content));
  }
  set(path: string, text: string | Buffer) { this.files.set(path, Buffer.from(text)); }
  text(path: string) { return this.files.get(path)?.toString('utf8'); }
}
export function client(remote: Remote, serverId: string, clientId: string, local = new MemoryVault(), existing?: SyncState) {
  let saved: SyncState | undefined = existing && structuredClone(existing);
  let failSave: ((s: SyncState) => boolean) | undefined;
  const state = existing ? structuredClone(existing) : newState(serverId, remote.vaultId, clientId);
  const engine = new Engine(remote, local, state, async s => {
    if (failSave?.(s)) throw new Error('Injected disk failure');
    saved = structuredClone(s);
  });
  return { engine, local, get saved() { return saved!; }, set failSave(value: typeof failSave) { failSave = value; } };
}
export function revision(clientId: string, data: Buffer | null, overrides: Partial<Revision> = {}): Revision {
  return { id: id(), fileId: id(), parents: [], path: 'note.md', deleted: data === null, hash: data === null ? null : hash(data), size: data?.length ?? 0, clientId, ...overrides };
}
