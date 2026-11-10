import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer, ServerOptions } from 'node:https';
import type { Backend } from './backend';
import { MAX_BYTES, PROTOCOL, SyncError, assertId } from '../shared/protocol';
import type { Distribution } from './distribution';
import { AdminController, AdminOptions } from './admin';

async function body(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new SyncError('body_too_large', '请求超过大小限制', 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function readJson(req: IncomingMessage): Promise<any> {
  try { return JSON.parse((await body(req, 32 * 1024)).toString('utf8')); }
  catch (e) { if (e instanceof SyncError) throw e; throw new SyncError('invalid_json', 'JSON 无效', 400); }
}
export function checkRate(limits: Map<string, {count: number; until: number}>, key: string, now: number): boolean {
  if (!limits.has(key) && limits.size >= 1000) {
    for (const [name, bucket] of limits) if (bucket.until <= now) limits.delete(name);
    if (limits.size >= 1000) return false;
  }
  const bucket = limits.get(key) ?? {count: 0, until: now + 60000};
  if (bucket.until <= now) { bucket.count = 0; bucket.until = now + 60000; }
  bucket.count++; limits.set(key, bucket);
  return bucket.count <= (key.endsWith(':pair') ? 10 : 1200);
}
export function makeServer(store: Backend, tls?: ServerOptions, distribution?: Distribution, adminOptions?: AdminOptions) {
  const admin = new AdminController(store, adminOptions);
  const limits = new Map<string, { count: number; until: number }>();
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const ip = req.socket.remoteAddress ?? 'unknown';
      const url = new URL(req.url ?? '/', 'http://localhost');
      const now = Date.now();
      const key = ip + (url.pathname === '/v1/pair' ? ':pair' : ':api');
      if (!checkRate(limits, key, now)) {
        res.setHeader('Retry-After', '60'); throw new SyncError('rate_limited', '请求过于频繁，请稍后重试', 429);
      }
      if (req.method === 'GET' && url.pathname === '/v1/health') { await store.health(); return json(res, 200, { ok: true, protocol: PROTOCOL, backend: store.kind }); }
      if (await admin.handle(req, res, url, ip)) return;
      if (req.method === 'GET' && distribution?.serve(url.pathname, res)) return;
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(303, { Location: '/admin/', 'Cache-Control': 'no-store' }); res.end(); return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/pair') {
        const data = await readJson(req);
        if (typeof data?.code !== 'string' || typeof data?.deviceName !== 'string') throw new SyncError('invalid_pair', '配对参数无效', 400);
        return json(res, 201, await store.pair(data.code.replace(/\s|-/g, ''), data.deviceName, data.requestId));
      }
      const auth = await store.authenticate((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      admin.observeDevice(auth.deviceId);
      const match = /^\/v1\/vaults\/([a-zA-Z0-9_-]+)\/(state|changes|commits|reconcile|objects|history|check)(?:\/([a-zA-Z0-9_-]+))?$/.exec(url.pathname);
      if (!match) throw new SyncError('not_found', '接口不存在', 404);
      const [, vaultId, action, target] = match; assertId(vaultId);
      if (vaultId !== auth.vaultId) throw new SyncError('forbidden', '设备无权访问此 Vault', 403);
      if (admin.isRestoring(vaultId)) throw new SyncError('restore_busy', '管理员正在恢复仓库，同步将稍后重试', 503);
      if (req.method === 'GET' && action === 'state' && !target) return json(res, 200, await store.snapshot(vaultId));
      if (req.method === 'GET' && action === 'changes' && !target) {
        return json(res, 200, await store.changes(vaultId, url.searchParams.get('after') ?? 0, url.searchParams.get('epoch') ?? ''));
      }
      if (action === 'objects' && target) {
        if (req.method === 'PUT') { await store.putObject(vaultId, target, await body(req, MAX_BYTES)); return json(res, 200, { ok: true }); }
        if (req.method === 'GET') {
          const data = await store.getObject(vaultId, target);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
          res.end(data); return;
        }
      }
      if (req.method === 'POST' && action === 'commits' && !target) return json(res, 201, await store.commit(vaultId, await readJson(req), auth.deviceId));
      if (req.method === 'POST' && action === 'reconcile' && !target) {
        const value = await readJson(req), heads = value?.expectedHeads;
        if (!Array.isArray(heads) || heads.length > 32 || new Set(heads).size !== heads.length) throw new SyncError('invalid_heads', '覆盖计划无效，请重新预览', 400);
        heads.forEach(assertId);
        return json(res, 201, await store.commit(vaultId, value.revision, auth.deviceId, heads));
      }
      if (req.method === 'POST' && action === 'check' && !target) return json(res, 200, { known: await store.known(vaultId, (await readJson(req))?.revisions) });
      if (req.method === 'GET' && action === 'history' && target) {
        const before = url.searchParams.get('before') ?? undefined;
        return json(res, 200, { revisions: await store.history(vaultId, target, before) });
      }
      throw new SyncError('not_found', '接口不存在', 404);
    } catch (e) {
      if (res.headersSent || res.destroyed) return;
      if (e instanceof SyncError) return json(res, e.status, { code: e.code, message: e.message });
      // Never return request headers, tokens, filesystem paths or SQL diagnostics.
      json(res, 500, { code: 'server_error', message: '服务器处理失败，请检查磁盘与服务状态' });
    }
  };
  const server = tls ? createHttpsServer(tls, handler) : createServer(handler);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 30;
  return server;
}
