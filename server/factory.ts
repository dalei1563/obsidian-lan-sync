import { Store } from './store';
import { CouchStore } from './couch-store';
import type { Backend } from './backend';

export async function openBackend(root: string, newEpoch = false): Promise<Backend> {
  const backend = process.env.SYNC_BACKEND ?? 'couchdb';
  if (backend === 'sqlite') return new Store(root, newEpoch);
  if (backend !== 'couchdb') throw new Error('SYNC_BACKEND must be couchdb or sqlite');
  return CouchStore.open({ root, url: process.env.COUCHDB_URL ?? 'http://couchdb:5984', user: process.env.COUCHDB_USER ?? '',
    password: process.env.COUCHDB_PASSWORD ?? '', database: process.env.COUCHDB_DATABASE ?? 'lan_note_sync' });
}
