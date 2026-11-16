import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fixture, revision } from './helpers';
import { Engine, newState } from '../src/sync/engine';
import { hash, id } from '../shared/protocol';

class TFile { extension: string; stat: {size: number}; constructor(readonly path: string, size: number) { this.extension = path.split('.').pop()!; this.stat = {size}; } }
class TFolder { constructor(readonly path: string) {} }
class FileView { constructor(readonly file: TFile) {} }
class FileSystemAdapter {
  constructor(readonly root: string) {}
  getBasePath() { return this.root; }
  async rmdir(path: string, recursive: boolean) {
    assert.equal(recursive, false);
    const target = resolve(this.root, path), rel = relative(this.root, target);
    assert.ok(rel && !rel.startsWith('..' + sep) && rel !== '..'); nodeRequire('node:fs').rmSync(target, {recursive}); // Match Obsidian 1.15.1, including EISDIR.
  }
}
const nodeRequire = createRequire(resolve('package.json'));
const code = nodeRequire('esbuild').buildSync({entryPoints: ['src/sync/obsidian-vault.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false}).outputFiles[0].text;
const exported: {exports: any} = {exports: {}};
let beforeNativeRemove: ((path: string) => void) | undefined;
const fsForPlugin = {...nodeRequire('node:fs'), rmdirSync(path: string) { beforeNativeRemove?.(path); return rmdirSync(path); }};
new Function('require', 'module', 'exports', code)((name: string) => name === 'obsidian' ? {TFile, TFolder, FileView, FileSystemAdapter} : name === 'node:fs' ? fsForPlugin : nodeRequire(name), exported, exported.exports);
const ObsidianVault = exported.exports.ObsidianVault;
function desktop(root: string) {
  mkdirSync(root); const adapter = new FileSystemAdapter(root), preserved: Buffer[] = [], opened: string[] = [];
  const get = (path: string) => {
    const full = join(root, path); if (!existsSync(full)) return null;
    const stat = lstatSync(full); return stat.isDirectory() ? new TFolder(path) : new TFile(path, stat.size);
  };
  const app = {vault: {adapter, configDir: '.obsidian', getAbstractFileByPath: get,
    readBinary: async (file: TFile) => readFileSync(join(root, file.path)),
    createFolder: async (path: string) => mkdirSync(join(root, path)),
    createBinary: async (path: string, bytes: ArrayBuffer) => writeFileSync(join(root, path), Buffer.from(bytes), {flag: 'wx'}),
    modifyBinary: async (file: TFile, bytes: ArrayBuffer) => writeFileSync(join(root, file.path), Buffer.from(bytes)),
    process: async (file: TFile, transform: (text: string) => string) => writeFileSync(join(root, file.path), transform(readFileSync(join(root, file.path), 'utf8'))),
  }, workspace: {iterateAllLeaves: (callback: (leaf: any) => void) => opened.forEach(path => callback({view: new FileView(new TFile(path, 0))}))},
  fileManager: {trashFile: async (file: TFile) => { mkdirSync(join(root, '.trash'), {recursive: true}); renameSync(join(root, file.path), join(root, '.trash', id())); }}};
  const local = new ObsidianVault(app, {preserve: async (bytes: Buffer) => { preserved.push(Buffer.from(bytes)); }});
  return {local, root, adapter, opened, preserved, put(path: string, bytes: Buffer | string) { mkdirSync(join(root, path, '..'), {recursive: true}); writeFileSync(join(root, path), bytes); }};
}

test('desktop cloud overwrite removes real nested empty directories and preserves excluded/hidden descendants', async t => {
  const f = await fixture(t), d = desktop(join(f.root, 'vault'));
  mkdirSync(join(d.root, '空目录', 'nested', '第三层'), {recursive: true});
  await assert.rejects(d.adapter.rmdir('空目录/nested/第三层', false), /EISDIR/); d.put('.obsidian/data.json', '{}'); d.put('keep/.hidden', 'private'); d.put('keep/remove.txt', 'remove'); d.put('excluded/file.txt', 'exclude');
  f.store.setExclusions(f.first.vaultId, ['excluded/**']);
  const e = new Engine(f.remoteA, d.local, newState(f.store.serverId, f.first.vaultId, f.first.deviceId), async () => {});
  await e.startOverwrite(await e.previewOverwrite('cloud-to-local'));
  assert.equal(existsSync(join(d.root, '空目录')), false); assert.equal(existsSync(join(d.root, 'keep/remove.txt')), false);
  assert.equal(readFileSync(join(d.root, 'keep/.hidden'), 'utf8'), 'private'); assert.equal(readFileSync(join(d.root, 'excluded/file.txt'), 'utf8'), 'exclude'); assert.ok(existsSync(join(d.root, '.obsidian/data.json')));
});
test('desktop replacement supports file-to-directory and directory-to-binary-file with byte verification', async t => {
  const f = await fixture(t), d = desktop(join(f.root, 'vault')), bytes = Buffer.from([255,0,128,10]);
  d.put('as-dir', 'old file'); d.put('as-file/child.txt', 'old child');
  for (const [path, content, kind] of [['as-dir', Buffer.alloc(0), 'directory'], ['as-dir/empty', Buffer.alloc(0), 'directory'], ['as-file', bytes, undefined]] as const) {
    const r = revision(f.second.deviceId, content, {path, kind}); await f.remoteB.put(content, r.hash!); await f.remoteB.commit(r);
  }
  const e = new Engine(f.remoteA, d.local, newState(f.store.serverId, f.first.vaultId, f.first.deviceId), async () => {});
  await e.startOverwrite(await e.previewOverwrite('cloud-to-local'));
  assert.ok(lstatSync(join(d.root, 'as-dir/empty')).isDirectory()); assert.deepEqual(readFileSync(join(d.root, 'as-file')), bytes);
  assert.equal(d.preserved.length, 2); await e.sync(); assert.deepEqual(e.state.issues, {});
});
test('desktop directory delete uses an OS nonrecursive operation even if a child appears at removal', async t => {
  const f = await fixture(t), d = desktop(join(f.root, 'vault')); mkdirSync(join(d.root, 'empty'));
  beforeNativeRemove = path => { assert.equal(path, resolve(d.root, 'empty')); d.put('empty/arrived.txt', 'keep'); };
  t.after(() => { beforeNativeRemove = undefined; });
  await assert.rejects(d.local.apply({oldPath: 'empty', path: 'empty', kind: 'directory', expectedKind: 'directory', expectedHash: hash(''), content: null}), /出现了新内容/);
  assert.equal(readFileSync(join(d.root, 'empty/arrived.txt'), 'utf8'), 'keep');
});
test('desktop scanning includes non-Markdown and empty files; an open attachment blocks overwrite', async t => {
  const f = await fixture(t), d = desktop(join(f.root, 'vault')); d.put('drawing.canvas', '{}'); d.put('photo.png', Buffer.from([255,0])); d.put('empty', '');
  const scan = await d.local.scan(); assert.equal(scan.size, 3); assert.deepEqual(scan.get('photo.png'), Buffer.from([255,0]));
  d.opened.push('photo.png'); assert.throws(() => d.local.assertClosed(['photo.png']), /正在打开/);
  assert.deepEqual(readFileSync(join(d.root, 'photo.png')), Buffer.from([255,0]));
});
