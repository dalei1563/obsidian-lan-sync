import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../shared/protocol';
import {updatePlugin} from '../src/sync/updater';
import type {Transport} from '../src/sync/remote';

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'lan-update-test-')), root = join(temp, '.obsidian', 'plugins', 'lan-note-sync');
  mkdirSync(root, {recursive: true});
  const manifest = (v: string) => JSON.stringify({id: 'lan-note-sync', version: v, minAppVersion: '1.5.0'});
  writeFileSync(join(root, 'manifest.json'), manifest('0.4.0')); writeFileSync(join(root, 'main.js'), 'old js'); writeFileSync(join(root, 'styles.css'), 'old css');
  writeFileSync(join(root, 'data.json'), 'private settings');
  const files: Record<string, Buffer> = {'manifest.json': Buffer.from(manifest('0.5.0')), 'main.js': Buffer.from('new js'), 'styles.css': Buffer.from('new css')};
  const info = {id: 'lan-note-sync', version: '0.5.0', minAppVersion: '1.5.0', files: Object.entries(files).map(([name, bytes]) => ({name, size: bytes.length, sha256: hash(bytes)}))};
  const transport: Transport = async url => ({status: 200, body: url.endsWith('/install/manifest') ? Buffer.from(JSON.stringify(info)) : files[url.split('/').pop()!]});
  return {temp, root, info, files, transport, cleanup: () => rmSync(temp, {recursive: true, force: true})};
}
test('automatic update verifies assets, preserves configuration, retains backup and avoids repeated installs', async t => {
  const f = fixture(); t.after(f.cleanup);
  assert.equal(await updatePlugin('http://127.0.0.1:27123', f.root, '0.4.0', f.transport, () => true), '0.5.0');
  assert.equal(readFileSync(join(f.root, 'main.js'), 'utf8'), 'new js'); assert.equal(readFileSync(join(f.root, 'data.json'), 'utf8'), 'private settings');
  assert.equal(await updatePlugin('http://127.0.0.1:27123', f.root, '0.4.0', f.transport, () => true), null);
});
test('automatic update leaves all installed files untouched when a download is corrupt or incompatible', async t => {
  const f = fixture(); t.after(f.cleanup); f.files['main.js'] = Buffer.from('modified');
  await assert.rejects(updatePlugin('http://127.0.0.1:27123', f.root, '0.4.0', f.transport, () => true), /校验失败/);
  assert.equal(readFileSync(join(f.root, 'main.js'), 'utf8'), 'old js'); assert.equal(readFileSync(join(f.root, 'manifest.json'), 'utf8').includes('0.4.0'), true);
  await assert.rejects(updatePlugin('http://127.0.0.1:27123', f.root, '0.4.0', f.transport, () => false), /更新 Obsidian/);
});
