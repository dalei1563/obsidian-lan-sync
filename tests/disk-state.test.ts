import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
