import { assertId, PROTOCOL } from './protocol';

export interface Connection { protocol: number; server: string; code: string }
export function connectionUrl(value: string): string {
  const u = new URL(value.trim());
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('连接地址无效，请从管理员提供的完整连接码导入');
  return u.origin;
}
export function encodeConnection(server: string, code: string): string {
  const c: Connection = { protocol: PROTOCOL, server: connectionUrl(server), code };
  if (!/^[a-f0-9]{24}$/.test(code)) throw new Error('Invalid pairing code');
  return 'lansync:' + Buffer.from(JSON.stringify(c)).toString('base64url');
}
export function decodeConnection(value: string): Connection {
  let raw = value.trim();
  if (raw.startsWith('obsidian://lan-note-sync?')) raw = new URL(raw).searchParams.get('connection') ?? '';
  if (!raw.startsWith('lansync:') || raw.length > 4096) throw new Error('请粘贴管理员提供的完整连接码（以 lansync: 开头）');
  try {
    const c = JSON.parse(Buffer.from(raw.slice(8), 'base64url').toString('utf8'));
    if (c.protocol !== PROTOCOL || typeof c.code !== 'string' || !/^[a-f0-9]{24}$/.test(c.code)) throw new Error();
    return { protocol: PROTOCOL, server: connectionUrl(c.server), code: c.code };
  } catch { throw new Error('连接码无效或版本不兼容，请向管理员重新获取'); }
}
