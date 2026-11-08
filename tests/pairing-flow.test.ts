import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { SingleFlight, DeadlineError, withDeadline } from '../src/sync/async-flow';
import { encodeConnection } from '../shared/connection';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('bootstrap and manual enrollment for the same code share one operation; another code cannot interleave', async () => {
  const gate = new SingleFlight(), response = deferred<void>(); let requests = 0;
  const first = gate.run('server/code-a', async () => { requests++; await response.promise; });
  const duplicate = gate.run('server/code-a', async () => { requests++; });
  assert.equal(first, duplicate); assert.equal(gate.busy, true);
  await assert.rejects(gate.run('server/code-b', async () => { requests++; }), /另一个连接/);
  assert.equal(requests, 1); response.resolve(); await first;
  assert.equal(gate.busy, false);
  await gate.run('server/code-b', async () => { requests++; }); assert.equal(requests, 2);
});

test('enrollment gate is established before synchronous reentry and releases after failure', async () => {
  const gate = new SingleFlight(); let duplicate: Promise<void> | undefined, calls = 0;
  const first = gate.run('code-a', async () => {
    calls++; duplicate = gate.run('code-a', async () => { calls++; }); throw new Error('network failed');
  });
  await assert.rejects(first, /network failed/); assert.equal(duplicate, first); assert.equal(calls, 1); assert.equal(gate.busy, false);
  await gate.run('code-a', async () => { calls++; }); assert.equal(calls, 2);
});

test('a timed-out enrollment response cannot overwrite a later successful binding or secret', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = new SingleFlight(), old = deferred<string>(); const secrets: string[] = []; let binding = '';
  const first = gate.run('old-code', async () => {
    const result = await withDeadline(old.promise, 20, '连接超时'); secrets.push(result); binding = result;
  });
  // Allow run() to start its deferred operation before advancing the clock.
  await Promise.resolve();
  const rejected = assert.rejects(first, error => error instanceof DeadlineError && error.message === '连接超时');
  t.mock.timers.tick(20); await rejected; assert.equal(gate.busy, false);
  await gate.run('new-code', async () => {
    const result = await withDeadline(Promise.resolve('new-binding'), 20, '连接超时'); secrets.push(result); binding = result;
  });
  old.resolve('old-binding'); await Promise.resolve(); await Promise.resolve();
  assert.equal(binding, 'new-binding'); assert.deepEqual(secrets, ['new-binding']);
});

test('timeout leaves an operation retryable and consumes a late native-request rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = deferred<string>(); const waiting = withDeadline(request.promise, 10, '连接超时');
  const rejected = assert.rejects(waiting, DeadlineError); t.mock.timers.tick(10); await rejected;
  request.reject(new Error('native request eventually failed')); await Promise.resolve(); await Promise.resolve();
  assert.equal(await withDeadline(Promise.resolve('retried'), 10, '连接超时'), 'retried');
});

test('a successful request clears its deadline and a native error keeps its original message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(await withDeadline(Promise.resolve('paired'), 10, '连接超时'), 'paired');
  const error = new Error('invalid invite'); await assert.rejects(withDeadline(Promise.reject(error), 10, '连接超时'), received => received === error);
  t.mock.timers.tick(10);
});

