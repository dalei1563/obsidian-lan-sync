// Manual real-Obsidian fixture. Only touches .test-runtime/obsidian-smoke.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../server/store';
import { makeServer } from '../server/http';
import { hash, id, Revision } from '../shared/protocol';

const root = resolve('.test-runtime/obsidian-smoke'); mkdirSync(root, { recursive: true });
const command = process.argv[2], store = new Store(join(root, 'server-data'), command === 'serve');
const connectionPath = join(root, 'connection.json');
function change(vaultId: string, deviceId: string, path: string, text: string | null): void {
  const file = store.snapshot(vaultId).files.find(f => f.heads.some(h => h.path === path));
  const data = text === null ? null : Buffer.from(text);
  if (data !== null) store.putObject(vaultId, hash(data), data);
  const revision: Revision = { id: id(), fileId: file?.fileId ?? id(), parents: file?.heads.map(h => h.id) ?? [], path,
    deleted: data === null, hash: data === null ? null : hash(data), size: data?.length ?? 0, clientId: deviceId };
  store.commit(vaultId, revision, deviceId);
}
if (command === 'serve') {
  if (!existsSync(connectionPath)) {
    const pair = store.createPair('LAN Smoke Test');
    const seed = store.pair(store.createPair('LAN Smoke Test', pair.vaultId).code, 'Fixture B');
    writeFileSync(connectionPath, JSON.stringify({ pairCode: pair.code, vaultId: pair.vaultId, seedDeviceId: seed.deviceId }), { mode: 0o600 });
    change(pair.vaultId, seed.deviceId, 'remote.md', '# 来自设备 B\n初始内容\n');
    change(pair.vaultId, seed.deviceId, 'bom.md', '\ufeff---\r\n标题: 中文\r\n---\r\n第一版\r\n');
    change(pair.vaultId, seed.deviceId, 'empty.md', '');
  }
  const server = makeServer(store); server.listen(27124, '127.0.0.1', () => console.log('Isolated smoke server: http://127.0.0.1:27124'));
  process.once('SIGINT', () => server.close(() => { store.close(); }));
} else {
  const c = JSON.parse(readFileSync(connectionPath, 'utf8'));
  if (command === 'update') {
    change(c.vaultId, c.seedDeviceId, 'remote.md', '# 来自设备 B\n更新后的内容\n');
    change(c.vaultId, c.seedDeviceId, 'bom.md', '\ufeff---\r\n标题: 中文\r\n---\r\n第二版\r\n');
  } else if (command === 'update-open') change(c.vaultId, c.seedDeviceId, 'remote.md', '# 来自设备 B\n打开编辑器时的远端更新\n');
  else if (command === 'update-conflict') change(c.vaultId, c.seedDeviceId, 'remote.md', '# 来自设备 B\n并发修改 B\n');
  else if (command === 'delete') change(c.vaultId, c.seedDeviceId, 'empty.md', null);
  else if (command === 'summary') console.log(JSON.stringify(store.snapshot(c.vaultId).files.map(f => ({ path: f.heads[0].path, heads: f.heads.length, hash: f.heads[0].hash, deleted: f.heads[0].deleted })), null, 2));
  else throw new Error('Unknown fixture command');
  store.close();
}
