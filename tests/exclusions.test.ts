import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExclusions, isExcluded } from '../shared/exclusions';
import { Engine, newState, SyncState } from '../src/sync/engine';
import { Remote, Transport } from '../src/sync/remote';
import { fixture, MemoryVault, transport, client } from './helpers';
import { hash } from '../shared/protocol';

test('exclusion rules support bounded directory and wildcard matching while configuration directories stay private', () => {
  const rules = normalizeExclusions([' private/ ', '**/草稿/**', '**/*.tmp.md', 'cache', 'private/', './Exact.md']);
  assert.deepEqual(rules, ['private/**', '**/草稿/**', '**/*.tmp.md', 'cache', 'Exact.md']);
  for (const path of ['private/one.md', '草稿/a.md', 'notes/草稿/deep/a.md', 'one.tmp.md', 'x/one.tmp.md', 'x/cache/a.md', 'EXACT.md']) assert.equal(isExcluded(path, rules), true, path);
  for (const path of ['private-ish/one.md', 'notes/one.md', 'notcache/a.md', 'exact-ish.md']) assert.equal(isExcluded(path, rules), false, path);
  for (const path of ['.obsidian/config.md', '.obsidian/plugins/secret.md', 'notes/.private/test.md', '.git/info.md']) assert.equal(isExcluded(path, []), true, path);
  assert.equal(isExcluded('config/plugins.md', [], 'config'), true); assert.equal(isExcluded('configuration/test.md', [], 'config'), false);
  for (const value of [null, 'private/**', [null], ['../secret'], ['/absolute'], ['a//b'], ['a/**bad.md'], ['[a].md'], Array(65).fill('a')]) assert.throws(() => normalizeExclusions(value));
});

function setupClient(remote: Remote, serverId: string, deviceId: string, rules: () => readonly string[] = () => []) {
  const local = new MemoryVault(), state = newState(serverId, remote.vaultId, deviceId); let saved: SyncState | undefined;
  const messages: string[] = [];
  const engine = new Engine(remote, local, state, async s => { saved = structuredClone(s); }, m => messages.push(m), { excludedPaths: rules });
  return { local, engine, messages, get saved() { return saved!; } };
}

test('excluded local Markdown and .obsidian bytes are never uploaded, even with a generic file adapter', async t => {
  const f = await fixture(t), objects: string[] = [];
  const remote = new Remote(f.url, f.first.vaultId, f.first.token, async (...args) => { if (args[1] === 'PUT') objects.push(args[0]); return transport(...args); });
  const a = setupClient(remote, f.store.serverId, f.first.deviceId, () => ['private/']);
  a.local.set('visible.md', 'public note'); a.local.set('private/secret.md', 'private bytes'); a.local.set('.obsidian/secret.md', 'configuration bytes');
  await a.engine.initialize(); await a.engine.sync();
  assert.deepEqual(f.store.snapshot(f.first.vaultId).files.map(f => f.heads[0].path), ['visible.md']);
  assert.equal(objects.length, 1); assert.ok(!objects.some(url => url.endsWith(hash('private bytes')) || url.endsWith(hash('configuration bytes'))));
});

test('newly excluding tracked files pauses both directions without turning absent local files into remote deletions', async t => {
  const f = await fixture(t); let rules: string[] = [], bodyGets = 0;
  const remote = new Remote(f.url, f.first.vaultId, f.first.token, async (...args) => { if (args[1] === 'GET' && args[0].includes('/objects/')) bodyGets++; return transport(...args); });
  const a = setupClient(remote, f.store.serverId, f.first.deviceId, () => rules), b = client(f.remoteB, f.store.serverId, f.second.deviceId);
  a.local.set('private/a.md', 'base A'); a.local.set('private/b.md', 'base B');
  await a.engine.initialize(); await a.engine.sync(); await b.engine.initialize(); await b.engine.sync();
  rules = ['private/']; a.local.files.delete('private/a.md');
  b.local.set('private/a.md', 'remote A'); b.local.set('private/b.md', 'remote B'); await b.engine.sync();
  const before = f.store.snapshot(f.first.vaultId).cursor; await a.engine.sync();
  assert.equal(f.store.snapshot(f.first.vaultId).cursor, before); assert.equal(bodyGets, 0);
  assert.equal(a.local.files.has('private/a.md'), false); assert.equal(a.local.text('private/b.md'), 'base B');
  assert.ok(f.store.snapshot(f.first.vaultId).files.every(file => !file.heads[0].deleted)); assert.equal(a.engine.state.pending.length, 0);
});

