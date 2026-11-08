import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { id } from '../shared/protocol';

const bash = process.platform === 'win32' ? 'D:/program/Git/bin/bash.exe' : '/bin/bash';
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());

function bindRuntime(t: TestContext) {
  const base = resolve('.test-runtime'), root = join(base, 'bind-images-' + id()); mkdirSync(root, { recursive: true });
  t.after(() => { if (!root.startsWith(base + sep)) throw Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); });
  return root;
}
function prepare(args: string[]) {
  return spawnSync(bash, [posix(resolve('deployment/setup-images.sh')), '--image-prefix', 'ghcr.io/example/obsidian-lan-sync', '--prepare-only', ...args], { encoding: 'utf8', windowsHide: true });
}
function setting(env: string, name: string): string {
  const line = env.split(/\r?\n/).find(line => line.startsWith(name + '=')); assert.ok(line, 'Missing setting ' + name);
  const value = line.slice(name.length + 1);
  return value.replace(/^(['"])(.*)\1$/, '$2');
}
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

test('SSH deployment starts containers without a server address and defers device invitations', { skip: !existsSync(bash) }, t => {
  const base = resolve('.test-runtime'), root = join(base, 'ssh-images-' + id()); mkdirSync(join(root, 'bin'), { recursive: true });
  t.after(() => { if (!root.startsWith(base + sep)) throw Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); });
  const log = join(root, 'docker.log'), fake = join(root, 'bin', 'docker');
  writeFileSync(fake, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG"\n'); chmodSync(fake, 0o755);
  const script = 'export PATH="' + posix(join(root, 'bin')) + ':$PATH"; exec bash "$@"';
  const args = ['-c', script, 'deployment-test', posix(resolve('deployment/setup-images.sh')), '--image-prefix', 'ghcr.io/example/obsidian-lan-sync', '--out', posix(join(root, 'deploy')), '--expose-lan'];
  const env = { ...process.env, DEPLOY_TEST_LOG: posix(log) };
  const first = spawnSync(bash, args, { env, encoding: 'utf8', windowsHide: true }); assert.equal(first.status, 0, first.stderr);
  const commands = readFileSync(log, 'utf8');
  assert.match(commands, /compose pull/); assert.match(commands, /compose up -d --wait/); assert.doesNotMatch(commands, /invite/);
  assert.match(first.stdout, /No device address was required/);
  const settings = readFileSync(join(root, 'deploy', '.env'), 'utf8');
  assert.match(settings, /SYNC_PUBLIC_URL=\n/); assert.match(settings, /SYNC_LISTEN_ADDRESS=0\.0\.0\.0/);
  const again = spawnSync(bash, [...args, '--public-url', 'http://192.168.1.10:27123'], { env, encoding: 'utf8', windowsHide: true }); assert.equal(again.status, 0, again.stderr);
  assert.match(readFileSync(log, 'utf8'), /invite --url http:\/\/192\.168\.1\.10:27123/);
  assert.equal(readFileSync(join(root, 'deploy', '.env'), 'utf8'), settings);
});

test('data-disk preparation creates isolated data directories and deployment config, including spaces in paths', { skip: !existsSync(bash) }, t => {
  const root = bindRuntime(t), data = join(root, 'data disk app');
  const first = prepare(['--data-dir', posix(data)]); assert.equal(first.status, 0, first.stderr);
  assert.equal(existsSync(join(data, 'couchdb')), true); assert.equal(existsSync(join(data, 'gateway')), true);
  const deployment = join(data, 'deployment'), env = readFileSync(join(deployment, '.env'), 'utf8');
  assert.equal(setting(env, 'COUCHDB_DATA_DIR'), posix(join(data, 'couchdb')));
  assert.equal(setting(env, 'GATEWAY_DATA_DIR'), posix(join(data, 'gateway')));
  assert.equal(setting(env, 'BIND_LABEL_SUFFIX'), ':Z');
  assert.match(env, /COUCHDB_PASSWORD=[a-f0-9]{64}\n/); assert.doesNotMatch(first.stdout, /COUCHDB_PASSWORD=/);
  const compose = readFileSync(join(deployment, 'compose.yaml'), 'utf8');
  assert.match(compose, /\$\{COUCHDB_DATA_DIR:-couch-data\}/); assert.match(compose, /\$\{GATEWAY_DATA_DIR:-gateway-data\}/);
  const again = prepare(['--data-dir', posix(data)]); assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(deployment, '.env'), 'utf8'), env);
});

test('an explicit config directory is preserved while data-disk changes are rejected', { skip: !existsSync(bash) }, t => {
  const root = bindRuntime(t), data = join(root, 'data-root'), output = join(root, 'configuration');
  const first = prepare(['--data-dir', posix(data), '--out', posix(output)]); assert.equal(first.status, 0, first.stderr);
  const original = readFileSync(join(output, '.env'), 'utf8'); assert.equal(existsSync(join(data, 'deployment')), false);
  const same = prepare(['--data-dir', posix(data), '--out', posix(output)]); assert.equal(same.status, 0, same.stderr);
  const changed = prepare(['--data-dir', posix(join(root, 'other-data')), '--out', posix(output)]); assert.notEqual(changed.status, 0);
  assert.equal(readFileSync(join(output, '.env'), 'utf8'), original);
});

test('existing named-volume deployments are not silently switched to empty data-disk directories', { skip: !existsSync(bash) }, t => {
  const root = bindRuntime(t), output = join(root, 'existing'), data = join(root, 'new-data');
  const first = prepare(['--out', posix(output)]); assert.equal(first.status, 0, first.stderr);
  const originalEnv = readFileSync(join(output, '.env'), 'utf8'), originalCompose = readFileSync(join(output, 'compose.yaml'), 'utf8');
  const changed = prepare(['--out', posix(output), '--data-dir', posix(data)]); assert.notEqual(changed.status, 0);
  assert.equal(readFileSync(join(output, '.env'), 'utf8'), originalEnv);
  assert.equal(readFileSync(join(output, 'compose.yaml'), 'utf8'), originalCompose);
});

test('data-disk preparation rejects relative paths, filesystem root and an absent disk parent', { skip: !existsSync(bash) }, t => {
  const root = bindRuntime(t);
  for (const data of ['relative-data', '/', posix(join(root, 'missing-mount', 'app'))]) {
    const result = prepare(['--data-dir', data, '--out', posix(join(root, 'configuration'))]); assert.notEqual(result.status, 0, data);
  }
  assert.equal(existsSync(join(root, 'missing-mount')), false);
  assert.equal(existsSync(join(root, 'configuration', '.env')), false);
});

test('data-disk preparation rejects symbolic-link directories and parents', { skip: !existsSync(bash) || process.platform === 'win32' }, t => {
  const root = bindRuntime(t), actual = join(root, 'actual'), link = join(root, 'linked');
  mkdirSync(actual); symlinkSync(actual, link, 'dir');
  for (const data of [link, join(link, 'app')]) {
    const result = prepare(['--data-dir', data, '--out', join(root, 'configuration')]); assert.notEqual(result.status, 0);
  }
  assert.equal(existsSync(join(actual, 'app')), false);
});

test('data-disk startup initializes both mount owners using restricted helper containers before starting services', { skip: !existsSync(bash) }, t => {
  const root = bindRuntime(t), data = join(root, 'data-root'); mkdirSync(join(root, 'bin'));
  const log = join(root, 'docker.log'), fake = join(root, 'bin', 'docker');
  writeFileSync(fake, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG"\n'); chmodSync(fake, 0o755);
  const shell = 'export PATH="' + posix(join(root, 'bin')) + ':$PATH"; exec bash "$@"';
  const result = spawnSync(bash, ['-c', shell, 'deployment-test', posix(resolve('deployment/setup-images.sh')), '--image-prefix', 'ghcr.io/example/obsidian-lan-sync', '--data-dir', posix(data)], { env: { ...process.env, DEPLOY_TEST_LOG: posix(log) }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const commands = readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean), helpers = commands.filter(line => line.startsWith('run '));
  assert.equal(helpers.length, 2); assert.match(helpers.join('\n'), /5984/); assert.match(helpers.join('\n'), /1000/);
  for (const helper of helpers) {
    assert.match(helper, /--cap-drop[= ]ALL/); assert.match(helper, /--cap-add[= ]CHOWN/); assert.match(helper, /--cap-add[= ]FOWNER/);
    assert.doesNotMatch(helper, /--privileged/); assert.match(helper, /--rm/);
  }
  const up = commands.findIndex(line => line.startsWith('compose up ')); assert.ok(up >= 0);
  assert.ok(commands.every((line, index) => !line.startsWith('run ') || index < up));
  // A second helper mount with :Z would relabel a directory under a live
  // service. Existing bind deployments must skip permission initialization.
  const again = spawnSync(bash, ['-c', shell, 'deployment-test', posix(resolve('deployment/setup-images.sh')), '--image-prefix', 'ghcr.io/example/obsidian-lan-sync', '--out', posix(join(data, 'deployment'))], { env: { ...process.env, DEPLOY_TEST_LOG: posix(log) }, encoding: 'utf8', windowsHide: true });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(log, 'utf8').split(/\r?\n/).filter(line => line.startsWith('run ')).length, 2);
});

test('data-disk deployment refuses to replace an existing project owned by another configuration directory', { skip: !existsSync(bash) }, t => {
  const root = bindRuntime(t), data = join(root, 'data-root'); mkdirSync(join(root, 'bin'));
  const log = join(root, 'docker.log'), fake = join(root, 'bin', 'docker');
  writeFileSync(fake, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG"\ncase "$1" in ps) echo existing-container;; inspect) echo /opt/original-deployment;; esac\n'); chmodSync(fake, 0o755);
  const shell = 'export PATH="' + posix(join(root, 'bin')) + ':$PATH"; exec bash "$@"';
  const result = spawnSync(bash, ['-c', shell, 'deployment-test', posix(resolve('deployment/setup-images.sh')), '--image-prefix', 'ghcr.io/example/obsidian-lan-sync', '--data-dir', posix(data)], { env: { ...process.env, DEPLOY_TEST_LOG: posix(log) }, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /another deployment directory/);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /compose (up|pull)|^run /m);
  assert.equal(existsSync(join(data, 'deployment', '.env')), false);
});
