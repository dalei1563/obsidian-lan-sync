import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServer } from '../src/sync/remote';

test('server URL requires TLS except loopback or explicitly selected HTTP test mode', () => {
  assert.equal(normalizeServer('http://127.0.0.1:27123'), 'http://127.0.0.1:27123');
  assert.equal(normalizeServer('https://notes.example.com/'), 'https://notes.example.com');
  assert.throws(() => normalizeServer('http://192.168.1.2:27123'), /HTTPS/);
  assert.equal(normalizeServer('http://192.168.1.2:27123', true), 'http://192.168.1.2:27123');
  for (const url of ['https://user:password@example.com/', 'https://example.com/path', 'https://example.com/?token=secret', 'file:///test', 'https://example.com/#fragment']) assert.throws(() => normalizeServer(url));
});
