import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { id } from '../shared/protocol';

const bash = process.platform === 'win32' ? 'D:/program/Git/bin/bash.exe' : '/bin/bash';
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
test('image deployment generates fixed image coordinates and random credentials once, without building source', { skip: !existsSync(bash) }, t => {
  const base = resolve('.test-runtime'), root = join(base, 'images-' + id()); mkdirSync(root, { recursive: true });
  t.after(() => { if (!root.startsWith(base + sep)) throw Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); });
  const args = [posix(resolve('deployment/setup-images.sh')), '--image-prefix', 'ghcr.io/example/obsidian-lan-sync', '--public-url', 'https://notes.example.com', '--out', posix(root), '--prepare-only'];
  const first = spawnSync(bash, args, { encoding: 'utf8', windowsHide: true }); assert.equal(first.status, 0, first.stderr);
  const env = readFileSync(join(root, '.env'), 'utf8'), compose = readFileSync(join(root, 'compose.yaml'), 'utf8');
  assert.match(env, /SYNC_IMAGE=ghcr.io\/example\/obsidian-lan-sync:0.3.0/);
  assert.match(env, /COUCHDB_IMAGE=ghcr.io\/example\/obsidian-lan-sync-couchdb:0.3.0/);
  assert.match(env, /COUCHDB_PASSWORD=[a-f0-9]{64}\n/); assert.doesNotMatch(first.stdout, /COUCHDB_PASSWORD=/);
  assert.doesNotMatch(compose, /^\s*build:/m); assert.match(compose, /image: \$\{SYNC_IMAGE/); assert.match(compose, /image: \$\{COUCHDB_IMAGE/);
  const again = spawnSync(bash, args, { encoding: 'utf8', windowsHide: true }); assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), env);
  const bad = spawnSync(bash, [...args, '--version', 'latest'], { encoding: 'utf8', windowsHide: true }); assert.notEqual(bad.status, 0);
});
