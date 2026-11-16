import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { encodeConnection, decodeConnection } from '../shared/connection';
import { Enrollment } from '../src/sync/enrollment';
import { id } from '../shared/protocol';

test('basic connection code carries endpoint, one-use code and protocol; rejects malformed roots', () => {
  const code = 'a'.repeat(24), encoded = encodeConnection('https://notes.example.com', code);
  assert.deepEqual(decodeConnection(encoded), { protocol: 3, server: 'https://notes.example.com', code });
  assert.deepEqual(decodeConnection('obsidian://lan-note-sync?connection=' + encodeURIComponent(encoded)), decodeConnection(encoded));
  for (const url of ['https://user:password@example.com', 'https://example.com/path', 'https://example.com/?key=x', 'file:///tmp', 'https://example.com/#x']) assert.throws(() => encodeConnection(url, code));
  assert.throws(() => decodeConnection('lansync:invalid')); assert.throws(() => decodeConnection(encoded + 'broken'));
});
test('target display metadata supports Chinese names without changing pairing protocol', () => {
  const target = {id: id(), name: '学堂 "素材"库\n测试'}, value = encodeConnection('https://notes.example.com', 'c'.repeat(24), target);
  const payload = JSON.parse(Buffer.from(value.slice(8), 'base64url').toString('utf8'));
  assert.equal(payload.vaultId, target.id); assert.equal(Buffer.from(payload.vaultLabel, 'base64').toString('utf8'), target.name);
  assert.deepEqual(decodeConnection(value), {protocol: 3, server: 'https://notes.example.com', code: 'c'.repeat(24)});
});

test('installer bootstrap accepts BOM and pairing claim survives restart; successful enrollment removes only enrollment files', t => {
  const runtime = resolve('.test-runtime'), root = join(runtime, 'enrollment-' + id()); mkdirSync(root, { recursive: true });
  t.after(() => { if (!root.startsWith(runtime + sep)) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); });
  const code = 'b'.repeat(24), value = encodeConnection('http://127.0.0.1:27123', code);
  writeFileSync(join(root, 'bootstrap.json'), '\ufeff' + JSON.stringify({ schema: 1, connection: value }));
  writeFileSync(join(root, 'keep.md'), 'keep');
  const first = new Enrollment(root), claim = first.claim('http://127.0.0.1:27123', code);
  const restart = new Enrollment(root);
  assert.equal(restart.bootstrap(), value); assert.equal(restart.claim('http://127.0.0.1:27123', code), claim);
  restart.complete(); assert.equal(existsSync(join(root, 'keep.md')), true); assert.equal(restart.bootstrap(), null); assert.equal(existsSync(join(root, 'pair-claim.json')), false);
});
