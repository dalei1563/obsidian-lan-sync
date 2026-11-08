import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openBackend } from './factory';
import type { Backend } from './backend';
import { makeServer } from './http';
import { encodeConnection, connectionUrl } from '../shared/connection';
import { Distribution } from './distribution';
import { processLock } from './process-lock';

function option(name: string, fallback = ''): string {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? fallback : process.argv[i + 1] ?? fallback;
}
async function main() {
  const command = process.argv[2] ?? 'help';
  const data = resolve(option('data', process.env.SYNC_DATA_DIR ?? './sync-data'));
  if (command === 'start') {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const lock = join(data, 'server.lock');
    const release = processLock(lock);
    let store: Backend | undefined;
    const cleanup = async () => { try { await store?.close(); store = undefined; } finally { release(); } };
    try {
      const host = option('host', process.env.SYNC_HOST ?? '127.0.0.1');
      const port = Number(option('port', process.env.SYNC_PORT ?? '27123'));
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
      const cert = process.env.SYNC_TLS_CERT, key = process.env.SYNC_TLS_KEY;
      if (!!cert !== !!key) throw new Error('Both SYNC_TLS_CERT and SYNC_TLS_KEY are required');
      if (!cert && !['127.0.0.1', '::1', 'localhost'].includes(host) && !process.argv.includes('--allow-insecure-lan')) {
        throw new Error('LAN binding requires TLS, or explicit --allow-insecure-lan for trusted development networks.');
      }
      store = await openBackend(data, true);
      const distribution = Distribution.optional(option('assets', process.env.SYNC_ASSETS_DIR ?? join(__dirname, '..', 'distribution')));
      const server = makeServer(store, cert ? { cert: readFileSync(cert), key: readFileSync(key!), minVersion: 'TLSv1.2' } : undefined, distribution);
      server.on('error', e => { console.error('Server failed:', e.message); void cleanup(); process.exitCode = 1; });
      server.listen(port, host, () => console.log(`LAN Note Sync listening on ${cert ? 'https' : 'http'}://${host}:${port}`));
      const stop = () => { server.close(() => { void cleanup(); process.exitCode = 0; }); server.closeIdleConnections(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    } catch (e) { await cleanup(); throw e; }
    return;
  }
  if (['pair', 'invite', 'devices', 'revoke', 'backup'].includes(command)) {
    const store = await openBackend(data);
    try {
      if (command === 'pair' || command === 'invite') {
        const defaultVault = join(data, 'default-vault');
        const existingVault = option('vault') || (command === 'invite' && !process.argv.includes('--new-vault') && existsSync(defaultVault) ? readFileSync(defaultVault, 'utf8').trim() : undefined);
        const result = await store.createPair(option('name', 'My Notes'), existingVault);
        if (command === 'invite' && !existsSync(defaultVault)) writeFileSync(defaultVault, result.vaultId, { flag: 'wx', mode: 0o600 });
        console.log(`Vault: ${result.vaultId}\nPairing code (single use, 10 minutes): ${result.code}`);
        if (command === 'invite') {
          const server = connectionUrl(option('url', process.env.SYNC_PUBLIC_URL ?? 'http://127.0.0.1:27123'));
          const connection = encodeConnection(server, result.code);
          const host = new URL(server).hostname;
          const local = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[::1\])/.test(host);
          const noProxy = local ? " --noproxy '*'" : '';
          const windowsFetch = local ? `(& { $w=New-Object Net.WebClient; $w.Proxy=$null; try { $w.DownloadString('${server}/install.ps1') } finally { $w.Dispose() } })` : `(Invoke-WebRequest -UseBasicParsing '${server}/install.ps1').Content`;
          console.log(`\nConnection code:\n${connection}\n\nWindows (run, then select the Vault if asked):\n& ([scriptblock]::Create(${windowsFetch})) -Connection '${connection}'\n\nmacOS (run, then select the Vault):\ncurl -fsS${noProxy} '${server}/install.sh' | bash -s -- --connection '${connection}'`);
        }
      } else if (command === 'devices') {
        console.table(await store.devices());
      } else if (command === 'revoke') {
        const device = option('device');
        if (!device) throw new Error('--device is required');
        await store.revoke(device); console.log('Device revoked.');
      } else {
        const dest = option('out');
        if (!dest) throw new Error('--out is required (new directory outside data)');
        await store.backup(dest); console.log('Backup complete:', resolve(dest));
      }
    } finally { await store.close(); }
    return;
  }
  console.log(`LAN Note Sync 0.3 (Node.js 24.15+, CouchDB)\n\nstart   --data ./sync-data --host 127.0.0.1 --port 27123\ninvite  --data ./sync-data --url https://sync.example.com [--name "My Notes"] [--vault existing-id | --new-vault]\npair    --data ./sync-data --name "My Notes" [--vault existing-id]\ndevices --data ./sync-data\nrevoke  --data ./sync-data --device device-id\nbackup  --data ./sync-data --out ./backups/new-directory\n\nUse deployment/setup.ps1 or setup.sh for automatic Docker setup.\nCouchDB: COUCHDB_URL, COUCHDB_USER, COUCHDB_PASSWORD, COUCHDB_DATABASE.\nRepeated invite commands join the same default Vault; --new-vault creates a separate one.\nTLS: SYNC_TLS_CERT and SYNC_TLS_KEY. One gateway replica per database.\nBackup exports CouchDB documents; it is not an automatically restorable data directory.`);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
