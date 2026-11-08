import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { processLock } from '../server/process-lock';
import { id } from '../shared/protocol';

test('gateway lock protects a live writer, releases cleanly, and recovers a dead process', t => {
  const base = resolve('.test-runtime'), root = join(base, 'lock-' + id()); mkdirSync(root, { recursive: true });
  const file = join(root, 'server.lock');
  t.after(() => { if (!root.startsWith(base + sep)) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); });
  const release = processLock(file); assert.throws(() => processLock(file), /already in use/); release(); assert.equal(existsSync(file), false);
  writeFileSync(file, JSON.stringify({ pid: 2147483646, signature: null, instance: id() }));
  const recovered = processLock(file); recovered();
  writeFileSync(file, 'invalid'); assert.throws(() => processLock(file), /invalid/); assert.equal(existsSync(file), true);
});
