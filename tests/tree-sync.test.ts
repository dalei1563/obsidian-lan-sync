import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fixture as sqliteFixture, client, MemoryVault, revision, transport } from './helpers';
import { hash, id, type Revision } from '../shared/protocol';

import { CouchStore, CouchOptions } from '../server/couch-store';
import { makeServer } from '../server/http';
import { Remote } from '../src/sync/remote';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
async function fixture(t: TestContext) {
  if (!process.env.COUCH_TEST_CONFIG) return sqliteFixture(t);
  const config = JSON.parse(readFileSync(process.env.COUCH_TEST_CONFIG, 'utf8'));
  const base = resolve('.test-runtime'), root = join(base, 'tree-' + id()); mkdirSync(root, {recursive: true});
  const options: CouchOptions = {...config, root, database: 'lnstest_' + id().replace(/-/g, '')};
  const store = await CouchStore.open(options), server = makeServer(store);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const first = await store.pair((await store.createPair('Tree')).code, 'A');
  const second = await store.pair((await store.createPair('Tree', first.vaultId)).code, 'B');
  t.after(async () => {
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); await store.close();
    if (!/^lnstest_[a-f0-9]{32}$/.test(options.database) || !root.startsWith(base + sep)) throw Error('Unsafe cleanup');
    const deleted = await fetch(options.url + '/' + options.database, {method: 'DELETE', headers: {Authorization: 'Basic ' + Buffer.from(options.user + ':' + options.password).toString('base64')}}); assert.ok(deleted.ok);
    rmSync(root, {recursive: true, force: true});
  });
  return {root, store, server, url, first, second, remoteA: new Remote(url, first.vaultId, first.token, transport), remoteB: new Remote(url, second.vaultId, second.token, transport)};
}

