import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store';
import { CouchStore, CouchOptions } from '../server/couch-store';
import type { Backend } from '../server/backend';
import { hash, id, Revision, SyncError } from '../shared/protocol';
import type { ActivityItem } from '../shared/management';

const configFile = process.env.COUCH_TEST_CONFIG;
async function managementFixture(t: TestContext, kind: 'sqlite' | 'couchdb') {
  const base = resolve('.test-runtime'), root = join(base, 'management-' + id()); mkdirSync(root, { recursive: true });
  let options: CouchOptions | undefined;
  if (kind === 'couchdb') {
    const config = JSON.parse(readFileSync(configFile!, 'utf8'));
    options = { ...config, root, database: 'lnstest_' + id().replace(/-/g, '') };
  }
  const open = async (): Promise<Backend> => options ? CouchStore.open(options) : new Store(root, true);
  let store = await open();
  t.after(async () => {
    await store.close();
    if (options) {
      if (!/^lnstest_[a-f0-9]{32}$/.test(options.database)) throw Error('Unsafe database cleanup');
      const response = await fetch(options.url + '/' + options.database, { method: 'DELETE', headers: { Authorization: 'Basic ' + Buffer.from(options.user + ':' + options.password).toString('base64') } });
      assert.equal(response.ok, true);
    }
    if (!root.startsWith(base + sep)) throw Error('Unsafe local cleanup'); rmSync(root, { recursive: true, force: true });
  });
  return { get store() { return store; }, root, async reopen() { await store.close(); store = await open(); } };
}
const errorCode = (code: string) => (e: unknown) => e instanceof SyncError && e.code === code;
async function submit(store: Backend, vaultId: string, deviceId: string, body: string | null, extra: Partial<Revision> = {}) {
  const bytes = body === null ? null : Buffer.from(body);
  if (bytes !== null) await store.putObject(vaultId, hash(bytes), bytes);
  const revision: Revision = { id: id(), fileId: id(), parents: [], path: 'note.md', deleted: body === null, hash: bytes === null ? null : hash(bytes), size: bytes?.length ?? 0, clientId: deviceId, ...extra };
  return store.commit(vaultId, revision, deviceId);
}
for (const kind of ['sqlite', 'couchdb'] as const) {
  const options = { skip: kind === 'couchdb' && !configFile, timeout: 60000 };
  test(`${kind} management: multi-vault summaries and immutable activity pagination remain isolated`, options, async t => {
    const f = await managementFixture(t, kind), store = f.store;
    const a = await store.createVault('  Team A  '), b = await store.createVault('Team B');
    assert.equal(a.name, 'Team A'); assert.notEqual(a.id, b.id);
    const pa = await store.pair((await store.createPair('Ignored name', a.id)).code, 'Device A');
    const qa = await store.pair((await store.createPair('Ignored name', a.id)).code, 'Device A2');
    const pb = await store.pair((await store.createPair('Team B', b.id)).code, 'Device B');
    const first = await submit(store, a.id, pa.deviceId, 'base');
    const rename = await submit(store, a.id, pa.deviceId, 'renamed', { fileId: first.revision.fileId, parents: [first.revision.id], path: 'notes/renamed.md' });
    const concurrent = await submit(store, a.id, qa.deviceId, 'concurrent', { fileId: first.revision.fileId, parents: [first.revision.id], path: 'notes/renamed.md' });
    let summary = (await store.listVaults()).find(v => v.id === a.id)!;
    assert.equal(summary.conflicts, 1); assert.equal(summary.files, 1); assert.equal(summary.revisionCount, 3);
    await submit(store, a.id, pa.deviceId, 'resolution', { fileId: first.revision.fileId, parents: [rename.revision.id, concurrent.revision.id], path: 'notes/renamed.md' });
    const doomed = await submit(store, a.id, pa.deviceId, 'remove me', { path: 'deleted.md' });
    await submit(store, a.id, pa.deviceId, null, { fileId: doomed.revision.fileId, parents: [doomed.revision.id], path: 'deleted.md' });
    // IDs are scoped to Vaults: an identical revision ID in B must not collide
    // with the global activity cursor for A.
    const other = await submit(store, b.id, pb.deviceId, 'other', { id: first.revision.id, path: 'other.md' });
    await submit(store, b.id, pb.deviceId, 'other updated', { fileId: other.revision.fileId, parents: [other.revision.id], path: 'other.md' });
    await store.renameVault(a.id, 'Renamed A');
    const summaries = await store.listVaults(); assert.equal(summaries.length, 2);
    summary = summaries.find(v => v.id === a.id)!;
    assert.equal(summary.name, 'Renamed A'); assert.equal(summary.files, 1); assert.equal(summary.deletedFiles, 1); assert.equal(summary.conflicts, 0);
    assert.equal(summary.revisionCount, 6); assert.equal(summary.devices, 2); assert.equal(summary.bytes, Buffer.byteLength('resolution'));
    assert.ok(summary.createdAt !== null && summary.createdAt > 0); assert.deepEqual(summary.excludedPaths, []);
    await store.revoke(qa.deviceId); assert.equal((await store.listVaults()).find(v => v.id === a.id)!.devices, 1);
    const events: ActivityItem[] = []; let before: string | undefined;
    for (;;) {
      const page = await store.activity(undefined, before, 2); events.push(...page.items);
      if (!page.nextCursor) break; before = page.nextCursor;
    }
    assert.equal(events.length, 8); assert.equal(new Set(events.map(e => e.id)).size, 8);
    assert.deepEqual(new Set(events.map(e => e.action)), new Set(['create', 'rename', 'update', 'resolve', 'delete']));
    assert.ok(events.every(e => e.createdAt !== null && e.createdAt > 0));
    assert.ok(events.filter(e => e.vaultId === a.id).every(e => e.vaultName === 'Renamed A' && ['Device A', 'Device A2'].includes(e.deviceName)));
    const onlyA = await store.activity(a.id); assert.equal(onlyA.items.length, 6); assert.ok(onlyA.items.every(e => e.vaultId === a.id));
    await assert.rejects(async () => store.activity(a.id, events.find(e => e.vaultId === b.id)!.id), errorCode('invalid_cursor'));
    await assert.rejects(async () => store.activity(undefined, undefined, 0), errorCode('invalid_limit'));
    await assert.rejects(async () => store.renameVault(id(), 'Missing'), errorCode('vault_missing'));
    await assert.rejects(async () => store.createVault('   '), errorCode('invalid_name'));
    const serialized = JSON.stringify({ summaries, events });
    for (const secret of [pa.token, qa.token, pb.token]) assert.equal(serialized.includes(secret), false);
  });
  test(`${kind} management: exclusions persist, keep history, reject fresh writes and preserve idempotent receipts`, options, async t => {
    const f = await managementFixture(t, kind), a = await f.store.createVault('Policies'), b = await f.store.createVault('Other');
    const pair = await f.store.pair((await f.store.createPair('Policies', a.id)).code, 'A');
    const committed = await submit(f.store, a.id, pair.deviceId, 'private original', { path: 'private/note.md' });
    const initial = await f.store.snapshot(a.id);
    const rules = await f.store.setExclusions(a.id, ['private/**']); assert.deepEqual(rules, ['private/**']);
    const snapshot = await f.store.snapshot(a.id); assert.deepEqual(snapshot.excludedPaths, ['private/**']);
    assert.equal(snapshot.files.length, 1, 'Excluded history must remain represented, not look deleted');
    assert.deepEqual((await f.store.changes(a.id, initial.cursor, initial.epoch)).excludedPaths, ['private/**']);
    assert.deepEqual((await f.store.snapshot(b.id)).excludedPaths, []);
    assert.deepEqual(await f.store.commit(a.id, committed.revision, pair.deviceId), committed, 'Replay of a previous successful receipt is still idempotent');
    await assert.rejects(() => submit(f.store, a.id, pair.deviceId, 'new private body', { fileId: committed.revision.fileId, parents: [committed.revision.id], path: 'private/note.md' }), errorCode('path_excluded'));
    await assert.rejects(() => submit(f.store, a.id, pair.deviceId, null, { fileId: committed.revision.fileId, parents: [committed.revision.id], path: 'private/note.md' }), errorCode('path_excluded'));
    assert.equal((await f.store.history(a.id, committed.revision.fileId)).length, 1);
    const serverId = f.store.serverId; await f.reopen();
    assert.equal(f.store.serverId, serverId); assert.deepEqual((await f.store.listVaults()).find(v => v.id === a.id)!.excludedPaths, ['private/**']);
    assert.equal((await f.store.activity(a.id)).items.length, 1);
    await f.store.setExclusions(a.id, []);
    await submit(f.store, a.id, pair.deviceId, 'resumed', { fileId: committed.revision.fileId, parents: [committed.revision.id], path: 'private/note.md' });
    assert.equal((await f.store.activity(a.id)).items.length, 2);
  });
  test(`${kind} management: removing a vault hides it and denies devices while retaining history`, options, async t => {
    const f = await managementFixture(t, kind), a = await f.store.createVault('Test to remove'), b = await f.store.createVault('Keep');
    const pair = await f.store.pair((await f.store.createPair(a.name, a.id)).code, 'Device');
    const unused = await f.store.createPair(a.name, a.id), saved = await submit(f.store, a.id, pair.deviceId, 'retained');
    await f.store.archiveVault(a.id);
    assert.deepEqual((await f.store.listVaults()).map(v => v.id), [b.id]);
    await assert.rejects(async () => f.store.authenticate(pair.token), errorCode('unauthorized'));
    await assert.rejects(async () => f.store.pair(unused.code, 'Another'));
    assert.equal((await f.store.activity()).items.length, 0); assert.equal((await f.store.devices()).length, 0);
    assert.equal((await f.store.history(a.id, saved.revision.fileId)).length, 1);
    await f.reopen(); assert.deepEqual((await f.store.listVaults()).map(v => v.id), [b.id]);
    assert.equal((await f.store.history(a.id, saved.revision.fileId)).length, 1);
  });
}

