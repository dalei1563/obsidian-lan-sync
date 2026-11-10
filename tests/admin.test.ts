import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store';
import { makeServer } from '../server/http';
import { hash, id } from '../shared/protocol';
import { decodeConnection } from '../shared/connection';

async function setup(t: TestContext, password: string | undefined = 'test-admin-password', secureCookie = false) {
  const base = resolve('.test-runtime'), root = join(base, 'admin-' + id()); mkdirSync(root, { recursive: true });
  const assets = join(root, 'assets'); mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>LAN Note Sync</title><script src="/admin/app.js"></script>');
  writeFileSync(join(assets, 'app.js'), '/* self hosted */'); writeFileSync(join(assets, 'styles.css'), 'body{}');
  const store = new Store(join(root, 'data'), true), server = makeServer(store, undefined, undefined, { password, assetsDir: assets, secureCookie, version: '0.4.0' });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); store.close(); if (!root.startsWith(base + sep)) throw Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); });
  let cookie = '', csrf = '';
  async function request(path: string, method = 'GET', data?: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(url + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5000) });
    const text = await response.text(); let value: any; try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, headers: response.headers, value };
  }
  async function login() {
    const r = await request('/admin/api/login', 'POST', { password }); assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie')!.split(';')[0]; csrf = r.value.csrfToken;
    return r;
  }
  return { store, request, login, url, cookie: () => cookie, csrf: () => csrf };
}