// Compile the real plugin with its only runtime dependency stubbed. This checks
// the enrollment orchestration without opening a user Vault or starting sync.
const compile = spawnSync(process.execPath, ['-e', "process.stdout.write(require('esbuild').buildSync({entryPoints:['src/main.ts'],bundle:true,platform:'node',format:'cjs',target:'node24',external:['obsidian'],write:false}).outputFiles[0].text)"], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
assert.equal(compile.status, 0, compile.stderr);
const requireRuntime = createRequire(resolve('package.json'));
const server = 'http://127.0.0.1:27123', codeA = 'a'.repeat(24), codeB = 'b'.repeat(24);
function reply(name: string) {
  const result = { token: name + '-token', vaultId: name + '-vault', vaultName: name, deviceId: name + '-device', serverId: 'test-server' };
  return { status: 200, arrayBuffer: Uint8Array.from(Buffer.from(JSON.stringify(result))).buffer };
}
function pluginFixture(request: (options: any) => Promise<any>) {
  const notices: string[] = [], secretWrites: string[] = [], claims = new Map<string, string>(), modals: any[] = []; let completed = 0, setups = 0, previews = 0, syncs = 0;
  const app = { secretStorage: { setSecret: (_: string, value: string) => secretWrites.push(value) } };
  class Plugin { constructor(readonly app: unknown, readonly manifest: unknown) {} }
  class Modal {
    titleEl = { setText: () => {} }; contentEl = { createEl: () => {}, buttons: [] as any[] }; onClose() {}
    open() { modals.push(this); } close() { this.onClose(); }
  }
  class Setting {
    constructor(readonly element: { buttons: any[] }) {}
    addButton(build: (button: any) => unknown) {
      const button = { text: '', click: () => {}, setButtonText(text: string) { this.text = text; return this; }, setCta() { return this; }, setDisabled(_: boolean) { return this; }, onClick(click: () => void) { this.click = click; return this; } };
      build(button); this.element.buttons.push(button); return this;
    }
  }
  const obsidian = { Plugin, PluginSettingTab: class {}, FileSystemAdapter: class {}, MarkdownView: class {}, Modal, Setting, Notice: class { constructor(message: string) { notices.push(message); } }, requestUrl: request };
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', compile.stdout)(
    (name: string) => name === 'obsidian' ? obsidian : requireRuntime(name), module, module.exports);
  const plugin = new module.exports.default(app, { id: 'lan-note-sync' }); plugin.settings.secretId = 'test-secret';
  const saves: any[] = [];
  plugin.saveSettings = async () => { saves.push(structuredClone(plugin.settings)); };
  plugin.enrollment = () => ({
    claim: (url: string, code: string) => { const key = url + '/' + code; if (!claims.has(key)) claims.set(key, 'claim-' + claims.size); return claims.get(key); },
    complete: () => { completed++; },
  });
  plugin.setup = async () => { setups++; plugin.engine = { state: { initialized: false }, stop: async () => {} }; };
  plugin.preview = async () => { previews++; };
  plugin.sync = async () => { syncs++; };
  plugin.openMainModal = async (modal: Modal) => { modal.open(); };
  return { plugin, notices, secretWrites, saves, claims, modals, get completed() { return completed; }, get setups() { return setups; }, get previews() { return previews; }, get syncs() { return syncs; } };
}

test('actual plugin shares bootstrap/manual pairing, rejects another code, and never starts first sync', async () => {
  const response = deferred<any>(); let requests = 0;
  const f = pluginFixture(async () => { requests++; return response.promise; });
  const connection = encodeConnection(server, codeA), first = f.plugin.importConnection(connection), duplicate = f.plugin.importConnection(connection);
  assert.equal(first, duplicate);
  await assert.rejects(f.plugin.importConnection(encodeConnection(server, codeB)), /另一个连接/);
  assert.equal(requests, 1); response.resolve(reply('first')); await first;
  assert.equal(f.plugin.settings.vaultId, 'first-vault'); assert.deepEqual(f.secretWrites, ['first-token']);
  assert.equal(f.completed, 1); assert.equal(f.setups, 1); assert.equal(f.previews, 1); assert.equal(f.syncs, 0);
  assert.equal(f.plugin.settings.enabled, false); assert.equal(f.plugin.engine.state.initialized, false);
});

test('actual plugin preserves a different existing binding when a pairing response arrives', async () => {
  const response = deferred<any>(), f = pluginFixture(async () => response.promise);
  const waiting = f.plugin.importConnection(encodeConnection(server, codeA)); await Promise.resolve();
  f.plugin.settings.vaultId = 'already-bound'; f.plugin.settings.server = 'https://existing.example.com';
  response.resolve(reply('late')); await assert.rejects(waiting, /另一份绑定/);
  assert.equal(f.plugin.settings.vaultId, 'already-bound'); assert.equal(f.plugin.settings.server, 'https://existing.example.com');
  assert.equal(f.secretWrites.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.setups, 0); assert.equal(f.completed, 0);
});

test('actual plugin ignores a pairing response received after unload', async () => {
  const response = deferred<any>(), f = pluginFixture(async () => response.promise);
  const waiting = f.plugin.importConnection(encodeConnection(server, codeA)); await Promise.resolve(); f.plugin.onunload();
  response.resolve(reply('late')); await assert.rejects(waiting, /已卸载/);
  assert.equal(f.plugin.settings.vaultId, ''); assert.equal(f.secretWrites.length, 0); assert.equal(f.saves.length, 0);
  assert.equal(f.setups, 0); assert.equal(f.previews, 0); assert.equal(f.notices.length, 0); assert.equal(f.completed, 0);
});

test('actual plugin keeps a successful binding when preview fails and refuses to pair it again', async () => {
  let requests = 0; const f = pluginFixture(async () => { requests++; return reply('saved'); });
  f.plugin.preview = async () => { throw new Error('preview failed'); };
  await assert.rejects(f.plugin.importConnection(encodeConnection(server, codeA)), /已配对.*预览未完成/);
  assert.equal(f.plugin.settings.vaultId, 'saved-vault'); assert.equal(f.saves.length, 1); assert.deepEqual(f.secretWrites, ['saved-token']);
  await assert.rejects(f.plugin.importConnection(encodeConnection(server, codeB)), /已经连接/); assert.equal(requests, 1);
  assert.equal(f.plugin.settings.enabled, false); assert.equal(f.syncs, 0);
});

