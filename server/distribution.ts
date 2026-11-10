import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import { hash } from '../shared/protocol';
import { pluginZip } from './zip';

/** Explicit allowlist: plugin state, server config and credentials are never served. */
export class Distribution {
  private readonly assets: Map<string, { body: Buffer; type: string }>;
  readonly manifest: { id: string; version: string; minAppVersion: string; files: { name: string; sha256: string; size: number }[] };
  constructor(root: string) {
    const folder = resolve(root), names = ['manifest.json', 'main.js', 'styles.css'];
    const plugin = JSON.parse(readFileSync(join(folder, 'plugin', 'manifest.json'), 'utf8'));
    if (plugin.id !== 'lan-note-sync') throw new Error('Unexpected plugin id');
    this.assets = new Map();
    this.manifest = { id: plugin.id, version: plugin.version, minAppVersion: plugin.minAppVersion, files: [] };
    for (const name of names) {
      const body = readFileSync(join(folder, 'plugin', name));
      this.manifest.files.push({ name, sha256: hash(body), size: body.length });
      this.assets.set('/install/files/' + name, { body, type: 'application/octet-stream' });
    }
    this.assets.set('/install/plugin.zip', {body: pluginZip(names.map(name => ({name, body: this.assets.get('/install/files/' + name)!.body}))), type: 'application/zip'});
    for (const [route, file, type] of [['/install.ps1', 'install.ps1', 'text/plain; charset=utf-8'], ['/install.sh', 'install.sh', 'text/plain; charset=utf-8']] as const) {
      this.assets.set(route, { body: readFileSync(join(folder, file)), type });
    }
  }
  serve(path: string, res: ServerResponse): boolean {
    if (path === '/install/manifest') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(this.manifest)); return true;
    }
    const asset = this.assets.get(path);
    if (!asset) return false;
    res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(asset.body); return true;
  }
  static optional(root: string): Distribution | undefined { return existsSync(join(root, 'plugin', 'manifest.json')) ? new Distribution(root) : undefined; }
}
