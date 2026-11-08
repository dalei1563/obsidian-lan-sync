import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isTailnetIPv4 } from '../shared/network';
import { id } from '../shared/protocol';
import { decodeConnection } from '../shared/connection';

const cases: [string, boolean][] = [
  ['100.63.255.255', false], ['100.64.0.0', true], ['100.64.10.20', true],
  ['100.127.255.255', true], ['100.128.0.0', false], ['100.90.example.com', false],
];
test('Tailscale proxy bypass matches precisely the shared IPv4 range, including both boundaries', () => {
  for (const [host, expected] of cases) assert.equal(isTailnetIPv4(host), expected, host);
  for (const host of ['100.90.256.1', '100.90.1', '100.90.1.2.example.com', 'https://100.64.10.20']) assert.equal(isTailnetIPv4(host), false, host);
});

function runtime(t: TestContext) {
  const base = resolve('.test-runtime'), root = join(base, 'tailnet-' + id()); mkdirSync(root, { recursive: true });
  t.after(() => { if (!root.startsWith(base + sep)) throw Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); }); return root;
}
async function invoke(file: string, args: string[], env = process.env) {
  return new Promise<{ code: number | null; output: string }>((done, fail) => {
    const p = spawn(file, args, { env, windowsHide: true, timeout: 30000 }); let output = '';
    p.stdout.on('data', b => output += b); p.stderr.on('data', b => output += b); p.once('error', fail); p.once('close', code => done({ code, output }));
  });
}
test('generated desktop install commands bypass proxy for tailnet URLs while public 100/8 URLs retain it', async t => {
  const root = runtime(t);
  for (const [host, direct] of cases) {
    const url = `http://${host}:27123`;
    const r = await invoke(process.execPath, ['dist/server/cli.cjs', 'invite', '--data', root, '--url', url], { ...process.env, SYNC_BACKEND: 'sqlite' });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.output.includes('$w.Proxy=$null'), direct, host);
    assert.equal(r.output.includes("--noproxy '*'"), direct, host);
    const connection = /^lansync:.+$/m.exec(r.output)?.[0].trim(); assert.ok(connection);
    assert.equal(decodeConnection(connection).server, url);
  }
});

test('PowerShell asset downloader applies the tailnet proxy policy at its boundary addresses', { skip: process.platform !== 'win32' }, async () => {
  const policy = readFileSync('deployment/install.ps1', 'utf8').split(/\r?\n/).find(line => line.includes('$handler.UseProxy = $false')); assert.ok(policy);
  for (const [host, direct] of cases) {
    const script = `$server=[pscustomobject]@{Host='${host}'}; $handler=[pscustomobject]@{UseProxy=$true}; ${policy}; [Console]::Write($handler.UseProxy)`;
    const r = await invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    assert.equal(r.code, 0, r.output); assert.equal(r.output.trim().toLowerCase(), direct ? 'false' : 'true', host);
  }
});
const bash = process.env.TEST_BASH ?? (process.platform === 'win32' ? 'D:/program/Git/bin/bash.exe' : '/bin/bash');
test('Bash asset downloader applies the tailnet proxy policy at its boundary addresses', { skip: !existsSync(bash) }, () => {
  const source = readFileSync('deployment/install.sh', 'utf8'), start = source.indexOf('curl_options='), end = source.indexOf('mkdir -p "$plugins"', start);
  assert.ok(start >= 0 && end > start); const policy = source.slice(start, end);
  for (const [host, direct] of cases) {
    const script = `server='http://${host}:27123'\n${policy}\nprintf '%s\\n' "\${curl_options[@]}"`;
    const r = spawnSync(bash, ['-c', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.includes('--noproxy'), direct, host);
  }
});
