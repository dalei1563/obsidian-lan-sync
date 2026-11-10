import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DiskState } from '../src/sync/disk-state';
import { newState } from '../src/sync/engine';
import { hash, id } from '../shared/protocol';

test('disk state is atomically recoverable, exclusively locked, and refuses corrupt JSON', async t => {
  const runtime = resolve('.test-runtime'); mkdirSync(runtime, { recursive: true });
  const root = join(runtime, 'disk-' + id()), disk = new DiskState(root);
  t.after(() => { disk.close(); if (!resolve(root).startsWith(runtime + sep)) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); });
  assert.throws(() => new DiskState(root), /仍在运行/);
  const state = newState(id(), id(), id()); await disk.save(state); assert.deepEqual(disk.load(), state);
  const bytes = Buffer.from('\ufeff中文\r\n'); await disk.preserve(bytes);
  assert.deepEqual(readFileSync(join(root, 'snapshots', hash(bytes) + '.md')), bytes);
  disk.close(); const reopened = new DiskState(root);
  try { assert.deepEqual(reopened.load(), state); writeFileSync(join(root, 'state.json'), '{bad json'); assert.throws(() => reopened.load(), /损坏/); }
  finally { reopened.close(); }
});

test('snapshot cleanup requires a current preview and never touches state or unknown files', async t => {
  const runtime = resolve('.test-runtime'); mkdirSync(runtime, {recursive: true});
  const root = join(runtime, 'cleanup-' + id()), disk = new DiskState(root);
  t.after(() => { disk.close(); if (!resolve(root).startsWith(runtime + sep)) throw new Error('Unsafe cleanup'); rmSync(root, {recursive: true, force: true}); });
  const state = newState(id(), id(), id()); await disk.save(state);
  await disk.preserve(Buffer.from('first')); const stale = disk.previewSnapshotCleanup();
  await disk.preserve(Buffer.from('second')); assert.throws(() => disk.cleanupSnapshots(stale.fingerprint), /重新预览/);
  assert.equal(existsSync(join(root, 'snapshots', hash('first') + '.md')), true);
  const unknown = join(root, 'snapshots', 'unknown.md'); writeFileSync(unknown, 'keep');
  assert.throws(() => disk.previewSnapshotCleanup(), /未知文件/); assert.equal(readFileSync(unknown, 'utf8'), 'keep');
  rmSync(unknown); const plan = disk.previewSnapshotCleanup(); assert.equal(plan.files.length, 2);
  assert.equal(disk.cleanupSnapshots(plan.fingerprint), 2); assert.deepEqual(disk.load(), state);
});
test('a newer state schema is refused without rewriting its contents', t => {
  const runtime = resolve('.test-runtime'); mkdirSync(runtime, {recursive: true});
  const root = join(runtime, 'schema-' + id()), disk = new DiskState(root);
  t.after(() => { disk.close(); if (!root.startsWith(runtime + sep)) throw Error('Unsafe cleanup'); rmSync(root, {recursive: true, force: true}); });
  const data = JSON.stringify({...newState(id(), id(), id()), schema: 2, future: 'keep'}), path = join(root, 'state.json');
  writeFileSync(path, data); assert.throws(() => disk.load(), /版本不兼容/); assert.equal(readFileSync(path, 'utf8'), data);
});
