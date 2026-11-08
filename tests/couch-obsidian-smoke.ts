// Manual end-to-end fixture: real CouchDB, generated installer, isolated Vault.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CouchStore } from '../server/couch-store';
import { makeServer } from '../server/http';
import { Distribution } from '../server/distribution';
import { encodeConnection } from '../shared/connection';
import { hash, id, Revision } from '../shared/protocol';

async function main() {
  const root = resolve('.test-runtime/couch-obsidian-smoke'); mkdirSync(root, { recursive: true });
  const config = JSON.parse(readFileSync('.test-runtime/couch-test.json', 'utf8'));
  const store = await CouchStore.open({ ...config, root: join(root, 'gateway'), database: 'lns_smoke_v030' });
  const connectionFile = join(root, 'connection.json');
  let c: any;
  if (existsSync(connectionFile)) c = JSON.parse(readFileSync(connectionFile, 'utf8'));
  else {
    const pair = await store.createPair('CouchDB Test Notes');
    const seed = await store.pair((await store.createPair('Test', pair.vaultId)).code, 'Fixture B');
    c = { vaultId: pair.vaultId, deviceId: seed.deviceId, connection: encodeConnection('http://127.0.0.1:27126', pair.code) };
    writeFileSync(connectionFile, JSON.stringify(c), { mode: 0o600 });
    const bytes = Buffer.from('\ufeff# 云端样本\r\nCouchDB 原始字节\r\n'); await store.putObject(c.vaultId, hash(bytes), bytes);
    const r: Revision = { id: id(), fileId: id(), parents: [], path: 'cloud.md', deleted: false, hash: hash(bytes), size: bytes.length, clientId: c.deviceId };
    await store.commit(c.vaultId, r, c.deviceId);
  }
  if (process.argv[2] === 'invite') {
    const pair = await store.createPair('Test', c.vaultId); c.connection = encodeConnection('http://127.0.0.1:27126', pair.code);
    writeFileSync(connectionFile, JSON.stringify(c), { mode: 0o600 }); await store.close(); return;
  }
  if (process.argv[2] === 'update') {
    const file = (await store.snapshot(c.vaultId)).files.find(f => f.heads.some(h => h.path === 'cloud.md'))!;
    const bytes = Buffer.from('\ufeff# 云端样本\r\n第二台设备的更新\r\n'); await store.putObject(c.vaultId, hash(bytes), bytes);
    await store.commit(c.vaultId, { id: id(), fileId: file.fileId, parents: file.heads.map(h => h.id), path: 'cloud.md', deleted: false, hash: hash(bytes), size: bytes.length, clientId: c.deviceId }, c.deviceId);
    await store.close(); return;
  }
  const server = makeServer(store, undefined, new Distribution(resolve('dist/distribution')));
  server.listen(27126, '127.0.0.1', () => console.log('CouchDB enrollment fixture ready: http://127.0.0.1:27126'));
  process.once('SIGINT', () => server.close(() => { void store.close(); }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
