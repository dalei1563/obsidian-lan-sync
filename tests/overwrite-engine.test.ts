import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, client, revision } from './helpers';
import { Remote } from '../src/sync/remote';
import { transport } from './helpers';

async function seed(f: Awaited<ReturnType<typeof fixture>>, path: string, value: string) {
  const content = Buffer.from(value), rev = revision(f.second.deviceId, content, {path});
  await f.remoteB.put(content, rev.hash!); await f.remoteB.commit(rev); return rev;
}

test('cloud overwrite removes local-only files and downloads cloud content', async t => {
  const f = await fixture(t); await seed(f, '工作.md', '云端'); await seed(f, '计划.md', '计划');
  const c = client(f.remoteA, f.store.serverId, f.first.deviceId);
  c.local.set('工作.md', '本地'); c.local.set('日记.md', '日记'); c.local.set('.obsidian/private.md', '保留');
  const plan = await c.engine.previewOverwrite('cloud-to-local'); await c.engine.startOverwrite(plan);
  assert.equal(c.local.text('工作.md'), '云端'); assert.equal(c.local.text('计划.md'), '计划');
  assert.equal(c.local.text('日记.md'), undefined); assert.equal(c.local.text('.obsidian/private.md'), '保留');
  assert.equal(c.engine.state.initialized, true); assert.equal(c.engine.state.overwrite, undefined);
});

test('local overwrite keeps old cloud revisions and records deletion as a new revision', async t => {
  const f = await fixture(t), old = await seed(f, '工作.md', '云端'), removed = await seed(f, '计划.md', '计划');
  const c = client(f.remoteA, f.store.serverId, f.first.deviceId);
  c.local.set('工作.md', '本地'); c.local.set('日记.md', '日记');
  await c.engine.startOverwrite(await c.engine.previewOverwrite('local-to-cloud'));
  const snapshot = await f.remoteA.snapshot();
  const changed = snapshot.files.find(x => x.fileId === old.fileId)!.heads[0];
  const deleted = snapshot.files.find(x => x.fileId === removed.fileId)!.heads[0];
  assert.deepEqual(changed.parents, [old.id]); assert.deepEqual(deleted.parents, [removed.id]); assert.equal(deleted.deleted, true);
  assert.equal((await f.store.history(f.first.vaultId, old.fileId)).length, 2);
  assert.equal((await f.store.history(f.first.vaultId, removed.fileId)).length, 2);
  assert.equal(c.local.text('工作.md'), '本地');
});

test('stale preview cannot overwrite changes made after confirmation was prepared', async t => {
  const f = await fixture(t); await seed(f, '工作.md', '云端');
  const c = client(f.remoteA, f.store.serverId, f.first.deviceId); c.local.set('工作.md', '本地');
  const plan = await c.engine.previewOverwrite('cloud-to-local'); c.local.set('工作.md', '新编辑');
  await assert.rejects(c.engine.startOverwrite(plan), /重新预览/); assert.equal(c.local.text('工作.md'), '新编辑');
});

test('interrupted local apply can resume without deleting or replacing it twice', async t => {
  const f = await fixture(t); await seed(f, '工作.md', '云端');
  const c = client(f.remoteA, f.store.serverId, f.first.deviceId); c.local.set('工作.md', '本地');
  const apply = c.local.apply.bind(c.local); let once = true;
  c.local.apply = async request => { await apply(request); if (once) { once = false; throw new Error('interrupted'); } };
  await assert.rejects(c.engine.startOverwrite(await c.engine.previewOverwrite('cloud-to-local')), /interrupted/);
  assert.equal(c.local.text('工作.md'), '云端'); await c.engine.resumeOverwrite();
  assert.equal(c.local.preserved.length, 1); assert.equal(c.engine.state.overwrite, undefined);
});

test('a lost cloud commit response is retried using the original revision ID', async t => {
  const f = await fixture(t), old = await seed(f, '工作.md', '云端'); let lose = true;
  const remote = new Remote(f.url, f.first.vaultId, f.first.token, async (url, method, headers, body) => {
    const result = await transport(url, method, headers, body);
    if (lose && url.endsWith('/reconcile')) { lose = false; throw new Error('response lost'); }
    return result;
  });
  const c = client(remote, f.store.serverId, f.first.deviceId); c.local.set('工作.md', '本地');
  await assert.rejects(c.engine.startOverwrite(await c.engine.previewOverwrite('local-to-cloud')), /response lost/);
  const restarted = client(remote, f.store.serverId, f.first.deviceId, c.local, c.saved);
  await restarted.engine.resumeOverwrite();
  const history = await f.store.history(f.first.vaultId, old.fileId);
  assert.equal(history.length, 2); assert.deepEqual(history[0].revision.parents, [old.id]);
  assert.equal(restarted.engine.state.overwrite, undefined);
});
test('idle checks skip rescanning unchanged notes but fully reconcile remote changes', async t => {
  const f = await fixture(t), c = client(f.remoteA, f.store.serverId, f.first.deviceId);
  c.local.set('note.md', 'base'); await c.engine.initialize(); await c.engine.sync();
  let scans = 0; const scan = c.local.scan.bind(c.local); c.local.scan = async () => { scans++; return scan(); };
  await c.engine.sync(true); assert.equal(scans, 0);
  const file = (await f.remoteB.snapshot()).files.find(x => x.heads[0].path === 'note.md')!, content = Buffer.from('remote');
  await f.remoteB.put(content, (await import('../shared/protocol')).hash(content));
  await f.remoteB.commit(revision(f.second.deviceId, content, {fileId: file.fileId, parents: [file.heads[0].id], path: 'note.md'}));
  await c.engine.sync(true); assert.ok(scans > 0); assert.equal(c.local.text('note.md'), 'remote');
});
