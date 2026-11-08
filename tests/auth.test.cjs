const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');

async function load(env, requestUrl) {
  const source = fs.readFileSync('src/feishu/auth.ts', 'utf8');
  const { code } = await esbuild.transform(source, { loader: 'ts', format: 'cjs', target: 'es2020' });
  const module = { exports: {} };
  const context = { module, exports: module.exports, process: { env }, require(name) {
    if (name !== 'obsidian') throw new Error(`Unexpected dependency: ${name}`);
    return { requestUrl };
  } };
  vm.runInNewContext(code, context);
  return module.exports.probeAuthentication();
}

(async () => {
  let called = false;
  const missing = await load({}, async () => { called = true; });
  assert.equal(missing.ok, false);
  assert.equal(called, false, 'missing credentials must not trigger a request');

  let request;
  const ok = await load({ XXL_APP_ID: 'test-id', XXL_APP_SECRET: 'test-secret' }, async options => {
    request = options;
    return { status: 200, json: { code: 0, access_token: 'test-token', expires_in: 7200 } };
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.expiresIn, 7200);
  assert.equal(request.url, 'https://accounts.feishu.cn/oauth/v3/token');
  assert.deepEqual(JSON.parse(request.body), { grant_type: 'client_credentials', client_id: 'test-id', client_secret: 'test-secret' });
  assert.equal(JSON.stringify(ok).includes('test-token'), false, 'result must not expose token');
  assert.equal(JSON.stringify(ok).includes('test-secret'), false, 'result must not expose secret');

  const denied = await load({ XXL_APP_ID: 'id', XXL_APP_SECRET: 'secret' }, async () => ({ status: 400, json: { code: 20002 } }));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 20002);
  const offline = await load({ XXL_APP_ID: 'id', XXL_APP_SECRET: 'secret' }, async () => { throw new Error('secret'); });
  assert.equal(offline.ok, false);
  assert.equal(JSON.stringify(offline).includes('secret'), false, 'errors must not expose request details');
  console.log('Authentication probe tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
