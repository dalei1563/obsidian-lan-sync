import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
mkdirSync('.test-runtime', { recursive: true });
if (!existsSync('.test-runtime/couch-test.json')) {
  const password = randomBytes(32).toString('hex');
  writeFileSync('.test-runtime/couch-test.json', JSON.stringify({ url: 'http://127.0.0.1:15984', user: 'lan_test_admin', password }), { mode: 0o600 });
  writeFileSync('.test-runtime/couch-test.env', `COUCHDB_USER=lan_test_admin\nCOUCHDB_PASSWORD=${password}\n`, { mode: 0o600 });
}
writeFileSync('.test-runtime/couch-test.ini', '[couchdb]\nsingle_node = true\n[chttpd]\nbind_address = 127.0.0.1\nport = 15984\nrequire_valid_user = true\n');
console.log('Prepared isolated CouchDB test configuration.');