test('server policy on state and an empty changes page is applied before downloading or publishing content', async t => {
  const f = await fixture(t), b = client(f.remoteB, f.store.serverId, f.second.deviceId); let policy = ['remote/'];
  b.local.set('remote/private.md', 'remote secret'); await b.engine.initialize(); await b.engine.sync();
  let objectCalls = 0;
  const wrapped: Transport = async (...args) => {
    if (args[0].includes('/objects/')) objectCalls++;
    const r = await transport(...args);
    if (r.status === 200 && (/\/state$/.test(args[0]) || args[0].includes('/changes?'))) return { status: 200, body: Buffer.from(JSON.stringify({ ...JSON.parse(r.body.toString()), excludedPaths: policy })) };
    return r;
  };
  const a = setupClient(new Remote(f.url, f.first.vaultId, f.first.token, wrapped), f.store.serverId, f.first.deviceId);
  const preview = await a.engine.preview(); assert.equal(preview.remote, 0); assert.equal(preview.download, 0);
  await a.engine.initialize(); await a.engine.sync(); assert.equal(a.local.files.size, 0); assert.equal(objectCalls, 0);
  policy = ['remote/', 'local/']; a.local.set('local/private.md', 'local secret'); await a.engine.sync();
  assert.equal(objectCalls, 0); assert.deepEqual(a.engine.state.serverExcludedPaths, normalizeExclusions(policy));
  assert.equal(f.store.snapshot(f.first.vaultId).files.length, 1);
});

test('an excluded durable upload remains queued without publication and resumes the same revision when allowed', async t => {
  const f = await fixture(t); let rules: string[] = [], offline = true, puts = 0;
  const r = new Remote(f.url, f.first.vaultId, f.first.token, async (...args) => {
    if (args[1] === 'PUT') { puts++; if (offline) throw Error('simulated offline'); } return transport(...args);
  });
  const a = setupClient(r, f.store.serverId, f.first.deviceId, () => rules); a.local.set('private.md', 'pending bytes');
  await a.engine.initialize(); await assert.rejects(a.engine.sync(), /offline/);
  const pending = structuredClone(a.saved.pending[0]); assert.ok(pending);
  offline = false; rules = ['private.md']; await a.engine.sync();
  assert.equal(puts, 1); assert.deepEqual(a.engine.state.pending, [pending]); assert.match(a.messages[a.messages.length - 1], /排除/);
  assert.equal(f.store.snapshot(f.first.vaultId).files.length, 0);
  rules = []; await a.engine.sync();
  assert.equal(a.engine.state.pending.length, 0); assert.equal(f.store.snapshot(f.first.vaultId).files[0].heads[0].id, pending.revision.id);
});

test('renaming into an excluded directory keeps the remote original; moving out can sync its identity again', async t => {
  const f = await fixture(t), a = setupClient(f.remoteA, f.store.serverId, f.first.deviceId, () => ['private/']);
  a.local.set('original.md', 'bytes'); await a.engine.initialize(); await a.engine.sync();
  const original = f.store.snapshot(f.first.vaultId).files[0];
  a.local.files.delete('original.md'); a.local.set('private/note.md', 'private edit'); await a.engine.noteRename('original.md', 'private/note.md'); await a.engine.sync();
  assert.equal(f.store.snapshot(f.first.vaultId).files[0].heads[0].path, 'original.md');
  a.local.files.delete('private/note.md'); a.local.set('included.md', 'included edit'); await a.engine.noteRename('private/note.md', 'included.md'); await a.engine.sync();
  const after = f.store.snapshot(f.first.vaultId).files[0]; assert.equal(after.fileId, original.fileId); assert.equal(after.heads[0].path, 'included.md');
});

test('a first connection to an old server without policy fields defaults to no server exclusions', async t => {
  const f = await fixture(t);
  const old = new Remote(f.url, f.first.vaultId, f.first.token, async (...args) => {
    const r = await transport(...args);
    if (r.status === 200 && (/\/state$/.test(args[0]) || args[0].includes('/changes?'))) {
      const body = JSON.parse(r.body.toString()); delete body.excludedPaths;
      return { status: r.status, body: Buffer.from(JSON.stringify(body)) };
    }
    return r;
  });
  const a = setupClient(old, f.store.serverId, f.first.deviceId); a.local.set('note.md', 'compatible');
  assert.equal(a.engine.state.serverExcludedPaths, undefined);
  await a.engine.initialize(); await a.engine.sync();
  assert.deepEqual(a.engine.state.serverExcludedPaths, []); assert.equal(f.store.snapshot(f.first.vaultId).files.length, 1);
});

