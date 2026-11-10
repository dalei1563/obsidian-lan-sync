import test from 'node:test';
import assert from 'node:assert/strict';
import { Remote } from '../src/sync/remote';
import { client, fixture, MemoryVault, revision, transport } from './helpers';
import { hash, id } from '../shared/protocol';

async function clients(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t), a = client(f.remoteA, f.store.serverId, f.first.deviceId), b = client(f.remoteB, f.store.serverId, f.second.deviceId);
  return { f, a, b };
}
test('two devices synchronize raw bytes without echo, including empty notes', async t => {
  const { f, a, b } = await clients(t);
  a.local.set('中文.md', '\ufeff---\r\n标题: 测试\r\n---\r\n[[双链]]'); a.local.set('empty.md', Buffer.alloc(0));
  await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  assert.deepEqual(b.local.files, a.local.files);
  const seq = f.store.snapshot(f.first.vaultId).cursor;
  await a.engine.sync(); await b.engine.sync(); assert.equal(f.store.snapshot(f.first.vaultId).cursor, seq);
  b.local.set('中文.md', 'changed on B'); await b.engine.sync(); await a.engine.sync();
  assert.equal(a.local.text('中文.md'), 'changed on B');
});
test('offline concurrent edits preserve both branches and resolve explicitly', async t => {
  const { f, a, b } = await clients(t);
  a.local.set('note.md', 'base'); await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  a.local.set('note.md', 'A offline'); b.local.set('note.md', 'B offline');
  await a.engine.sync(); await b.engine.sync(); await a.engine.sync();
  const file = f.store.snapshot(f.first.vaultId).files[0]; assert.equal(file.heads.length, 2);
  assert.equal(a.local.text('note.md'), 'A offline'); assert.equal(b.local.text('note.md'), 'B offline');
  await b.engine.resolve(file.fileId, 'local'); await a.engine.sync();
  assert.equal(a.local.text('note.md'), 'B offline'); assert.equal(f.store.snapshot(f.first.vaultId).files[0].heads.length, 1);
  assert.ok(a.local.preserved.some(d => d.toString() === 'A offline'));
});
test('initial same-name differences stay local until explicit selection', async t => {
  const { a, b } = await clients(t);
  a.local.set('note.md', 'remote'); await a.engine.initialize(); await a.engine.sync();
  b.local.set('note.md', 'local'); const preview = await b.engine.preview(); assert.equal(preview.conflicts, 1);
  await b.engine.initialize(); await b.engine.sync(); assert.equal(b.local.text('note.md'), 'local');
  const file = Object.values(b.engine.state.remote)[0];
  await b.engine.resolve(file.fileId, file.heads[0]); assert.equal(b.local.text('note.md'), 'remote');
  assert.ok(b.local.preserved.some(d => d.toString() === 'local'));
});
test('rename keeps stable identity, and deletion conflicts with offline editing', async t => {
  const { f, a, b } = await clients(t);
  a.local.set('old.md', 'base'); await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  const fileId = f.store.snapshot(f.first.vaultId).files[0].fileId;
  a.local.set('Folder/new.md', 'base'); a.local.files.delete('old.md'); await a.engine.noteRename('old.md', 'Folder/new.md');
  await a.engine.sync(); await b.engine.sync(); assert.equal(b.local.text('Folder/new.md'), 'base'); assert.equal(b.local.files.has('old.md'), false);
  assert.equal(f.store.snapshot(f.first.vaultId).files[0].fileId, fileId);
  a.local.files.delete('Folder/new.md'); b.local.set('Folder/new.md', 'offline edit');
  await a.engine.sync(); await b.engine.sync();
  assert.equal(f.store.snapshot(f.first.vaultId).files[0].heads.length, 2); assert.equal(b.local.text('Folder/new.md'), 'offline edit');
});
test('lost successful commit response survives client restart and retains later edit', async t => {
  const f = await fixture(t); let lose = true;
  const remote = new Remote(f.url, f.first.vaultId, f.first.token, async (...args) => {
    const result = await transport(...args);
    if (args[0].endsWith('/commits') && lose) { lose = false; throw new Error('response lost'); }
    return result;
  });
  const a = client(remote, f.store.serverId, f.first.deviceId); a.local.set('note.md', 'first');
  await a.engine.initialize(); await assert.rejects(a.engine.sync(), /response lost/); assert.equal(a.saved.pending.length, 1);
  a.local.set('note.md', 'later');
  const restarted = client(f.remoteA, f.store.serverId, f.first.deviceId, a.local, a.saved);
  await restarted.engine.sync(); await restarted.engine.sync();
  assert.equal(f.store.snapshot(f.first.vaultId).files[0].heads.length, 1);
  assert.equal(f.store.history(f.first.vaultId, Object.keys(restarted.engine.state.entries)[0]).length, 2);
  assert.equal((await f.remoteA.get(f.store.snapshot(f.first.vaultId).files[0].heads[0].hash!)).toString(), 'later');
});
test('resolution response loss does not upload the discarded local version after restart', async t => {
  const { f, a, b } = await clients(t);
  a.local.set('note.md', 'remote'); await a.engine.initialize(); await a.engine.sync();
  b.local.set('note.md', 'local'); await b.engine.initialize(); await b.engine.sync();
  const file = f.store.snapshot(f.first.vaultId).files[0]; let lose = true;
  const flaky = new Remote(f.url, f.second.vaultId, f.second.token, async (...args) => {
    const result = await transport(...args);
    if (args[0].endsWith('/commits') && lose) { lose = false; throw new Error('response lost'); } return result;
  });
  const resolving = client(flaky, f.store.serverId, f.second.deviceId, b.local, b.saved);
  await assert.rejects(resolving.engine.resolve(file.fileId, file.heads[0]), /response lost/);
  const restarted = client(f.remoteB, f.store.serverId, f.second.deviceId, b.local, resolving.saved);
  await restarted.engine.sync(); assert.equal(b.local.text('note.md'), 'remote');
  await restarted.engine.sync(); assert.equal(f.store.history(f.first.vaultId, file.fileId).length, 2);
});
test('a local edit during download is never overwritten', async t => {
  const { a, b } = await clients(t);
  a.local.set('note.md', 'base'); await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  a.local.set('note.md', 'remote new'); await a.engine.sync();
  b.local.beforeApply = () => b.local.set('note.md', 'edit during download');
  await b.engine.sync(); assert.equal(b.local.text('note.md'), 'edit during download'); assert.ok(Object.keys(b.engine.state.issues).length);
});
test('local persistence failure prevents network publication', async t => {
  const { f, a } = await clients(t);
  a.local.set('note.md', 'local'); await a.engine.initialize(); a.failSave = s => s.pending.length > 0;
  await assert.rejects(a.engine.sync(), /disk failure/);
  assert.equal(f.store.snapshot(f.first.vaultId).files.length, 0);
});
test('mass deletion requires exact approval at both sending and receiving devices', async t => {
  const { f, a, b } = await clients(t);
  for (let n = 0; n < 10; n++) a.local.set(`note${n}.md`, String(n));
  await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  a.local.files.clear(); await a.engine.sync(); assert.equal(a.engine.state.deletePlan?.paths.length, 10);
  assert.equal(f.store.snapshot(f.first.vaultId).files.filter(f => f.heads[0].deleted).length, 0);
  await a.engine.approveDeletes(); await a.engine.sync();
  await b.engine.sync(); assert.equal(b.local.files.size, 10); assert.equal(b.engine.state.deletePlan?.direction, 'remote');
  await b.engine.approveDeletes(); await b.engine.sync(); assert.equal(b.local.files.size, 0); assert.equal(b.local.trash.length, 10);
});
test('mass deletion approval is invalidated when another file is deleted', async t => {
  const {f, a} = await clients(t);
  for (let n = 0; n < 10; n++) a.local.set(`note${n}.md`, String(n));
  await a.engine.initialize(); await a.engine.sync();
  for (let n = 0; n < 5; n++) a.local.files.delete(`note${n}.md`);
  await a.engine.sync(); assert.equal(a.engine.state.deletePlan?.paths.length, 5);
  await a.engine.approveDeletes(); a.local.files.delete('note5.md'); await a.engine.sync();
  assert.equal(a.engine.state.deletePlan?.paths.length, 6);
  assert.equal(f.store.snapshot(f.first.vaultId).files.filter(file => file.heads[0].deleted).length, 0);
});