test('admin requires a password session, CSRF token and same origin; device tokens cannot administer', async t => {
  const f = await setup(t);
  assert.equal((await f.request('/admin/api/overview')).status, 401);
  const device = f.store.pair(f.store.createPair('Device Vault').code, 'Device');
  assert.equal((await f.request('/admin/api/overview', 'GET', undefined, { Authorization: 'Bearer ' + device.token })).status, 401);
  assert.equal((await f.request(`/admin/api/vaults/${device.vaultId}/files`, 'GET', undefined, { Authorization: 'Bearer ' + device.token })).status, 401);
  assert.equal((await f.request('/admin/api/login', 'POST', { password: 'test-admin-password' }, { Origin: 'https://other.example' })).status, 403);
  const login = await f.login();
  assert.match(login.headers.get('set-cookie')!, /HttpOnly/); assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/); assert.match(login.headers.get('set-cookie')!, /Path=\/admin/);
  assert.equal((await f.request('/admin/api/session')).value.authenticated, true);
  assert.equal((await f.request('/admin/api/vaults', 'POST', { name: 'Denied' }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.request('/admin/api/vaults', 'POST', { name: 'Denied' }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.request('/admin/api/vaults', 'POST', { name: 'Created' }, { Origin: f.url })).status, 201);
  const overview = await f.request('/admin/api/overview'); assert.equal(overview.status, 200);
  assert.equal(overview.value.totals.vaults, 2);
  assert.ok(!JSON.stringify(overview.value).includes(device.token)); assert.ok(!JSON.stringify(overview.value).includes('test-admin-password'));
  assert.equal((await f.request('/admin/api/logout', 'POST')).status, 200);
  assert.equal((await f.request('/admin/api/overview')).status, 401);
});

test('admin manages isolated repositories, invites, change records, exclusions and revocation', async t => {
  const f = await setup(t); await f.login();
  const a = (await f.request('/admin/api/vaults', 'POST', { name: 'Work' })).value.vault;
  const b = (await f.request('/admin/api/vaults', 'POST', { name: 'Personal' })).value.vault;
  assert.notEqual(a.id, b.id);
  assert.equal((await f.request('/admin/api/vaults/' + a.id, 'PATCH', { name: 'Work Notes' })).status, 200);
  const invite = await f.request(`/admin/api/vaults/${a.id}/invites`, 'POST', { server: f.url }); assert.equal(invite.status, 201);
  const connection = decodeConnection(invite.value.connection); assert.equal(connection.server, f.url);
  assert.match(invite.value.windowsCommand, /-Connection/); assert.match(invite.value.macCommand, /--connection/);
  const pair = f.store.pair(connection.code, 'Windows');
  const denied = await f.request(`/v1/vaults/${b.id}/state`, 'GET', undefined, { Authorization: 'Bearer ' + pair.token }); assert.equal(denied.status, 403);
  const data = Buffer.from('hello'), revision = { id: id(), fileId: id(), parents: [], path: 'note.md', deleted: false, hash: hash(data), size: data.length, clientId: pair.deviceId };
  f.store.putObject(a.id, hash(data), data); f.store.commit(a.id, revision, pair.deviceId);
  const files = await f.request(`/admin/api/vaults/${a.id}/files`);
  assert.equal(files.status, 200); assert.deepEqual(files.value.files, [{ fileId: revision.fileId, paths: ['note.md'], size: data.length, conflicts: false, deleted: false }]);
  const preview = await f.request(`/admin/api/vaults/${a.id}/files/${revision.fileId}`);
  assert.equal(preview.status, 200); assert.equal(preview.value.content, 'hello'); assert.equal(preview.value.path, 'note.md');
  assert.equal((await f.request(`/admin/api/vaults/${b.id}/files/${revision.fileId}`)).status, 404);
  assert.deepEqual((await f.request(`/admin/api/vaults/${b.id}/files`)).value.files, []);
  const activity = await f.request('/admin/api/activity?vaultId=' + a.id); assert.equal(activity.status, 200); assert.equal(activity.value.items.length, 1); assert.equal(activity.value.items[0].action, 'create'); assert.equal(activity.value.items[0].deviceName, 'Windows');
  const updatedData = Buffer.from('updated');
  f.store.putObject(a.id, hash(updatedData), updatedData);
  const updated = { ...revision, id: id(), parents: [revision.id], hash: hash(updatedData), size: updatedData.length };
  f.store.commit(a.id, updated, pair.deviceId);
  const history = await f.request(`/admin/api/vaults/${a.id}/files/${revision.fileId}/history`);
  assert.equal(history.status, 200); assert.equal(history.value.items.length, 2); assert.deepEqual(history.value.heads, [updated.id]);
  const historic = await f.request(`/admin/api/vaults/${a.id}/files/${revision.fileId}/history?revisionId=${revision.id}`);
  assert.equal(historic.status, 200); assert.equal(historic.value.content, 'hello');
  const endpoint = `/admin/api/vaults/${a.id}/files/${revision.fileId}/restore`;
  assert.equal((await f.request(endpoint, 'POST', { revisionId: revision.id, expectedHeads: [revision.id] })).status, 409);
  const restored = await f.request(endpoint, 'POST', { revisionId: revision.id, expectedHeads: [updated.id] });
  assert.equal(restored.status, 201); assert.notEqual(restored.value.revision.id, revision.id);
  assert.deepEqual(restored.value.revision.parents, [updated.id]); assert.equal(restored.value.revision.hash, revision.hash);
  assert.equal(f.store.history(a.id, revision.fileId).length, 3);
  assert.equal((await f.request(endpoint, 'POST', { revisionId: revision.id, expectedHeads: [updated.id] })).status, 409);
  const rules = await f.request(`/admin/api/vaults/${a.id}/exclusions`, 'PUT', { excludedPaths: ['private/**', '*.secret.md'] }); assert.equal(rules.status, 200);
  assert.deepEqual(f.store.snapshot(a.id).excludedPaths, rules.value.excludedPaths);
  const blocked = { ...revision, id: id(), fileId: id(), path: 'private/note.md' }; assert.throws(() => f.store.commit(a.id, blocked, pair.deviceId), /排除/);
  assert.equal((await f.request(`/admin/api/vaults/${a.id}/exclusions`, 'PUT', { excludedPaths: [42] })).status, 400);
  assert.equal((await f.request('/admin/api/activity?limit=99999')).status, 400);
  assert.equal((await f.request('/admin/api/devices/' + pair.deviceId + '/revoke', 'POST')).status, 200);
  assert.equal((await f.request(`/v1/vaults/${a.id}/state`, 'GET', undefined, { Authorization: 'Bearer ' + pair.token })).status, 401);
  assert.equal((await f.request('/admin/api/devices/missing-device/revoke', 'POST')).status, 404);
});

test('admin login is rate limited and ignores spoofed forwarded IPs', async t => {
  const f = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/admin/api/login', 'POST', { password: 'wrong' }, { 'X-Forwarded-For': '192.0.2.' + i })).status, 401);
  const sixth = await f.request('/admin/api/login', 'POST', { password: 'test-admin-password' }); assert.equal(sixth.status, 429); assert.ok(Number(sixth.headers.get('retry-after')) > 0);
});

test('whole vault restore previews a historical point, creates new revisions, and keeps newer history', async t => {
  const f = await setup(t); await f.login();
  const paired = f.store.pair(f.store.createPair('History').code, 'Device');
  const make = (path: string, value: string, previous?: any) => {
    const data = Buffer.from(value); f.store.putObject(paired.vaultId, hash(data), data);
    const revision = {id: id(), fileId: previous?.fileId ?? id(), parents: previous ? [previous.id] : [], path, deleted: false, hash: hash(data), size: data.length, clientId: paired.deviceId};
    f.store.commit(paired.vaultId, revision, paired.deviceId); return revision;
  };
  const a = make('a.md', 'old a'), b = make('b.md', 'old b');
  const changed = make('a.md', 'new a', a);
  const deleted = {...b, id: id(), parents: [b.id], deleted: true, hash: null, size: 0};
  f.store.commit(paired.vaultId, deleted, paired.deviceId); const c = make('c.md', 'new c');
  const url = `/admin/api/vaults/${paired.vaultId}/restore`;
  const preview = await f.request(url + '?point=' + b.id); assert.equal(preview.status, 200); assert.equal(preview.value.actions.length, 3);
  const extra = make('d.md', 'late');
  assert.equal((await f.request(url, 'POST', {point: b.id, fingerprint: preview.value.fingerprint})).status, 409);
  assert.equal(f.store.history(paired.vaultId, a.fileId).length, 2);
  const fresh = await f.request(url + '?point=' + b.id); assert.equal(fresh.value.actions.length, 4);
  const done = await f.request(url, 'POST', {point: b.id, fingerprint: fresh.value.fingerprint}); assert.equal(done.status, 200);
  const state = f.store.snapshot(paired.vaultId), head = (fileId: string) => state.files.find(x => x.fileId === fileId)!.heads[0];
  assert.equal(head(a.fileId).hash, a.hash); assert.deepEqual(head(a.fileId).parents, [changed.id]);
  assert.equal(head(b.fileId).hash, b.hash); assert.deepEqual(head(b.fileId).parents, [deleted.id]);
  assert.equal(head(c.fileId).deleted, true); assert.equal(head(extra.fileId).deleted, true);
  assert.equal(f.store.history(paired.vaultId, a.fileId).length, 3);
  assert.equal(f.store.history(paired.vaultId, b.fileId).length, 3);
  assert.equal((await f.request(url + '?point=' + b.id)).value.actions.length, 0);
  const another = f.store.createVault('Another'); assert.equal((await f.request(`/admin/api/vaults/${another.id}/restore?point=${b.id}`)).status, 404);
});

test('interrupted whole-vault restore reports partial progress and a new preview safely finishes it', async t => {
  const f = await setup(t); await f.login();
  const device = f.store.pair(f.store.createPair('History').code, 'Device'), bytes = Buffer.from('x');
  f.store.putObject(device.vaultId, hash(bytes), bytes);
  const add = (path: string) => { const r = {id: id(), fileId: id(), parents: [], path, deleted: false, hash: hash(bytes), size: bytes.length, clientId: device.deviceId}; f.store.commit(device.vaultId, r, device.deviceId); return r; };
  const point = add('keep.md'), x = add('x.md'), y = add('y.md'), url = `/admin/api/vaults/${device.vaultId}/restore`;
  const plan = (await f.request(url + '?point=' + point.id)).value;
  const commit = f.store.commit.bind(f.store); let calls = 0;
  f.store.commit = (...args) => { if (++calls === 2) throw new Error('simulated database outage'); return commit(...args); };
  const interrupted = await f.request(url, 'POST', {point: point.id, fingerprint: plan.fingerprint});
  assert.equal(interrupted.status, 409); assert.equal(interrupted.value.code, 'restore_partial'); assert.match(interrupted.value.message, /1 个新版本/);
  f.store.commit = commit;
  const retry = (await f.request(url + '?point=' + point.id)).value; assert.equal(retry.actions.length, 1);
  assert.equal((await f.request(url, 'POST', {point: point.id, fingerprint: retry.fingerprint})).status, 200);
  const state = f.store.snapshot(device.vaultId);
  assert.ok([x, y].every(r => state.files.find(file => file.fileId === r.fileId)!.heads[0].deleted));
  assert.equal(f.store.history(device.vaultId, x.fileId).length, 2); assert.equal(f.store.history(device.vaultId, y.fileId).length, 2);
});

test('unconfigured admin stays closed while sync health and self-hosted login assets remain available', async t => {
  const f = await setup(t, '');
  assert.equal((await f.request('/v1/health')).status, 200);
  const session = await f.request('/admin/api/session'); assert.equal(session.status, 503); assert.equal(session.value.configured, false);
  const root = await f.request('/'); assert.equal(root.status, 303); assert.equal(root.headers.get('location'), '/admin/');
  const page = await f.request('/admin/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/); assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await f.request('/admin/.env')).status, 404);
});

test('admin can mark session cookies Secure for TLS-terminating reverse proxies', async t => {
  const f = await setup(t, 'test-admin-password', true); const r = await f.login(); assert.match(r.headers.get('set-cookie')!, /; Secure/);
});