test('server downgrade keeps a durable policy on snapshots and changes until an explicit empty policy clears it', async t => {
  const f = await fixture(t); let legacy = false; const bodyCalls: string[] = [];
  const remote = new Remote(f.url, f.first.vaultId, f.first.token, async (...args) => {
    if (args[0].includes('/objects/')) bodyCalls.push(args[0]);
    const r = await transport(...args);
    if (legacy && r.status === 200 && (/\/state$/.test(args[0]) || args[0].includes('/changes?'))) {
      const body = JSON.parse(r.body.toString()); delete body.excludedPaths;
      return { status: r.status, body: Buffer.from(JSON.stringify(body)) };
    }
    return r;
  });
  const a = setupClient(remote, f.store.serverId, f.first.deviceId);
  a.local.set('note.md', 'original'); await a.engine.initialize(); await a.engine.sync();
  f.store.setExclusions(f.first.vaultId, ['note.md']); a.local.set('note.md', 'private after exclusion'); await a.engine.sync();
  assert.deepEqual(a.saved.serverExcludedPaths, ['note.md']);
  // An old service neither advertises nor enforces the new policy. Rebuild from
  // the durable state to cover a plugin restart as well as missing wire fields.
  legacy = true; f.store.setExclusions(f.first.vaultId, []); bodyCalls.length = 0;
  const restarted = client(remote, f.store.serverId, f.first.deviceId, a.local, a.saved);
  const preview = await restarted.engine.preview(); assert.equal(preview.local, 0); assert.equal(preview.remote, 0);
  await restarted.engine.sync();
  assert.deepEqual(restarted.saved.serverExcludedPaths, ['note.md']); assert.equal(bodyCalls.length, 0);
  assert.equal(f.store.snapshot(f.first.vaultId).files[0].heads[0].hash, hash('original'));
  // Only a server that explicitly advertises [] may resume excluded content.
  legacy = false; await restarted.engine.sync();
  assert.deepEqual(restarted.saved.serverExcludedPaths, []);
  assert.equal(f.store.snapshot(f.first.vaultId).files[0].heads[0].hash, hash('private after exclusion'));
});

test('malformed server policy fails before upload', async t => {
  const f = await fixture(t);
  let bodyCalls = 0;
  const bad = new Remote(f.url, f.second.vaultId, f.second.token, async (...args) => {
    if (args[0].includes('/objects/')) bodyCalls++;
    const r = await transport(...args); if (args[0].endsWith('/state')) return { status: 200, body: Buffer.from(JSON.stringify({ ...JSON.parse(r.body.toString()), excludedPaths: 'not-an-array' })) }; return r;
  });
  const b = setupClient(bad, f.store.serverId, f.second.deviceId); b.local.set('private.md', 'must not upload');
  await assert.rejects(b.engine.initialize(), /排除规则/); assert.equal(bodyCalls, 0);
});

test('persisted repository policy reaches clients without a new revision and cannot be overridden by local rules', async t => {
  const f = await fixture(t); let bodyCalls = 0;
  const remote = new Remote(f.url, f.first.vaultId, f.first.token, async (...args) => { if (args[0].includes('/objects/')) bodyCalls++; return transport(...args); });
  const a = setupClient(remote, f.store.serverId, f.first.deviceId);
  a.local.set('private/a.md', 'already synchronized'); await a.engine.initialize(); await a.engine.sync();
  const before = f.store.snapshot(f.first.vaultId); bodyCalls = 0;
  f.store.setExclusions(f.first.vaultId, ['private/']);
  a.local.set('private/a.md', 'later private edit'); a.local.set('private/b.md', 'new private note');
  await a.engine.sync();
  assert.equal(bodyCalls, 0); assert.equal(f.store.snapshot(f.first.vaultId).cursor, before.cursor);
  assert.deepEqual(a.engine.state.serverExcludedPaths, ['private/**']);
  assert.equal(f.store.snapshot(f.first.vaultId).files[0].heads[0].hash, hash('already synchronized'));
  const b = setupClient(f.remoteB, f.store.serverId, f.second.deviceId); await b.engine.initialize(); await b.engine.sync(); assert.equal(b.local.files.size, 0);
  f.store.setExclusions(f.first.vaultId, []); await a.engine.sync();
  assert.deepEqual(a.engine.state.serverExcludedPaths, []); assert.equal(f.store.snapshot(f.first.vaultId).files.length, 2);
});
