import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
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
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  assert.equal(setting(env, 'SYNC_IMAGE'), `ghcr.io/example/obsidian-lan-sync:${version}`);
  assert.equal(setting(env, 'COUCHDB_IMAGE'), `ghcr.io/example/obsidian-lan-sync-couchdb:${version}`);
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

function legacyCompose(compose: string): string {
  return compose.replace(/^.*SYNC_ADMIN_(?:PASSWORD|SECURE_COOKIE):.*\r?\n/gm, '');
}

test('re-running an old deployment enables admin environment mappings and preserves existing images and custom Compose settings', { skip: !existsSync(bash) }, t => {
  const root = bindRuntime(t), args = ['--out', posix(root)];
  assert.equal(prepare(args).status, 0);
  const envPath = join(root, '.env'), composePath = join(root, 'compose.yaml');
  const oldEnv = readFileSync(envPath, 'utf8').replace(/^SYNC_IMAGE=.*$/m, 'SYNC_IMAGE=ghcr.io/original/sync:0.3.1').replace(/^COUCHDB_IMAGE=.*$/m, 'COUCHDB_IMAGE=ghcr.io/original/sync-couchdb:0.3.1').replace(/^SYNC_ADMIN_PASSWORD=.*\n/m, '');
  const oldCompose = legacyCompose(readFileSync(composePath, 'utf8')).replace('name: lan-note-sync-couch', 'name: custom-notes').replace(':27123:27123', ':29999:27123').replace('gateway-data}:/data', 'custom-gateway-volume}:/data');
  writeFileSync(envPath, oldEnv); writeFileSync(composePath, oldCompose);
  const result = prepare([...args, '--version', '0.4.0', '--public-url', 'http://192.0.2.1:27123']);
  assert.equal(result.status, 0, result.stderr);
  const updatedEnv = readFileSync(envPath, 'utf8'), updatedCompose = readFileSync(composePath, 'utf8');
  assert.equal(updatedEnv.replace(/^SYNC_ADMIN_PASSWORD=.*\n/m, ''), oldEnv);
  assert.match(setting(updatedEnv, 'SYNC_ADMIN_PASSWORD'), /^[a-f0-9]{32}$/);
  assert.equal(legacyCompose(updatedCompose), oldCompose);
  assert.equal(updatedCompose.match(/^      SYNC_ADMIN_PASSWORD:/gm)?.length, 1);
  assert.equal(updatedCompose.match(/^      SYNC_ADMIN_SECURE_COOKIE:/gm)?.length, 1);
  assert.match(result.stdout, /Use --upgrade/);
  const again = prepare(args); assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(envPath, 'utf8'), updatedEnv); assert.equal(readFileSync(composePath, 'utf8'), updatedCompose);
  assert.doesNotMatch(again.stdout, /Administrator password/);
});

test('explicit upgrade changes only image coordinates and missing admin mappings while preserving data-disk credentials and configuration', { skip: !existsSync(bash) }, t => {
  const root = bindRuntime(t), data = join(root, 'data'), output = join(root, 'deployment');
  const first = prepare(['--data-dir', posix(data), '--out', posix(output), '--public-url', 'http://192.0.2.10:29999', '--expose-lan']);
  assert.equal(first.status, 0, first.stderr);
  const envPath = join(output, '.env'), composePath = join(output, 'compose.yaml');
  const oldEnv = readFileSync(envPath, 'utf8').replace(/^SYNC_IMAGE=.*$/m, 'SYNC_IMAGE=ghcr.io/original/sync:0.3.1').replace(/^COUCHDB_IMAGE=.*$/m, 'COUCHDB_IMAGE=ghcr.io/original/sync-couchdb:0.3.1') + '# operator setting\nCOMPOSE_PROJECT_NAME=custom-notes\nSYNC_ADMIN_SECURE_COOKIE=true\n';
  const oldCompose = legacyCompose(readFileSync(composePath, 'utf8')).replace('name: lan-note-sync-couch', 'name: custom-notes').replace(':27123:27123', ':29999:27123');
  writeFileSync(envPath, oldEnv); writeFileSync(composePath, oldCompose);
  const args = ['--out', posix(output), '--upgrade', '--image-prefix', 'ghcr.io/new-owner/new-sync', '--version', '0.4.0', '--public-url', 'http://192.0.2.99:27123'];
  const result = prepare(args); assert.equal(result.status, 0, result.stderr);
  const updatedEnv = readFileSync(envPath, 'utf8'), updatedCompose = readFileSync(composePath, 'utf8');
  assert.equal(updatedEnv, oldEnv.replace(/^SYNC_IMAGE=.*$/m, 'SYNC_IMAGE=ghcr.io/new-owner/new-sync:0.4.0').replace(/^COUCHDB_IMAGE=.*$/m, 'COUCHDB_IMAGE=ghcr.io/new-owner/new-sync-couchdb:0.4.0'));
  assert.equal(legacyCompose(updatedCompose), oldCompose);
  assert.doesNotMatch(result.stdout, /Administrator password/);
  assert.equal(existsSync(join(data, 'couchdb')), true); assert.equal(existsSync(join(data, 'gateway')), true);
  const again = prepare(args); assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(envPath, 'utf8'), updatedEnv); assert.equal(readFileSync(composePath, 'utf8'), updatedCompose);
});