test('a concurrent revision during conflict resolution remains a separate head', async t => {
  const {f, a, b} = await clients(t);
  a.local.set('note.md', 'base'); await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  const base = f.store.snapshot(f.first.vaultId).files[0].heads[0];
  a.local.set('note.md', 'A'); b.local.set('note.md', 'B'); await a.engine.sync(); await b.engine.sync();
  const conflict = f.store.snapshot(f.first.vaultId).files[0]; assert.equal(conflict.heads.length, 2);
  const put = f.remoteB.put.bind(f.remoteB), other = Buffer.from('third device edit'); let inject = true;
  f.remoteB.put = async (bytes, sha) => {
    await put(bytes, sha);
    if (inject) { inject = false; await f.remoteA.put(other, hash(other)); await f.remoteA.commit(revision(f.first.deviceId, other, {fileId: base.fileId, parents: [base.id], path: base.path})); }
  };
  await b.engine.resolve(base.fileId, 'local');
  const heads = f.store.snapshot(f.first.vaultId).files[0].heads;
  assert.equal(heads.length, 2); assert.ok(heads.some(head => head.hash === hash(other)));
  assert.equal((await f.remoteA.get(hash(other))).toString(), 'third device edit');
  assert.ok(f.store.history(f.first.vaultId, base.fileId).some(item => item.revision.hash === hash(Buffer.from('A'))));
  assert.ok(f.store.history(f.first.vaultId, base.fileId).some(item => item.revision.hash === hash(Buffer.from('B'))));
});
test('crash after writing local content recovers from the applying journal without echo', async t => {
  const { f, a, b } = await clients(t);
  a.local.set('note.md', 'base'); await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  a.local.set('note.md', 'new'); await a.engine.sync();
  const head = f.store.snapshot(f.first.vaultId).files[0].heads[0];
  b.failSave = s => !s.applying && s.entries[head.fileId]?.baseRevision === head.id;
  await assert.rejects(b.engine.sync(), /disk failure/); assert.equal(b.saved.applying?.revision.id, head.id);
  const restart = client(f.remoteB, f.store.serverId, f.second.deviceId, b.local, b.saved);
  const cursor = f.store.snapshot(f.first.vaultId).cursor; await restart.engine.sync();
  assert.equal(b.local.text('note.md'), 'new'); assert.equal(f.store.snapshot(f.first.vaultId).cursor, cursor);
});
test('server epoch change triggers full reconciliation without deletion', async t => {
  const { a, f } = await clients(t);
  a.local.set('note.md', 'keep'); await a.engine.initialize(); await a.engine.sync();
  a.engine.state.epoch = 'old'; await a.engine.sync();
  assert.equal(a.local.text('note.md'), 'keep'); assert.equal(a.engine.state.epoch, f.store.epoch);
});
test('restoring an older server backup never silently rolls back a newer local baseline', async t => {
  const { f, a, b } = await clients(t);
  a.local.set('note.md', 'old backup'); await a.engine.initialize(); await a.engine.sync();
  const original = f.store.snapshot(f.first.vaultId).files[0].heads[0];
  await b.engine.initialize(); await b.engine.sync();
  a.local.set('note.md', 'new acknowledged work'); await a.engine.sync(); await b.engine.sync();
  f.store.transaction(() => {
    f.store.db.prepare('DELETE FROM heads WHERE vault_id=?').run(f.first.vaultId);
    f.store.db.prepare('DELETE FROM operations WHERE vault_id=? AND revision_id<>?').run(f.first.vaultId, original.id);
    f.store.db.prepare('DELETE FROM changes WHERE vault_id=? AND revision_id<>?').run(f.first.vaultId, original.id);
    f.store.db.prepare('DELETE FROM revisions WHERE vault_id=? AND id<>?').run(f.first.vaultId, original.id);
    f.store.db.prepare('INSERT INTO heads VALUES (?,?,?)').run(f.first.vaultId, original.fileId, original.id);
  });
  Object.defineProperty(f.store, 'epoch', { value: id() });
  await b.engine.sync();
  assert.equal(b.local.text('note.md'), 'new acknowledged work');
  assert.match(b.engine.state.entries[original.fileId].blocked!, /旧备份/);
});
test('new-file path collision can recover after local rename without losing either note', async t => {
  const { f, a, b } = await clients(t);
  a.local.set('note.md', 'A'); b.local.set('note.md', 'B'); await a.engine.initialize(); await b.engine.initialize();
  await a.engine.sync(); await b.engine.sync();
  const own = Object.values(b.engine.state.entries).find(e => !b.engine.state.remote[e.fileId])!;
  assert.ok(own); assert.equal(b.local.text('note.md'), 'B');
  b.local.set('other.md', 'B'); b.local.files.delete('note.md'); await b.engine.noteRename('note.md', 'other.md');
  await b.engine.retryRenamed(own.fileId); await b.engine.sync(); await a.engine.sync();
  assert.equal(b.local.text('note.md'), 'A'); assert.equal(a.local.text('other.md'), 'B');
  assert.equal(f.store.snapshot(f.first.vaultId).files.length, 2);
});
