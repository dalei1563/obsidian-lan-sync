import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fixture, client, revision } from './helpers';
import { id } from '../shared/protocol';
import { directoryBytes, storageGrowth, storageReport, storageWarnings } from '../src/sync/storage-report';

test('storage report counts deduplicated history, local snapshots, pending content and vault trash separately', async t => {
  const f = await fixture(t), c = client(f.remoteA, f.store.serverId, f.first.deviceId);
  const base = resolve('.test-runtime'), root = join(base, 'storage-' + id()); mkdirSync(join(root, 'snapshots'), {recursive: true}); mkdirSync(join(root, '.trash'), {recursive: true});
  t.after(() => { if (!root.startsWith(base + sep)) throw Error('Unsafe cleanup'); rmSync(root, {recursive: true, force: true}); });
  writeFileSync(join(root, 'snapshots', 'a'), '1234'); writeFileSync(join(root, '.trash', 'b'), '123456');
  c.local.set('a.md', 'hello'); await c.engine.initialize(); await c.engine.sync();
  c.local.set('a.md', 'world!'); await c.engine.sync();
  const state = c.saved, bytes = Buffer.from('pending');
  state.pending.push({revision: revision(f.first.deviceId, bytes), content: bytes.toString('base64')});
  const report = await storageReport(f.remoteA, state, join(root, 'snapshots'), join(root, '.trash'));
  assert.deepEqual(report, {history: 11, snapshots: 4, pending: 7, trash: 6});
  const growth = storageGrowth({at: 1000, report}, {...report, snapshots: 6}, 86401000);
  assert.deepEqual(growth, {history: 0, snapshots: 2, pending: 0, trash: 0});
  assert.equal(storageGrowth(undefined, report, 1000), null); assert.equal(directoryBytes(join(root, 'missing')), 0);
  assert.deepEqual(storageWarnings(report, 0), []);
  assert.deepEqual(storageWarnings(report, 6 / 1048576), ['history', 'pending', 'trash']);
  state.pending[0].content = Buffer.from('corrupt').toString('base64');
  await assert.rejects(storageReport(f.remoteA, state, join(root, 'snapshots'), join(root, '.trash')), /损坏/);
});