function tree() { const v = new MemoryVault(); v.tree = true; return v; }
function shape(v: MemoryVault) { return [...v.files].map(([p,b]) => [p, v.kind(p), hash(b)]).sort(); }
async function cloud(f: Awaited<ReturnType<typeof fixture>>) {
  return (await f.remoteA.snapshot()).files.flatMap(f => f.heads.filter(h => !h.deleted).map(h => [h.path, h.kind ?? 'file', h.hash])).sort();
}
async function seed(f: Awaited<ReturnType<typeof fixture>>, path: string, bytes: Buffer, kind?: 'directory') {
  const r = revision(f.second.deviceId, bytes, {path, ...(kind ? {kind} : {})});
  await f.remoteB.put(bytes, r.hash!); await f.remoteB.commit(r); return r;
}
for (const mode of ['cloud-to-local', 'local-to-cloud'] as const) {
  test(`${mode}: mirrors files, binary bytes, nested and empty directories, and type/case replacements`, async t => {
    const f = await fixture(t), local = tree(), c = client(f.remoteA, f.store.serverId, f.first.deviceId, local);
    const bytes = Buffer.from([0,255,128,13,10,1]);
    local.mkdir('empty/nested'); local.set('attachments/photo.png', bytes); local.set('slot', 'local file'); local.mkdir('other'); local.set('other/note.md', 'note'); local.set('Case.txt','same');
    await seed(f, 'slot', Buffer.alloc(0), 'directory'); await seed(f, 'slot/child', Buffer.alloc(0), 'directory');
    await seed(f, 'other', bytes); await seed(f, 'case.txt', Buffer.from('same')); await seed(f, 'cloud-empty', Buffer.alloc(0), 'directory'); await seed(f, 'cloud.pdf', bytes);
    const expected = mode === 'local-to-cloud' ? shape(local) : await cloud(f);
    const plan = await c.engine.previewOverwrite(mode);
    assert.ok(plan.actions.some(a => a.kind === 'directory'));
    await c.engine.startOverwrite(plan);
    assert.deepEqual(shape(local), expected); assert.deepEqual(await cloud(f), expected);
    await c.engine.sync(); assert.deepEqual(c.engine.state.issues, {}); assert.equal(c.engine.state.pending.length, 0);
    assert.deepEqual(await cloud(f), expected);
    const second = client(f.remoteB, f.store.serverId, f.second.deviceId, tree());
    await second.engine.initialize(); await second.engine.sync();
    assert.deepEqual(shape(second.local), expected); assert.deepEqual(second.engine.state.issues, {});
  });
}
test('empty cloud removes all local empty directories, deepest first', async t => {
  const f = await fixture(t), local = tree(), c = client(f.remoteA, f.store.serverId, f.first.deviceId, local);
  local.mkdir('空文件夹/第二层/第三层'); local.mkdir('另一个空文件夹');
  const plan = await c.engine.previewOverwrite('cloud-to-local'); assert.equal(plan.actions.length, 4);
  await c.engine.startOverwrite(plan); assert.equal(local.files.size, 0); assert.equal(local.directories.size, 0);
});
test('empty local deletes all remote files and directories while retaining history', async t => {
  const f = await fixture(t), local = tree(), c = client(f.remoteA, f.store.serverId, f.first.deviceId, local);
  await seed(f, 'empty', Buffer.alloc(0), 'directory'); const file = await seed(f, 'empty/file.bin', Buffer.from([255]));
  await c.engine.startOverwrite(await c.engine.previewOverwrite('local-to-cloud'));
  assert.deepEqual(await cloud(f), []); assert.equal((await f.store.history(f.first.vaultId, file.fileId)).length, 2);
});
test('directory contents created after preview block deletion and remain intact', async t => {
  const f = await fixture(t), local = tree(), c = client(f.remoteA, f.store.serverId, f.first.deviceId, local);
  local.mkdir('folder'); const plan = await c.engine.previewOverwrite('cloud-to-local');
  local.beforeApply = () => local.set('folder/new.txt','new');
  await assert.rejects(c.engine.startOverwrite(plan), /Directory not empty/);
  assert.equal(local.text('folder/new.txt'), 'new'); assert.equal(local.kind('folder'), 'directory');
});
test('same-byte file-to-folder change invalidates a prepared preview', async t => {
  const f = await fixture(t), local = tree(), c = client(f.remoteA, f.store.serverId, f.first.deviceId, local);
  local.set('empty', Buffer.alloc(0)); const plan = await c.engine.previewOverwrite('local-to-cloud'); local.mkdir('empty');
  await assert.rejects(c.engine.startOverwrite(plan), /重新预览/); assert.deepEqual(await cloud(f), []);
});
test('remote exclusions protect parent directories and their excluded contents', async t => {
  const f = await fixture(t), local = tree(), c = client(f.remoteA, f.store.serverId, f.first.deviceId, local);
  await seed(f, 'private-parent', Buffer.alloc(0), 'directory'); await seed(f, 'private-parent/keep.txt', Buffer.from('keep'));
  await f.store.setExclusions(f.first.vaultId, ['**/keep.txt']);
  const plan = await c.engine.previewOverwrite('local-to-cloud'); assert.equal(plan.actions.length, 0);
  await c.engine.startOverwrite(plan); assert.equal((await cloud(f)).length, 2);
});
test('normal sync tracks directory rename and empty-directory deletion', async t => {
  const f = await fixture(t), a = client(f.remoteA, f.store.serverId, f.first.deviceId, tree()), b = client(f.remoteB, f.store.serverId, f.second.deviceId, tree());
  a.local.mkdir('old/empty'); a.local.set('old/file.bin', Buffer.from([255,0,8]));
  await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  for (const [p, bytes] of [...a.local.files]) {
    const next = p.replace(/^old/, 'new'); if (a.local.kind(p) === 'directory') a.local.mkdir(next); else a.local.set(next, bytes);
    a.local.files.delete(p); a.local.directories.delete(p);
  }
  await a.engine.noteRename('old', 'new'); await a.engine.sync(); await b.engine.sync();
  assert.deepEqual(b.engine.state.issues, {}); assert.deepEqual(shape(a.local), shape(b.local));
  a.local.files.delete('new/empty'); a.local.directories.delete('new/empty'); await a.engine.sync(); await b.engine.sync();
  assert.deepEqual(shape(a.local), shape(b.local)); assert.deepEqual(b.engine.state.issues, {});
});
test('a device that knew the old identity does not resurrect it after type replacement', async t => {
  const f = await fixture(t), a = client(f.remoteA, f.store.serverId, f.first.deviceId, tree()), b = client(f.remoteB, f.store.serverId, f.second.deviceId, tree());
  a.local.set('item', Buffer.alloc(0)); await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  a.local.mkdir('item'); await a.engine.startOverwrite(await a.engine.previewOverwrite('local-to-cloud'));
  await b.engine.sync(); await b.engine.sync();
  assert.deepEqual(b.engine.state.issues, {}); assert.equal(b.engine.state.pending.length, 0); assert.deepEqual(shape(a.local), shape(b.local)); assert.equal((await cloud(f)).length, 1);
});