test('SQLite management migration preserves existing unknown dates and original Vault IDs', async t => {
  const base = resolve('.test-runtime'), root = join(base, 'legacy-management-' + id()); mkdirSync(root, { recursive: true });
  const legacyId = id(), db = new DatabaseSync(join(root, 'sync.sqlite'));
  db.exec('CREATE TABLE vaults(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE revisions(vault_id TEXT NOT NULL,id TEXT NOT NULL,file_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(vault_id,id));');
  db.prepare('INSERT INTO vaults VALUES (?,?)').run(legacyId, 'Original Vault'); db.close();
  const store = new Store(root);
  t.after(() => { store.close(); if (!root.startsWith(base + sep)) throw Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); });
  const vault = store.listVaults()[0]; assert.equal(vault.id, legacyId); assert.equal(vault.createdAt, null); assert.deepEqual(vault.excludedPaths, []);
  store.renameVault(legacyId, 'Preserved Vault'); assert.equal(store.listVaults()[0].createdAt, null);
  const fresh = store.createVault('Fresh'); assert.ok(store.listVaults().find(v => v.id === fresh.id)!.createdAt !== null);
});

test('SQLite upgrade keeps a pre-management revision receipt, history and unknown activity date', async t => {
  const base = resolve('.test-runtime'), root = join(base, 'legacy-revision-' + id()); mkdirSync(root, { recursive: true });
  let store = new Store(root);
  t.after(() => { store.close(); if (!root.startsWith(base + sep)) throw Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); });
  const vault = store.createVault('Old notes'), pair = store.pair(store.createPair('Old notes', vault.id).code, 'Original device');
  const receipt = await submit(store, vault.id, pair.deviceId, 'old preserved bytes');
  const originalServerId = store.serverId; store.close();
  // Reproduce exactly the previous three missing columns while retaining real
  // files, revision heads, operation receipts, auth and incremental history.
  const db = new DatabaseSync(join(root, 'sync.sqlite'));
  db.exec('ALTER TABLE revisions DROP COLUMN created_at; ALTER TABLE vaults DROP COLUMN created_at; ALTER TABLE vaults DROP COLUMN excluded_paths;'); db.close();
  store = new Store(root, true);
  assert.equal(store.serverId, originalServerId); assert.deepEqual(store.authenticate(pair.token), { vaultId: vault.id, deviceId: pair.deviceId });
  assert.deepEqual(store.commit(vault.id, receipt.revision, pair.deviceId), receipt);
  assert.equal(store.history(vault.id, receipt.revision.fileId).length, 1);
  assert.equal(store.activity(vault.id).items[0].createdAt, null);
  assert.equal(store.listVaults()[0].createdAt, null);
  assert.equal(store.getObject(vault.id, receipt.revision.hash!).toString(), 'old preserved bytes');
});
