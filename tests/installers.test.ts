import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
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
async function command(file: string, args: string[], env?: NodeJS.ProcessEnv, input = ''): Promise<{ code: number | null; output: string }> {
  return new Promise((done, fail) => { const child = spawn(file, args, { windowsHide: true, timeout: 45000, env: env ?? process.env }); let output = '';
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; }); child.on('error', fail); child.on('close', code => done({ code, output })); });
}
test('Windows installer discovers one registered Vault without requiring a path or changing the registry', { skip: process.platform !== 'win32' }, async t => {
  const root = temp(t), distribution = assets(root), f = await fixture(t, distribution);
  const vault = join(root, '唯一笔记库 with spaces'), appdata = join(root, 'appdata');
  mkdirSync(join(vault, '.obsidian'), { recursive: true }); mkdirSync(join(appdata, 'obsidian'), { recursive: true });
  const registry = JSON.stringify({ vaults: { test: { path: vault, ts: 1, open: true } } });
  writeFileSync(join(appdata, 'obsidian', 'obsidian.json'), registry);
  const result = await command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('deployment/install.ps1'), '-Connection', encodeConnection(f.url, 'c'.repeat(24))], { ...process.env, APPDATA: appdata });
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(join(vault, '.obsidian', 'plugins', 'lan-note-sync', 'bootstrap.json')), true);
  assert.equal(readFileSync(join(appdata, 'obsidian', 'obsidian.json'), 'utf8'), registry);
});
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
test('downloaded PowerShell command preserves Chinese text and installs successfully', {skip: process.platform !== 'win32'}, async t => {
  const root = temp(t), f = await fixture(t, assets(root)), vault = join(root, '中文命令测试');
  mkdirSync(join(vault, '.obsidian'), {recursive: true});
  const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  const script = `$w=New-Object Net.WebClient; $w.Proxy=$null; & ([scriptblock]::Create($w.DownloadString(${quote(f.url + '/install.ps1')}))) -VaultPath ${quote(vault)} -Connection ${quote(encodeConnection(f.url, 'e'.repeat(24)))}`;
  const result = await command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  assert.equal(result.code, 0, result.output); assert.match(result.output, /安装完成/); assert.match(result.output, /首次同步预览/);
});
for (const platform of ['powershell', 'bash'] as const) {
  const bash = process.env.TEST_BASH ?? (process.platform === 'win32' ? 'D:/program/Git/bin/bash.exe' : '/bin/bash');
  test(`${platform} installer preserves notes and existing connection during install and update`, { skip: platform === 'powershell' ? process.platform !== 'win32' : !existsSync(bash) }, async t => {
    const root = temp(t), distribution = assets(root), f = await fixture(t, distribution);
    const vault = join(root, 'Vault with spaces 中文'); mkdirSync(join(vault, '.obsidian', 'plugins', 'other'), { recursive: true });
    writeFileSync(join(vault, '笔记.md'), 'unchanged'); writeFileSync(join(vault, '.obsidian', 'community-plugins.json'), '["other"]');
    const connection = encodeConnection(f.url, 'c'.repeat(24));
    const executable = platform === 'powershell' ? 'powershell.exe' : bash;
    const args = platform === 'powershell' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('deployment/install.ps1'), '-VaultPath', vault, '-Connection', connection] : [posix(resolve('deployment/install.sh')), '--vault', posix(vault), '--connection', connection];
    const result = await command(executable, args); assert.equal(result.code, 0, result.output);
    assert.match(result.output, /安装完成/); assert.match(result.output, /连接配置已写入/);
    const plugin = join(vault, '.obsidian', 'plugins', 'lan-note-sync');
    const bootstrap = JSON.parse(readFileSync(join(plugin, 'bootstrap.json'), 'utf8').replace(/^\ufeff/, ''));
    assert.equal(bootstrap.connection, connection); assert.equal(readFileSync(join(vault, '笔记.md'), 'utf8'), 'unchanged');
    assert.equal(readFileSync(join(vault, '.obsidian', 'community-plugins.json'), 'utf8'), '["other"]');
    assert.equal(readFileSync(join(plugin, 'main.js'), 'utf8'), 'module.exports = {};\n');
    const renewed = encodeConnection(f.url, 'd'.repeat(24));
    const refreshed = await command(executable, args.map(arg => arg === connection ? renewed : arg));
    if (refreshed.code !== 0) assert.match(refreshed.output, /请先完全退出 Obsidian/);
    else assert.equal(JSON.parse(readFileSync(join(plugin, 'bootstrap.json'), 'utf8').replace(/^\ufeff/, '')).connection, renewed);
    writeFileSync(join(plugin, 'data.json'), JSON.stringify({ vaultId: 'existing-vault', secretId: 'existing-secret' }));
    // The same enrollment command upgrades an older bound installation without
    // any upgrade flag and must retain its connection and sync state.
    writeFileSync(join(plugin, 'manifest.json'), JSON.stringify({id: 'lan-note-sync', version: '0.2.0'}));
    writeFileSync(join(plugin, 'main.js'), 'old plugin');
    mkdirSync(join(plugin, 'local-state'), {recursive: true});
    writeFileSync(join(plugin, 'local-state', 'retained.json'), '{"pending":"keep"}');
    const again = await command(executable, [...args, ...(platform === 'powershell' ? ['-ConnectionAction', 'Keep'] : ['--connection-action', 'keep'])]);
    if (again.code !== 0) assert.match(again.output, /请先完全退出 Obsidian/);
    else {
      assert.match(again.output, /原有.*配置和同步状态已保留/);
      assert.equal(JSON.parse(readFileSync(join(plugin, 'manifest.json'), 'utf8')).version, '0.3.0');
      assert.equal(readFileSync(join(plugin, 'main.js'), 'utf8'), 'module.exports = {};\n');
      assert.equal(readFileSync(join(plugin, 'local-state', 'retained.json'), 'utf8'), '{"pending":"keep"}');
      assert.deepEqual(JSON.parse(readFileSync(join(plugin, 'data.json'), 'utf8')), { vaultId: 'existing-vault', secretId: 'existing-secret' });
      assert.equal(JSON.parse(readFileSync(join(plugin, 'bootstrap.json'), 'utf8').replace(/^\ufeff/, '')).connection, refreshed.code === 0 ? renewed : connection);
    }
    assert.equal(readFileSync(join(vault, '笔记.md'), 'utf8'), 'unchanged');
  });
  test(`${platform} installer switches only with confirmation, backs up old state and starts unbound`, {skip: platform === 'powershell' ? process.platform !== 'win32' : !existsSync(bash)}, async t => {
    const root = temp(t), distribution = assets(root), f = await fixture(t, distribution);
    const vault = join(root, '素材库'), plugin = join(vault, '.obsidian', 'plugins', 'lan-note-sync');
    mkdirSync(join(plugin, 'local-state'), {recursive: true});
    const settings = JSON.stringify({server: f.url, vaultId: id(), vaultName: 'My Notes', secretId: 'keep-secret-reference', enabled: true});
    writeFileSync(join(plugin, 'data.json'), settings);
    writeFileSync(join(plugin, 'local-state', 'state.json'), '{"oldBaseline":true}');
    writeFileSync(join(plugin, 'pair-claim.json'), '{"oldClaim":true}');
    writeFileSync(join(plugin, 'main.js'), 'old plugin'); writeFileSync(join(vault, '笔记.md'), 'local note');
    const connection = encodeConnection(f.url, 'f'.repeat(24), {id: id(), name: '学堂素材库（测试）'});
    const executable = platform === 'powershell' ? 'powershell.exe' : bash;
    const args = platform === 'powershell'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('deployment/install.ps1'), '-VaultPath', vault, '-Connection', connection]
      : [posix(resolve('deployment/install.sh')), '--vault', posix(vault), '--connection', connection];
    const cancelled = await command(executable, args, undefined, '0\n');
    assert.notEqual(cancelled.code, 0); assert.equal(readFileSync(join(plugin, 'data.json'), 'utf8'), settings);
    assert.equal(readFileSync(join(plugin, 'main.js'), 'utf8'), 'old plugin');
    const result = await command(executable, [...args, ...(platform === 'powershell' ? ['-ConnectionAction', 'Switch', '-ConfirmSwitch'] : ['--connection-action', 'switch', '--confirm-switch'])]);
    assert.equal(result.code, 0, result.output); assert.match(result.output, /学堂素材库（测试）/); assert.match(result.output, /已准备切换仓库/);
    assert.deepEqual(JSON.parse(readFileSync(join(plugin, 'data.json'), 'utf8')), {enabled: false});
    assert.equal(existsSync(join(plugin, 'local-state')), false); assert.equal(existsSync(join(plugin, 'pair-claim.json')), false);
    assert.equal(JSON.parse(readFileSync(join(plugin, 'bootstrap.json'), 'utf8').replace(/^\ufeff/, '')).connection, connection);
    assert.equal(readFileSync(join(vault, '笔记.md'), 'utf8'), 'local note');
    const backupRoot = join(vault, '.obsidian', 'lan-note-sync-backups'), backups = readdirSync(backupRoot);
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(backupRoot, backups[0], 'data.json'), 'utf8'), settings);
    assert.equal(readFileSync(join(backupRoot, backups[0], 'local-state', 'state.json'), 'utf8'), '{"oldBaseline":true}');
  });
  test(`${platform} installer rejects a damaged download before replacing an existing installation`, { skip: platform === 'powershell' ? process.platform !== 'win32' : !existsSync(bash) }, async t => {
    const root = temp(t), distribution = assets(root), normal = distribution.serve.bind(distribution);
    distribution.serve = (path, res) => { if (path === '/install/files/main.js') { res.writeHead(200); res.end('corrupt'); return true; } return normal(path, res); };
    const f = await fixture(t, distribution), vault = join(root, 'Vault'); mkdirSync(join(vault, '.obsidian'), { recursive: true });
    const connection = encodeConnection(f.url, 'c'.repeat(24));
    const result = platform === 'powershell' ? await command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('deployment/install.ps1'), '-VaultPath', vault, '-Connection', connection]) : await command(bash, [posix(resolve('deployment/install.sh')), '--vault', posix(vault), '--connection', connection]);
    assert.notEqual(result.code, 0); assert.match(result.output, /插件下载校验失败/);
    assert.equal(existsSync(join(vault, '.obsidian', 'plugins', 'lan-note-sync')), false);
  });
}
