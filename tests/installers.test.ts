import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { Distribution } from '../server/distribution';
import { encodeConnection } from '../shared/connection';
import { id } from '../shared/protocol';
import { fixture } from './helpers';

function temp(t: TestContext) {
  const base = resolve('.test-runtime'), root = join(base, 'installer-' + id()); mkdirSync(root, { recursive: true });
  t.after(() => { if (!root.startsWith(base + sep)) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); }); return root;
}
function assets(root: string) {
  mkdirSync(join(root, 'plugin'));
  writeFileSync(join(root, 'plugin', 'manifest.json'), JSON.stringify({ id: 'lan-note-sync', version: '0.3.0', minAppVersion: '1.11.4' }));
  writeFileSync(join(root, 'plugin', 'main.js'), 'module.exports = {};\n'); writeFileSync(join(root, 'plugin', 'styles.css'), '/* test */');
  for (const name of ['install.ps1', 'install.sh']) copyFileSync(join('deployment', name), join(root, name));
  return new Distribution(root);
}
async function command(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((done, fail) => { const child = spawn(file, args, { windowsHide: true, timeout: 45000, env: env ?? process.env }); let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; }); child.on('error', fail); child.on('close', code => done({ code, output })); });
}
test('Windows installer discovers one registered Vault without requiring a path or changing the registry', { skip: process.platform !== 'win32' }, async t => {
  const root = temp(t), distribution = assets(root), f = await fixture(t, distribution);
  const vault = join(root, '唯一笔记库 with spaces'), appdata = join(root, 'appdata');
  mkdirSync(join(vault, '.obsidian'), { recursive: true }); mkdirSync(join(appdata, 'obsidian'), { recursive: true });
  const registry = JSON.stringify({ vaults: { test: { path: vault, ts: 1, open: true } } });
  writeFileSync(join(appdata, 'obsidian', 'obsidian.json'), registry);
  const result = await command('powershell.exe', ['-NoProfile', '-File', resolve('deployment/install.ps1'), '-Connection', encodeConnection(f.url, 'c'.repeat(24))], { ...process.env, APPDATA: appdata });
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(join(vault, '.obsidian', 'plugins', 'lan-note-sync', 'bootstrap.json')), true);
  assert.equal(readFileSync(join(appdata, 'obsidian', 'obsidian.json'), 'utf8'), registry);
});
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
for (const platform of ['powershell', 'bash'] as const) {
  const bash = process.env.TEST_BASH ?? (process.platform === 'win32' ? 'D:/program/Git/bin/bash.exe' : '/bin/bash');
  test(`${platform} installer preserves notes and other plugins, pre-fills enrollment, and refuses an implicit reinstall`, { skip: platform === 'powershell' ? process.platform !== 'win32' : !existsSync(bash) }, async t => {
    const root = temp(t), distribution = assets(root), f = await fixture(t, distribution);
    const vault = join(root, 'Vault with spaces 中文'); mkdirSync(join(vault, '.obsidian', 'plugins', 'other'), { recursive: true });
    writeFileSync(join(vault, '笔记.md'), 'unchanged'); writeFileSync(join(vault, '.obsidian', 'community-plugins.json'), '["other"]');
    const connection = encodeConnection(f.url, 'c'.repeat(24));
    const executable = platform === 'powershell' ? 'powershell.exe' : bash;
    const args = platform === 'powershell' ? ['-NoProfile', '-File', resolve('deployment/install.ps1'), '-VaultPath', vault, '-Connection', connection] : [posix(resolve('deployment/install.sh')), '--vault', posix(vault), '--connection', connection];
    const result = await command(executable, args); assert.equal(result.code, 0, result.output);
    const plugin = join(vault, '.obsidian', 'plugins', 'lan-note-sync');
    const bootstrap = JSON.parse(readFileSync(join(plugin, 'bootstrap.json'), 'utf8').replace(/^\ufeff/, ''));
    assert.equal(bootstrap.connection, connection); assert.equal(readFileSync(join(vault, '笔记.md'), 'utf8'), 'unchanged');
    assert.equal(readFileSync(join(vault, '.obsidian', 'community-plugins.json'), 'utf8'), '["other"]');
    assert.equal(readFileSync(join(plugin, 'main.js'), 'utf8'), 'module.exports = {};\n');
    const again = await command(executable, args); assert.notEqual(again.code, 0);
  });
  test(`${platform} installer rejects a damaged download before replacing an existing installation`, { skip: platform === 'powershell' ? process.platform !== 'win32' : !existsSync(bash) }, async t => {
    const root = temp(t), distribution = assets(root), normal = distribution.serve.bind(distribution);
    distribution.serve = (path, res) => { if (path === '/install/files/main.js') { res.writeHead(200); res.end('corrupt'); return true; } return normal(path, res); };
    const f = await fixture(t, distribution), vault = join(root, 'Vault'); mkdirSync(join(vault, '.obsidian'), { recursive: true });
    const connection = encodeConnection(f.url, 'c'.repeat(24));
    const result = platform === 'powershell' ? await command('powershell.exe', ['-NoProfile', '-File', resolve('deployment/install.ps1'), '-VaultPath', vault, '-Connection', connection]) : await command(bash, [posix(resolve('deployment/install.sh')), '--vault', posix(vault), '--connection', connection]);
    assert.notEqual(result.code, 0); assert.equal(existsSync(join(vault, '.obsidian', 'plugins', 'lan-note-sync')), false);
  });
}
