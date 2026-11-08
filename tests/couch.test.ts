import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { CouchStore, CouchOptions } from '../server/couch-store';
import { makeServer } from '../server/http';
import { Remote } from '../src/sync/remote';
import { client, transport, revision } from './helpers';
import { hash, id } from '../shared/protocol';
import { spawn } from 'node:child_process';
import { decodeConnection } from '../shared/connection';

const configFile = process.env.COUCH_TEST_CONFIG;
const real = { skip: !configFile, timeout: 60000 };
async function couchFixture(t: TestContext) {
  const config = JSON.parse(readFileSync(configFile!, 'utf8'));
  const runtime = resolve('.test-runtime'), root = join(runtime, 'couch-' + id()); mkdirSync(root, { recursive: true });
  const options: CouchOptions = { url: config.url, user: config.user, password: config.password, database: 'lnstest_' + id().replace(/-/g, ''), root: join(root, 'gateway') };
  const store = await CouchStore.open(options), server = makeServer(store);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const first = await store.pair((await store.createPair('Test')).code, 'A');
  const second = await store.pair((await store.createPair('Test', first.vaultId)).code, 'B');
  t.after(async () => {
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); await store.close();
    if (!/^lnstest_[a-f0-9]{32}$/.test(options.database)) throw new Error('Unsafe test database cleanup');
    const result = await fetch(options.url + '/' + options.database, { method: 'DELETE', headers: { Authorization: 'Basic ' + Buffer.from(options.user + ':' + options.password).toString('base64') } });
    assert.equal(result.ok, true);
    if (!root.startsWith(runtime + sep)) throw new Error('Unsafe local cleanup'); rmSync(root, { recursive: true, force: true });
  });
  return { root, options, store, first, second, url, remoteA: new Remote(url, first.vaultId, first.token, transport), remoteB: new Remote(url, second.vaultId, second.token, transport) };
}
test('real CouchDB: pairing retries with the same claim are idempotent, other claims denied, and revoke works', real, async t => {
  const f = await couchFixture(t), p = await f.store.createPair('Test', f.first.vaultId), claim = id();
  const a = await f.store.pair(p.code, 'C', claim), b = await f.store.pair(p.code, 'C', claim); assert.deepEqual(a, b);
  await assert.rejects(f.store.pair(p.code, 'D', id()), /其他设备/);
  await f.store.revoke(a.deviceId); await assert.rejects(f.store.authenticate(a.token), /撤销/);
  const foreign = await f.store.pair((await f.store.createPair('Other')).code, 'Other');
  const response = await transport(f.url + `/v1/vaults/${foreign.vaultId}/state`, 'GET', { Authorization: 'Bearer ' + f.first.token }); assert.equal(response.status, 403);
});
test('real CouchDB: two engines round-trip BOM, CRLF and empty attachments using opaque cursors', real, async t => {
  const f = await couchFixture(t), a = client(f.remoteA, f.store.serverId, f.first.deviceId), b = client(f.remoteB, f.store.serverId, f.second.deviceId);
  a.local.set('中文.md', '\ufeff---\r\n标题: 测试\r\n---\r\n[[双链]]\r\n'); a.local.set('empty.md', Buffer.alloc(0));
  await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  assert.deepEqual(a.local.files, b.local.files); assert.equal(typeof a.engine.state.cursor, 'string');
  b.local.set('中文.md', 'B changed'); await b.engine.sync(); await a.engine.sync(); assert.equal(a.local.text('中文.md'), 'B changed');
  const state = await f.store.snapshot(f.first.vaultId), reopened = await CouchStore.open(f.options);
  try { assert.equal(reopened.serverId, f.store.serverId); assert.deepEqual((await reopened.snapshot(f.first.vaultId)).files, state.files); }
  finally { await reopened.close(); }
});
test('real CouchDB: concurrent edits are retained and lost resolution response recovers after client restart', real, async t => {
  const f = await couchFixture(t), a = client(f.remoteA, f.store.serverId, f.first.deviceId), b = client(f.remoteB, f.store.serverId, f.second.deviceId);
  a.local.set('note.md', 'base'); await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  a.local.set('note.md', 'A'); b.local.set('note.md', 'B'); await a.engine.sync(); await b.engine.sync();
  const file = (await f.store.snapshot(f.first.vaultId)).files[0]; assert.equal(file.heads.length, 2);
  const selected = file.heads.find(r => r.clientId === f.first.deviceId)!; let lose = true;
  const flaky = new Remote(f.url, f.first.vaultId, f.second.token, async (...args) => { const r = await transport(...args); if (args[0].endsWith('/commits') && lose) { lose = false; throw new Error('Lost response'); } return r; });
  const resolving = client(flaky, f.store.serverId, f.second.deviceId, b.local, b.saved);
  await assert.rejects(resolving.engine.resolve(file.fileId, selected), /Lost response/);
  const restart = client(f.remoteB, f.store.serverId, f.second.deviceId, b.local, resolving.saved); await restart.engine.sync();
  assert.equal(b.local.text('note.md'), 'A'); assert.equal((await f.store.snapshot(f.first.vaultId)).files[0].heads.length, 1);
});
test('real CouchDB: immutable business history survives compaction, and export verifies referenced objects', real, async t => {
  const f = await couchFixture(t), bytes = Buffer.from('history'); await f.remoteA.put(bytes, hash(bytes));
  let r = revision(f.first.deviceId, bytes); await f.remoteA.commit(r);
  for (let n = 0; n < 5; n++) { r = revision(f.first.deviceId, bytes, { fileId: r.fileId, parents: [r.id] }); await f.remoteA.commit(r); }
  const headers = { Authorization: 'Basic ' + Buffer.from(f.options.user + ':' + f.options.password).toString('base64'), 'Content-Type': 'application/json' };
  const response = await fetch(f.options.url + '/' + f.options.database + '/_compact', { method: 'POST', headers }); assert.equal(response.status, 202);
  for (let attempt = 0; attempt < 30; attempt++) {
    const info = await (await fetch(f.options.url + '/' + f.options.database, { headers })).json() as any;
    if (!info.compact_running) break;
    await new Promise(done => setTimeout(done, 100));
  }
  const reopened = await CouchStore.open(f.options);
  try { assert.equal((await reopened.history(f.first.vaultId, r.fileId)).length, 6); } finally { await reopened.close(); }
  const backup = join(f.root, 'backup'); await f.store.backup(backup);
  assert.equal(JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8')).complete, true); assert.equal(existsSync(join(backup, 'couchdb.jsonl')), true);
});
test('real CouchDB: a second independent gateway volume cannot write to the same database', real, async t => {
  const f = await couchFixture(t);
  await assert.rejects(CouchStore.open({ ...f.options, root: join(f.root, 'unrelated-gateway') }), /另一套网关/);
});
test('real CouchDB: multi-page changes, revision deduplication, parent checks and path conflicts', real, async t => {
  const f = await couchFixture(t), bytes = Buffer.from('x'); await f.remoteA.put(bytes, hash(bytes));
  let r = revision(f.first.deviceId, bytes); let firstResult;
  for (let n = 0; n < 105; n++) { if (n) r = revision(f.first.deviceId, bytes, { fileId: r.fileId, parents: [r.id] }); const result = await f.store.commit(f.first.vaultId, r, f.first.deviceId); if (!n) firstResult = result; }
  const again = await f.store.commit(f.first.vaultId, firstResult!.revision, f.first.deviceId); assert.equal(again.seq, firstResult!.seq);
  const snapshot = await f.store.snapshot(f.first.vaultId), page = await f.store.changes(f.first.vaultId, 0, snapshot.epoch); assert.equal(page.more, true);
  const next = await f.store.changes(f.first.vaultId, page.cursor, snapshot.epoch); assert.equal(next.more, false);
  await assert.rejects(f.remoteA.commit(revision(f.first.deviceId, bytes)), /路径/);
  await assert.rejects(f.remoteA.commit(revision(f.first.deviceId, bytes, { path: 'other.md', parents: [id()] })), /父修订/);
});
test('real CouchDB: repeated invite commands reuse the default Vault and generate install commands for both desktops', real, async t => {
  const f = await couchFixture(t);
  async function invite(): Promise<string> {
    return new Promise((done, fail) => {
      const p = spawn(process.execPath, ['dist/server/cli.cjs', 'invite', '--data', f.options.root, '--url', f.url], {
        env: { ...process.env, SYNC_BACKEND: 'couchdb', COUCHDB_URL: f.options.url, COUCHDB_USER: f.options.user, COUCHDB_PASSWORD: f.options.password, COUCHDB_DATABASE: f.options.database }, windowsHide: true, timeout: 15000,
      });
      let output = '', error = ''; p.stdout.on('data', b => { output += b; }); p.stderr.on('data', b => { error += b; }); p.on('error', fail); p.on('close', code => code === 0 ? done(output) : fail(new Error(error)));
    });
  }
  const first = await invite(), second = await invite();
  const vault = (text: string) => /^Vault: (.+)$/m.exec(text)![1].trim(); assert.equal(vault(first), vault(second));
  const connection = /^lansync:.+$/m.exec(first)![0].trim(); assert.equal(decodeConnection(connection).server, f.url);
  assert.match(first, /Windows/); assert.match(first, /macOS/); assert.match(first, /--noproxy/);
});
