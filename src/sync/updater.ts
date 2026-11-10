import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { hash, id } from '../../shared/protocol';
import type { Transport } from './remote';

type Asset = {name: string; sha256: string; size: number};
const names = ['main.js', 'styles.css', 'manifest.json'] as const;
function version(value: unknown): number[] | null {
  if (typeof value !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value)) return null;
  return value.split('.').map(Number);
}
function newer(a: number[], b: number[]): boolean { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return false; }
function noLink(path: string): void { if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('插件目录含有链接，自动更新已停止'); }
function atomicWrite(path: string, data: Buffer): void {
  const tmp = path + '.lan-update-' + id();
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
/** Stage every verified asset before replacing files. The manifest is written last,
 * so an interrupted update is detected and retried on the next startup. */
export async function updatePlugin(server: string, pluginDir: string, runningVersion: string, transport: Transport, compatible: (minimum: string) => boolean): Promise<string | null> {
  const loaded = version(runningVersion); if (!loaded) throw new Error('当前插件版本格式无效');
  const root = resolve(pluginDir), config = dirname(dirname(root));
  if (root !== join(config, 'plugins', 'lan-note-sync') || !root.startsWith(config + sep)) throw new Error('插件安装目录无效');
  for (const p of [config, join(config, 'plugins'), root, ...names.map(n => join(root, n))]) noLink(p);
  const response = await transport(server + '/install/manifest', 'GET', {});
  if (response.status !== 200 || response.body.length > 65536) throw new Error('无法读取插件更新信息');
  let manifest: any; try { manifest = JSON.parse(response.body.toString('utf8')); } catch { throw new Error('插件更新信息无效'); }
  const target = version(manifest?.version);
  if (manifest?.id !== 'lan-note-sync' || !target || typeof manifest.minAppVersion !== 'string' || !version(manifest.minAppVersion) || !Array.isArray(manifest.files) || manifest.files.length !== 3) throw new Error('插件更新信息无效');
  if (!compatible(manifest.minAppVersion)) throw new Error('新插件需要更新 Obsidian 后才能安装');
  let installed = loaded;
  try { const local = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); const disk = version(local.version); if (local.id === 'lan-note-sync' && disk && newer(disk, installed)) installed = disk; } catch { throw new Error('本地插件信息损坏，自动更新已停止'); }
  if (!newer(target, installed)) return null;
  const assets = new Map<string, Buffer>();
  for (const asset of manifest.files as Asset[]) {
    if (!names.includes(asset?.name as typeof names[number]) || assets.has(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > 10 * 1024 * 1024) throw new Error('插件更新文件列表无效');
    const file = await transport(server + '/install/files/' + asset.name, 'GET', {});
    if (file.status !== 200 || file.body.length !== asset.size || hash(file.body) !== asset.sha256) throw new Error('插件更新文件校验失败，原插件未替换');
    assets.set(asset.name, file.body);
  }
  let downloaded: any; try { downloaded = JSON.parse(assets.get('manifest.json')!.toString('utf8')); } catch { throw new Error('下载的插件信息无效'); }
  if (downloaded.id !== manifest.id || downloaded.version !== manifest.version || downloaded.minAppVersion !== manifest.minAppVersion) throw new Error('下载的插件信息不一致');
  const backupRoot = join(config, 'lan-note-sync-backups'); noLink(backupRoot); mkdirSync(backupRoot, {recursive: true});
  const backup = join(backupRoot, 'auto-' + id()); mkdirSync(backup, {mode: 0o700});
  for (const name of names) copyFileSync(join(root, name), join(backup, name));
  try { for (const name of names) atomicWrite(join(root, name), assets.get(name)!); }
  catch (error) {
    // Best effort rollback; retained backup is outside the plugin discovery directory.
    for (const name of names) try { atomicWrite(join(root, name), readFileSync(join(backup, name))); } catch { /* retain the backup for recovery */ }
    throw new Error('安装更新失败，旧版备份已保留');
  }
  return manifest.version;
}