test('upgrade requires the original deployment and never replaces an incomplete deployment configuration', { skip: !existsSync(bash) }, t => {
  const root = bindRuntime(t), envPath = join(root, '.env');
  const result = prepare(['--out', posix(root), '--upgrade']); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires an existing deployment/); assert.equal(existsSync(envPath), false);
  writeFileSync(envPath, 'SYNC_IMAGE=original\nCOUCHDB_PASSWORD=fixture-only\n');
  const again = prepare(['--out', posix(root), '--upgrade']); assert.notEqual(again.status, 0);
  assert.equal(readFileSync(envPath, 'utf8'), 'SYNC_IMAGE=original\nCOUCHDB_PASSWORD=fixture-only\n');
  assert.equal(existsSync(join(root, 'compose.yaml')), false);
});

test('unrecognized Compose environment shapes fail before changing either deployment file', { skip: !existsSync(bash) }, t => {
  const root = bindRuntime(t), shapes = [
    '    environment: { SYNC_BACKEND: couchdb }\n',
    '    environment:\n      - SYNC_BACKEND=couchdb\n',
    '    environment: *shared-env\n',
    '    environment:\n      <<: *shared-env\n      SYNC_BACKEND: couchdb\n',
    '    environment:\n      SYNC_BACKEND: couchdb\n    environment:\n      OTHER: value\n',
  ];
  for (const [index, shape] of shapes.entries()) {
    const output = join(root, String(index)); assert.equal(prepare(['--out', posix(output)]).status, 0);
    const envPath = join(output, '.env'), composePath = join(output, 'compose.yaml');
    const oldEnv = readFileSync(envPath, 'utf8').replace(/^SYNC_ADMIN_PASSWORD=.*\n/m, '');
    const oldCompose = legacyCompose(readFileSync(composePath, 'utf8')).replace(/    environment:\n(?:      .*\n)+(?=    ports:)/, shape);
    writeFileSync(envPath, oldEnv); writeFileSync(composePath, oldCompose);
    for (const upgrade of [[], ['--upgrade']]) {
      const result = prepare(['--out', posix(output), ...upgrade]); assert.notEqual(result.status, 0, String(index));
      assert.match(result.stderr, /Unrecognized Compose/);
      assert.equal(readFileSync(envPath, 'utf8'), oldEnv); assert.equal(readFileSync(composePath, 'utf8'), oldCompose);
      assert.equal(readdirSync(output).some(name => name.startsWith('.compose.upgrade-') || name.startsWith('.env.upgrade-')), false);
    }
  }
});

test('existing admin mappings and CRLF Compose content survive adding only the missing setting', { skip: !existsSync(bash) }, t => {
  const root = bindRuntime(t); assert.equal(prepare(['--out', posix(root)]).status, 0);
  const composePath = join(root, 'compose.yaml'), envPath = join(root, '.env'), oldEnv = readFileSync(envPath, 'utf8');
  const oldCompose = readFileSync(composePath, 'utf8').replace(/^.*SYNC_ADMIN_SECURE_COOKIE:.*\n/m, '').replace('SYNC_ADMIN_PASSWORD: ${SYNC_ADMIN_PASSWORD:-}', 'SYNC_ADMIN_PASSWORD: ${CUSTOM_ADMIN_PASSWORD:-}').replace(/\r?\n/g, '\r\n');
  writeFileSync(composePath, oldCompose);
  const result = prepare(['--out', posix(root)]); assert.equal(result.status, 0, result.stderr);
  const updated = readFileSync(composePath, 'utf8');
  assert.equal(updated.replace(/^.*SYNC_ADMIN_SECURE_COOKIE:.*\r\n/m, ''), oldCompose);
  assert.match(updated, /SYNC_ADMIN_PASSWORD: \$\{CUSTOM_ADMIN_PASSWORD:-\}/);
  assert.equal(updated.match(/^      SYNC_ADMIN_SECURE_COOKIE:/gm)?.length, 1); assert.equal(readFileSync(envPath, 'utf8'), oldEnv);
});
