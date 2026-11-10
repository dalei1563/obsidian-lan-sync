import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServer, Remote } from '../src/sync/remote';

test('server URL requires TLS except loopback or explicitly selected HTTP test mode', () => {
  assert.equal(normalizeServer('http://127.0.0.1:27123'), 'http://127.0.0.1:27123');
  assert.equal(normalizeServer('https://notes.example.com/'), 'https://notes.example.com');
  assert.throws(() => normalizeServer('http://192.168.1.2:27123'), /HTTPS/);
  assert.equal(normalizeServer('http://192.168.1.2:27123', true), 'http://192.168.1.2:27123');
  for (const url of ['https://user:password@example.com/', 'https://example.com/path', 'https://example.com/?token=secret', 'file:///test', 'https://example.com/#fragment']) assert.throws(() => normalizeServer(url));
});

test('authentication and server failures remain visible and can be retried', async () => {
  for (const status of [401, 403, 500, 503]) {
    let attempts = 0;
    const remote = new Remote('http://127.0.0.1', 'vault', 'token', async () => {
      attempts++;
      return attempts === 1 ? {status, body: Buffer.from('unavailable')} : {status: 200, body: Buffer.from('ok')};
    });
    await assert.rejects(remote.request('/v1/test'), new RegExp(`HTTP ${status}`));
    assert.equal((await remote.request('/v1/test')).toString(), 'ok');
  }
});
