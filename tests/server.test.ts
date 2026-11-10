import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from '../server/store';
import { hash, id, validatePath } from '../shared/protocol';
import { fixture, revision, transport } from './helpers';
import { checkRate } from '../server/http';

test('pairing is single use, expires, is vault-scoped, and can be revoked', async t => {
  const f = await fixture(t);
  const p = f.store.createPair('Other');
  const paired = f.store.pair(p.code, 'new');
  assert.throws(() => f.store.pair(p.code, 'again'), /原仓库为这台设备重新生成连接码/);
  const expired = f.store.createPair('Other', paired.vaultId);
  f.store.db.prepare('UPDATE pairing SET expires=0 WHERE code_hash=?').run(hash(expired.code));
  assert.throws(() => f.store.pair(expired.code, 'late'), /原仓库为这台设备重新生成连接码/);
  const cross = await transport(f.url + `/v1/vaults/${paired.vaultId}/state`, 'GET', { Authorization: 'Bearer ' + f.first.token });
  assert.equal(cross.status, 403);
  f.store.db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(f.first.deviceId);
  await assert.rejects(f.remoteA.snapshot(), /撤销/);
});
test('unpaired devices are rejected and pairing attempts are rate limited despite forwarded headers', async t => {
  const f = await fixture(t);
  assert.equal((await transport(f.url + `/v1/vaults/${f.first.vaultId}/state`, 'GET', {})).status, 401);
  for (let n = 0; n < 10; n++) {
    const response = await transport(f.url + '/v1/pair', 'POST', {'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${n}`}, Buffer.from(JSON.stringify({code: 'a'.repeat(24), deviceName: 'unknown'})));
    assert.equal(response.status, 401);
  }
  const limited = await transport(f.url + '/v1/pair', 'POST', {'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.99'}, Buffer.from(JSON.stringify({code: 'b'.repeat(24), deviceName: 'unknown'})));
  assert.equal(limited.status, 429);
});
test('rate limit buckets have a hard bound and expire without evicting active entries', () => {
  const limits = new Map<string, {count: number; until: number}>();
  for (let n = 0; n < 1000; n++) assert.equal(checkRate(limits, `${n}:pair`, 0), true);
  assert.equal(checkRate(limits, 'new:pair', 1), false); assert.equal(limits.size, 1000);
  assert.equal(checkRate(limits, '0:pair', 1), true);
  assert.equal(checkRate(limits, 'new:pair', 60000), true); assert.equal(limits.size, 1);
});
test('binary objects preserve Chinese, BOM, CRLF and zero bytes; corrupt bytes rejected', async t => {
  const f = await fixture(t);
  for (const data of [Buffer.from('\ufeff---\r\n标题: 中文\r\n---\r\n[[双链]]'), Buffer.alloc(0)]) {
    await f.remoteA.put(data, hash(data)); assert.deepEqual(await f.remoteA.get(hash(data)), data);
  }
  await assert.rejects(f.remoteA.put(Buffer.from('wrong'), hash('right')), /哈希/);
  const invalid = Buffer.from([0xff]); await assert.rejects(f.remoteA.put(invalid, hash(invalid)), /UTF-8/);
  // Upload in another vault cannot expose an object under the same hash.
  const other = f.store.pair(f.store.createPair('Other').code, 'other');
  assert.throws(() => f.store.getObject(other.vaultId, hash(Buffer.alloc(0))), /不存在/);
});
test('concurrent revisions retain branches, idempotency and explicit merge', async t => {
  const f = await fixture(t), base = Buffer.from('base');
  await f.remoteA.put(base, hash(base));
  const root = revision(f.first.deviceId, base); await f.remoteA.commit(root);
  const dataA = Buffer.from('A'), dataB = Buffer.from('B');
  await f.remoteA.put(dataA, hash(dataA)); await f.remoteB.put(dataB, hash(dataB));
  const a = revision(f.first.deviceId, dataA, { fileId: root.fileId, parents: [root.id] });
  const b = revision(f.second.deviceId, dataB, { fileId: root.fileId, parents: [root.id] });
  await Promise.all([f.remoteA.commit(a), f.remoteB.commit(b)]);
  assert.equal((await f.remoteA.snapshot()).files[0].heads.length, 2);
  const once = await f.remoteA.commit(a), twice = await f.remoteA.commit(a); assert.equal(once.seq, twice.seq);
  await assert.rejects(f.remoteA.commit({ ...a, path: 'changed.md' }), /不同内容/);
  const merge = revision(f.first.deviceId, dataA, { fileId: root.fileId, parents: [a.id, b.id] });
  await f.remoteA.commit(merge);
  assert.deepEqual((await f.remoteA.snapshot()).files[0].heads.map(h => h.id), [merge.id]);
  assert.equal((await f.remoteA.history(root.fileId)).length, 4);
});
test('invalid paths, unknown parents, forged device and path collisions do not commit', async t => {
  const f = await fixture(t), data = Buffer.from('note'); await f.remoteA.put(data, hash(data));
  for (const path of ['../evil.md', '.obsidian/x.md', 'CON.md', 'a\\b.md', 'A/../b.md', 'file.md.', 'a//b.md', '/absolute.md', 'e\u0301.md']) assert.throws(() => validatePath(path));
  const r = revision(f.first.deviceId, data, { path: 'Folder/Note.md' }); await f.remoteA.commit(r);
  await assert.rejects(f.remoteA.commit(revision(f.first.deviceId, data, { path: 'folder/note.md' })), /路径/);
  await assert.rejects(f.remoteA.commit(revision(f.first.deviceId, data, { path: 'Folder/Note.md/child.md' })), /路径/);
  await assert.rejects(f.remoteA.commit(revision(f.first.deviceId, data, { parents: [id()] })), /父修订/);
  await assert.rejects(f.remoteA.commit(revision(f.second.deviceId, data)), /当前设备/);
  assert.equal((await f.remoteA.snapshot()).files.length, 1);
});
test('incremental pagination, epoch checks, backup and restoration preserve history', async t => {
  const f = await fixture(t), data = Buffer.from('x'); f.store.putObject(f.first.vaultId, hash(data), data);
  let last = revision(f.first.deviceId, data);
  for (let n = 0; n < 105; n++) {
    if (n) last = revision(f.first.deviceId, data, { fileId: last.fileId, parents: [last.id] });
    f.store.commit(f.first.vaultId, last, f.first.deviceId);
  }
  const snapshot = f.store.snapshot(f.first.vaultId);
  const first = f.store.changes(f.first.vaultId, 0, snapshot.epoch);
  assert.equal(first.changes.length, 100); assert.equal(first.more, true);
  const second = f.store.changes(f.first.vaultId, first.cursor, snapshot.epoch);
  assert.equal(second.changes.length, 5); assert.equal(second.cursor, snapshot.cursor);
  assert.throws(() => f.store.changes(f.first.vaultId, 0, 'old'), /重新核对/);
  const backup = join(f.root, 'backup'); f.store.backup(backup); assert.equal(existsSync(join(backup, 'backup.json')), true);
  const restored = new Store(backup, true);
  try {
    assert.equal(restored.serverId, f.store.serverId); assert.notEqual(restored.epoch, f.store.epoch);
    assert.equal(restored.snapshot(f.first.vaultId).files[0].heads[0].id, last.id);
    assert.deepEqual(restored.getObject(f.first.vaultId, hash(data)), data);
  } finally { restored.close(); }
});