test('actual plugin can retry an unsaved binding with the same durable claim', async () => {
  const claims: string[] = [], f = pluginFixture(async options => { claims.push(JSON.parse(options.body ? Buffer.from(options.body).toString() : '{}').requestId); return reply('saved'); });
  let fail = true;
  f.plugin.saveSettings = async () => { if (fail) throw new Error('disk full'); };
  await assert.rejects(f.plugin.importConnection(encodeConnection(server, codeA)), /disk full/);
  assert.equal(f.plugin.settings.vaultId, ''); assert.equal(f.completed, 0); assert.equal(f.setups, 0);
  fail = false; await f.plugin.importConnection(encodeConnection(server, codeA));
  assert.equal(f.plugin.settings.vaultId, 'saved-vault'); assert.equal(claims.length, 2); assert.equal(claims[0], claims[1]); assert.equal(f.completed, 1);
});

test('actual transport timeout releases pairing and a late old response cannot replace the new binding', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = deferred<any>(); let requests = 0;
  const f = pluginFixture(async () => { requests++; return requests === 1 ? old.promise : reply('new'); });
  const first = f.plugin.importConnection(encodeConnection(server, codeA)); await Promise.resolve();
  const rejected = assert.rejects(first, /响应超时/); t.mock.timers.tick(20000); await rejected;
  assert.equal(f.plugin.settings.vaultId, ''); assert.equal(f.secretWrites.length, 0); assert.equal(f.plugin.connecting, false);
  await f.plugin.importConnection(encodeConnection(server, codeB)); old.resolve(reply('old')); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.plugin.settings.vaultId, 'new-vault'); assert.deepEqual(f.secretWrites, ['new-token']); assert.equal(f.completed, 1); assert.equal(f.syncs, 0);
});

test('unload during binding persistence keeps the saved binding but does not set up, notify, or clear its recovery claim', async () => {
  const f = pluginFixture(async () => reply('saved')), saving = deferred<void>(), disk = deferred<void>();
  f.plugin.saveSettings = async () => { saving.resolve(); await disk.promise; };
  const waiting = f.plugin.importConnection(encodeConnection(server, codeA)); await saving.promise;
  f.plugin.onunload(); disk.resolve(); await assert.rejects(waiting, /已卸载/);
  assert.equal(f.plugin.settings.vaultId, 'saved-vault'); assert.deepEqual(f.secretWrites, ['saved-token']);
  assert.equal(f.setups, 0); assert.equal(f.previews, 0); assert.equal(f.completed, 0); assert.equal(f.notices.length, 0); assert.equal(f.syncs, 0);
});

test('canceling HTTP enrollment leaves settings untouched and the same connection can be retried explicitly', async () => {
  let requests = 0; const f = pluginFixture(async () => { requests++; return reply('accepted'); });
  const connection = encodeConnection('http://100.64.10.20:27123', codeA), previous = structuredClone(f.plugin.settings);
  const canceled = f.plugin.importConnection(connection); await Promise.resolve(); f.modals[0].close(); await canceled;
  assert.deepEqual(f.plugin.settings, previous); assert.equal(requests, 0); assert.equal(f.claims.size, 0); assert.equal(f.plugin.connecting, false);
  const retry = f.plugin.importConnection(connection); await Promise.resolve();
  f.modals[1].contentEl.buttons.find((button: any) => button.text === '继续内网测试').click(); await retry;
  assert.equal(f.plugin.settings.vaultId, 'accepted-vault'); assert.equal(f.plugin.settings.allowHttp, true); assert.equal(requests, 1); assert.equal(f.syncs, 0);
});

test('canceling the actual first-sync preview keeps the binding and permits another preview without initializing sync', async () => {
  const f = pluginFixture(async () => reply('saved')); let previews = 0, initializations = 0;
  f.plugin.settings.vaultId = 'saved-vault';
  f.plugin.engine = { state: { initialized: false }, preview: async () => { previews++; return { local: 1, remote: 1, upload: 1, download: 1, same: 0, conflicts: 0 }; }, initialize: async () => { initializations++; }, stop: async () => {} };
  f.plugin.setup = async () => {};
  f.plugin.preview = Object.getPrototypeOf(f.plugin).preview.bind(f.plugin);
  await f.plugin.preview(); assert.equal(f.modals.length, 1); f.modals[0].close();
  assert.equal(f.plugin.settings.vaultId, 'saved-vault'); assert.equal(f.plugin.settings.enabled, false); assert.equal(initializations, 0); assert.equal(f.syncs, 0);
  await f.plugin.preview(); assert.equal(f.modals.length, 2); assert.equal(previews, 2); assert.equal(initializations, 0); f.modals[1].close();
});