test('legacy implicit parents remain valid after a directory revision is deleted but its child is live', async t => {
  const f = await fixture(t), local = tree(), c = client(f.remoteA, f.store.serverId, f.first.deviceId, local);
  const folder = await seed(f, 'Folder', Buffer.alloc(0), 'directory'); await seed(f, 'Folder/note.md', Buffer.from('keep'));
  await c.engine.initialize(); await c.engine.sync();
  await f.remoteB.commit({...folder, id: (await import('../shared/protocol')).id(), parents: [folder.id], deleted: true, hash: null, size: 0});
  await c.engine.sync(); assert.deepEqual(c.engine.state.issues, {}); assert.equal(local.text('Folder/note.md'), 'keep');
  await c.engine.startOverwrite(await c.engine.previewOverwrite('cloud-to-local')); await c.engine.sync();
  assert.deepEqual(c.engine.state.issues, {}); assert.equal(c.engine.state.pending.length, 0);
});

for (const mode of ['cloud-to-local', 'local-to-cloud'] as const) {
 test(`${mode}: recreating a deleted same-name file after overwrite and restart uploads without conflict`, async t => {
  const f = await fixture(t), local = tree();
  const old = await seed(f, '未命名.md', Buffer.alloc(0));
  if (mode === 'cloud-to-local') await f.remoteB.commit({...old, id: id(), parents: [old.id], deleted: true, hash: null, size: 0});
  const a = client(f.remoteA, f.store.serverId, f.first.deviceId, local);
  if (mode === 'cloud-to-local') local.set('未命名.md', 'old local');
  await a.engine.startOverwrite(await a.engine.previewOverwrite(mode));
  const deletion = (await f.remoteA.snapshot()).files.find(f => f.fileId === old.fileId)!.heads[0];
  assert.equal(a.saved.entries[old.fileId].baseRevision, deletion.id); assert.equal(a.saved.entries[old.fileId].baseDeleted, true);
  const restarted = client(f.remoteA, f.store.serverId, f.first.deviceId, local, a.saved);
  local.set('未命名.md', ''); local.set('未命名 1.md', 'new'); await restarted.engine.sync();
  assert.deepEqual(restarted.engine.state.issues, {}); assert.equal(restarted.engine.state.pending.length, 0);
  const live = (await f.remoteA.snapshot()).files.find(f => f.fileId === old.fileId)!.heads;
  assert.equal(live.length, 1); assert.equal(live[0].deleted, false); assert.deepEqual(live[0].parents, [deletion.id]);
  local.set('未命名.md', 'edited later'); await restarted.engine.sync(); assert.deepEqual(restarted.engine.state.issues, {});
 });
}
test('initial local file against a remote deletion stays protected; explicit local choice resolves existing false conflicts', async t => {
 const f = await fixture(t), old = await seed(f, '未命名.md', Buffer.from('old'));
 await f.remoteB.commit({...old, id: id(), parents: [old.id], deleted: true, hash: null, size: 0});
 const a = client(f.remoteA, f.store.serverId, f.first.deviceId, tree()); a.local.set('未命名.md', 'possibly offline work');
 await a.engine.initialize(); await a.engine.sync();
 assert.ok(a.engine.state.issues[old.fileId]); assert.equal(a.local.text('未命名.md'), 'possibly offline work');
 assert.equal((await f.remoteA.snapshot()).files[0].heads[0].deleted, true);
 await a.engine.resolve(old.fileId, 'local'); await a.engine.sync(); assert.deepEqual(a.engine.state.issues, {});
 assert.equal((await f.remoteA.snapshot()).files[0].heads[0].deleted, false);
});
test('initial empty client remembers absent deletions before a later new file', async t => {
 const f = await fixture(t), old = await seed(f, 'again.txt', Buffer.from('old'));
 await f.remoteB.commit({...old, id: id(), parents: [old.id], deleted: true, hash: null, size: 0});
 const a = client(f.remoteA, f.store.serverId, f.first.deviceId, tree()); await a.engine.initialize(); a.local.set('again.txt', 'new');
 await a.engine.sync(); assert.deepEqual(a.engine.state.issues, {}); assert.equal((await f.remoteA.snapshot()).files[0].heads[0].deleted, false);
});
