import { randomBytes, scrypt, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Backend } from './backend';
import { assertId, id as newId, PROTOCOL, SyncError, type Cursor, type Revision } from '../shared/protocol';
import { invitationInstructions } from './invitations';
import { normalizeExclusions } from '../shared/exclusions';
import { planVaultRestore, restoreFingerprint } from './vault-restore';

export interface AdminOptions { password?: string; assetsDir?: string; secureCookie?: boolean; version?: string }
interface Session { csrf: string; expiresAt: number }
const LIFETIME = 8 * 60 * 60 * 1000;
const security = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { ...security, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}
async function read(req: IncomingMessage): Promise<any> {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new SyncError('invalid_json', '请使用 JSON 请求', 415);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 32768) throw new SyncError('body_too_large', '管理请求过大', 413); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SyncError('invalid_json', 'JSON 无效', 400); }
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\x00-\x1f\x7f]/.test(value)) throw new SyncError('invalid_name', '仓库名称需要 1–100 个可见字符', 400);
  return value.trim();
}
function equal(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }

/** One administrator password, independent from all Obsidian device tokens. */
export class AdminController {
  private readonly salt = randomBytes(16);
  private readonly passwordHash?: Buffer;
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly seen = new Map<string, number>();
  private readonly restoring = new Set<string>();
  private readonly assets = new Map<string, { bytes: Buffer; type: string }>();
  private readonly started = Date.now();
  private readonly cookieName: string;
  readonly version: string;
  constructor(readonly store: Backend, readonly options: AdminOptions = {}) {
    if (options.password) {
      if (options.password.length < 8 || options.password.length > 256) throw new Error('SYNC_ADMIN_PASSWORD must contain 8–256 characters');
      this.passwordHash = scryptSync(options.password, this.salt, 32);
    }
    this.version = options.version ?? '0.4.0';
    this.cookieName = 'lns_admin_' + createHash('sha256').update(store.serverId).digest('hex').slice(0, 12);
    for (const [route, file, type] of [['/admin/', 'index.html', 'text/html; charset=utf-8'], ['/admin/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/admin/styles.css', 'styles.css', 'text/css; charset=utf-8']] as const) {
      const path = options.assetsDir && join(options.assetsDir, file);
      if (path && existsSync(path)) this.assets.set(route, { bytes: readFileSync(path), type });
    }
  }
  observeDevice(id: string): void { this.seen.set(id, Date.now()); }
  isRestoring(vaultId: string): boolean { return this.restoring.has(vaultId); }
  private async vaultRestore(vaultId: string, point: string, fingerprint?: string): Promise<unknown> {
    assertId(point);
    if (this.restoring.has(vaultId)) throw new SyncError('restore_busy', '仓库正在恢复，请稍后重试', 409);
    if (fingerprint !== undefined) this.restoring.add(vaultId);
    let completed = 0;
    try {
      const snapshot = await this.store.snapshot(vaultId);
      const plan = planVaultRestore(point, snapshot, await this.store.historyPoint(vaultId, point));
      if (fingerprint === undefined) return plan;
      if (plan.fingerprint !== fingerprint) throw new SyncError('restore_changed', '预览后仓库发生变化，请重新预览', 409);
      let expected = restoreFingerprint(snapshot);
      const heads = new Map(snapshot.files.map(f => [f.fileId, f.heads[0]]));
      const apply = async (source: Revision, deleted: boolean) => {
        const before = await this.store.snapshot(vaultId);
        if (restoreFingerprint(before) !== expected) throw new SyncError('restore_changed', '恢复期间仓库发生变化，请重新预览', 409);
        const head = heads.get(source.fileId)!;
        const revision: Revision = { ...source, id: newId(), parents: [head.id], deleted,
          hash: deleted ? null : source.hash, size: deleted ? 0 : source.size, clientId: 'admin-restore' };
        const result = await this.store.commit(vaultId, revision, 'admin-restore', [head.id]);
        completed++; heads.set(source.fileId, result.revision);
        const expectedFiles = before.files.map(f => f.fileId === source.fileId ? result.file : f);
        expected = restoreFingerprint({...before, files: expectedFiles});
      };
      for (const action of plan.actions) if (action.predelete) await apply(action.before, true);
      for (const action of plan.actions) {
        const target = action.target;
        if (!target || target.deleted) { if (!action.predelete) await apply(action.before, true); }
        else await apply(target, false);
      }
      const final = await this.store.snapshot(vaultId);
      if (restoreFingerprint(final) !== expected) throw new SyncError('restore_changed', '恢复期间仓库发生变化，请重新预览', 409);
      return {ok: true, files: plan.actions.length, revisions: completed};
    } catch (error) {
      if (completed) throw new SyncError('restore_partial', `恢复已暂停，已有 ${completed} 个新版本写入；请重新预览同一时间点后继续。已有历史均保留。`, 409);
      throw error;
    } finally { if (fingerprint !== undefined) this.restoring.delete(vaultId); }
  }
  private async historical(vaultId: string, fileId: string, revisionId: string): Promise<Revision> {
    assertId(revisionId); let before: Cursor | undefined;
    for (;;) {
      const page = await this.store.history(vaultId, fileId, before);
      const found = page.find(item => item.revision.id === revisionId)?.revision;
      if (found) return found;
      if (page.length < 100) throw new SyncError('revision_missing', '历史版本不存在', 404);
      const next = page[page.length - 1].seq;
      if (next === before) throw new SyncError('invalid_cursor', '历史分页未前进', 409);
      before = next;
    }
  }
  private sameOrigin(req: IncomingMessage): void {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new SyncError('csrf_denied', '请从管理页面发起操作', 403);
    const origin = req.headers.origin;
    if (origin) {
      try { const u = new URL(origin); if (!['http:', 'https:'].includes(u.protocol) || u.host.toLowerCase() !== req.headers.host?.toLowerCase()) throw Error(); }
      catch { throw new SyncError('csrf_denied', '管理页面来源不匹配', 403); }
    }
  }
  private cookie(value: string, req: IncomingMessage, expired = false): string {
    const secure = this.options.secureCookie || !!(req.socket as any).encrypted;
    return `${this.cookieName}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${expired ? 0 : LIFETIME / 1000}${secure ? '; Secure' : ''}`;
  }
  private session(req: IncomingMessage, mutate: boolean): Session {
    const now = Date.now(); for (const [key, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(key);
    const token = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(this.cookieName + '='))?.slice(this.cookieName.length + 1) ?? '';
    const session = /^[a-f0-9]{64}$/.test(token) ? this.sessions.get(token) : undefined;
    if (!session) throw new SyncError('admin_unauthorized', '请先输入管理员密码登录', 401);
    if (mutate) {
      this.sameOrigin(req);
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !equal(csrf, session.csrf)) throw new SyncError('csrf_denied', '页面验证已过期，请刷新后重试', 403);
    }
    return session;
  }
  private async login(req: IncomingMessage, res: ServerResponse, ip: string) {
    this.sameOrigin(req);
    const now = Date.now(); for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    if (!this.attempts.has(ip) && this.attempts.size >= 1000) throw new SyncError('rate_limited', '登录请求较多，请稍后重试', 429);
    const bucket = this.attempts.get(ip) ?? { count: 0, until: now + 60000 };
    if (bucket.count >= 5) { res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.until - now) / 1000)))); throw new SyncError('rate_limited', '登录尝试过多，请一分钟后重试', 429); }
    bucket.count++; this.attempts.set(ip, bucket);
    const data = await read(req), password = data?.password;
    let valid = false;
    if (typeof password === 'string' && password.length <= 256) {
      const digest = await new Promise<Buffer>((done, fail) => scrypt(password, this.salt, 32, (e, hash) => e ? fail(e) : done(hash)));
      valid = timingSafeEqual(digest, this.passwordHash!);
    }
    if (!valid) throw new SyncError('admin_denied', '管理员密码不正确', 401);
    this.attempts.delete(ip);
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    while (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex'), csrfToken = randomBytes(32).toString('hex');
    this.sessions.set(token, { csrf: csrfToken, expiresAt: now + LIFETIME });
    res.setHeader('Set-Cookie', this.cookie(token, req)); json(res, 200, { ok: true, csrfToken });
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): Promise<boolean> {
    const path = url.pathname;
    if (path !== '/admin' && !path.startsWith('/admin/')) return false;
    try {
      if (req.method === 'GET' && path === '/admin') { res.writeHead(303, { ...security, Location: '/admin/' }); res.end(); return true; }
      const asset = this.assets.get(path);
      if (req.method === 'GET' && asset) { res.writeHead(200, { ...security, 'Content-Type': asset.type, 'Content-Length': asset.bytes.length }); res.end(asset.bytes); return true; }
      if (!path.startsWith('/admin/api/')) { json(res, 404, { message: '管理页面资源不存在，请更新完整服务镜像' }); return true; }
      if (!this.passwordHash) { json(res, 503, { configured: false, message: '管理页面尚未配置密码，请在服务端设置 SYNC_ADMIN_PASSWORD 后重建网关容器' }); return true; }
      if (req.method === 'POST' && path === '/admin/api/login') { await this.login(req, res, ip); return true; }
      const session = this.session(req, !['GET', 'HEAD'].includes(req.method ?? ''));
      const vaultInPath = /^\/admin\/api\/vaults\/([\w-]+)/.exec(path)?.[1];
      if (vaultInPath && this.restoring.has(vaultInPath)) throw new SyncError('restore_busy', '仓库正在恢复，请稍后重试', 409);
      if (req.method === 'GET' && path === '/admin/api/session') { json(res, 200, { authenticated: true, configured: true, csrfToken: session.csrf, version: this.version }); return true; }
      if (req.method === 'POST' && path === '/admin/api/logout') {
        for (const [token, value] of this.sessions) if (value === session) this.sessions.delete(token);
        res.setHeader('Set-Cookie', this.cookie('', req, true)); json(res, 200, { ok: true }); return true;
      }
      if (req.method === 'GET' && path === '/admin/api/overview') {
        await this.store.health(); const vaults = await this.store.listVaults(), devices = await this.devices();
        json(res, 200, { serverId: this.store.serverId, backend: this.store.kind, protocol: PROTOCOL, version: this.version, uptimeSeconds: Math.floor((Date.now() - this.started) / 1000), vaults, devices,
          totals: { vaults: vaults.length, files: vaults.reduce((n, v) => n + v.files, 0), conflicts: vaults.reduce((n, v) => n + v.conflicts, 0), devices: devices.filter(d => !d.revoked).length, bytes: vaults.reduce((n, v) => n + v.bytes, 0), revisions: vaults.reduce((n, v) => n + v.revisionCount, 0) } }); return true;
      }
      if (path === '/admin/api/vaults') {
        if (req.method === 'GET') { json(res, 200, { vaults: await this.store.listVaults() }); return true; }
        if (req.method === 'POST') { json(res, 201, { vault: await this.store.createVault(name((await read(req))?.name)) }); return true; }
      }
      const vaultHistory = /^\/admin\/api\/vaults\/([\w-]+)\/restore$/.exec(path);
      if (vaultHistory) {
        const vaultId = vaultHistory[1]; assertId(vaultId);
        if (req.method === 'GET') { const point = url.searchParams.get('point') ?? ''; json(res, 200, await this.vaultRestore(vaultId, point)); return true; }
        if (req.method === 'POST') {
          const input = await read(req); if (typeof input?.point !== 'string' || typeof input?.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new SyncError('invalid_restore', '恢复预览无效', 400);
          json(res, 200, await this.vaultRestore(vaultId, input.point, input.fingerprint)); return true;
        }
      }
      const fileAction = /^\/admin\/api\/vaults\/([\w-]+)\/files\/([\w-]+)\/(history|restore)$/.exec(path);
      if (fileAction) {
        const [, vaultId, fileId, action] = fileAction; assertId(vaultId); assertId(fileId);
        const current = (await this.store.snapshot(vaultId)).files.find(file => file.fileId === fileId);
        if (!current) throw new SyncError('file_missing', '文件不存在', 404);
        if (action === 'history' && req.method === 'GET') {
          const revisionId = url.searchParams.get('revisionId');
          if (revisionId) {
            const revision = await this.historical(vaultId, fileId, revisionId);
            const content = revision.deleted ? null : (await this.store.getObject(vaultId, revision.hash!)).toString('utf8');
            json(res, 200, { revision, content }); return true;
          }
          const items = await this.store.history(vaultId, fileId, url.searchParams.get('before') || undefined);
          json(res, 200, { items, heads: current.heads.map(h => h.id), nextCursor: items.length === 100 ? items[items.length - 1].seq : null }); return true;
        }
        if (action === 'restore' && req.method === 'POST') {
          const input = await read(req); assertId(input?.revisionId);
          if (!Array.isArray(input?.expectedHeads) || !input.expectedHeads.length || input.expectedHeads.length > 32 || new Set(input.expectedHeads).size !== input.expectedHeads.length) throw new SyncError('invalid_heads', '请重新查看当前版本后重试', 400);
          input.expectedHeads.forEach(assertId);
          const selected = await this.historical(vaultId, fileId, input.revisionId);
          const revision = { ...selected, id: newId(), parents: [...input.expectedHeads].sort(), clientId: 'admin-restore' };
          const result = await this.store.commit(vaultId, revision, 'admin-restore', input.expectedHeads);
          json(res, 201, { revision: result.revision }); return true;
        }
        throw new SyncError('not_found', '管理接口不存在', 404);
      }
      const repo = /^\/admin\/api\/vaults\/([\w-]+)(?:\/(exclusions|invites|files|archive)(?:\/([\w-]+))?)?$/.exec(path);
      if (repo) {
        const [, id, action, fileId] = repo; assertId(id);
        if (fileId && action !== 'files') throw new SyncError('not_found', '管理接口不存在', 404);
        const vault = (await this.store.listVaults()).find(v => v.id === id);
        if (!vault) throw new SyncError('vault_missing', '仓库不存在', 404);
        if (action === 'archive' && req.method === 'POST') {
          if ((await read(req))?.name !== vault.name) throw new SyncError('vault_name_mismatch', '请输入完整仓库名称', 400);
          await this.store.archiveVault(id); json(res, 200, {ok: true}); return true;
        }
        if (action === 'files' && req.method === 'GET' && fileId) {
          assertId(fileId);
          const file = (await this.store.snapshot(id)).files.find(f => f.fileId === fileId);
          if (!file || file.heads.every(h => h.deleted)) throw new SyncError('file_missing', '文件不存在', 404);
          if (file.heads.length !== 1) throw new SyncError('file_conflict', '文件有多个版本，请先在插件中处理冲突', 409);
          const head = file.heads[0];
          const content = await this.store.getObject(id, head.hash!);
          json(res, 200, { path: head.path, content: content.toString('utf8'), revisionId: head.id }); return true;
        }
        if (action === 'files' && req.method === 'GET') {
          const snapshot = await this.store.snapshot(id);
          const files = snapshot.files.map(file => ({
            fileId: file.fileId,
            paths: [...new Set(file.heads.map(head => head.path))],
            size: Math.max(0, ...file.heads.filter(head => !head.deleted).map(head => head.size)),
            conflicts: file.heads.length > 1,
            deleted: file.heads.every(head => head.deleted),
          }));
          files.sort((a, b) => a.paths[0].localeCompare(b.paths[0], 'zh-CN'));
          json(res, 200, { files }); return true;
        }
        if (!action && req.method === 'PATCH') { await this.store.renameVault(id, name((await read(req))?.name)); json(res, 200, { ok: true }); return true; }
        if (action === 'exclusions' && req.method === 'PUT') {
          const data = await read(req); let rules: string[];
          try { rules = normalizeExclusions(data?.excludedPaths); }
          catch (e) { throw new SyncError('invalid_exclusions', e instanceof Error ? e.message : '排除规则无效', 400); }
          json(res, 200, { excludedPaths: await this.store.setExclusions(id, rules) }); return true;
        }
        if (action === 'invites' && req.method === 'POST') {
          const data = await read(req); let instructions: ReturnType<typeof invitationInstructions>;
          try { instructions = invitationInstructions(data?.server, '0'.repeat(24)); } catch { throw new SyncError('invalid_url', '请使用可访问的服务根地址', 400); }
          const pair = await this.store.createPair(vault.name, id);
          instructions = invitationInstructions(data.server, pair.code);
          json(res, 201, { vaultId: pair.vaultId, expires: pair.expires, ...instructions }); return true;
        }
      }
      if (req.method === 'GET' && path === '/admin/api/activity') {
        const vaultId = url.searchParams.get('vaultId') || undefined; if (vaultId) assertId(vaultId);
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SyncError('invalid_limit', '每页显示 1–100 条记录', 400);
        json(res, 200, await this.store.activity(vaultId, url.searchParams.get('before') || undefined, limit)); return true;
      }
      if (req.method === 'GET' && path === '/admin/api/devices') { json(res, 200, { devices: await this.devices() }); return true; }
      const device = /^\/admin\/api\/devices\/([\w-]+)\/revoke$/.exec(path);
      if (req.method === 'POST' && device) {
        assertId(device[1]); if (!(await this.store.devices()).some(d => d.id === device[1])) throw new SyncError('device_missing', '设备不存在', 404);
        await this.store.revoke(device[1]); json(res, 200, { ok: true }); return true;
      }
      throw new SyncError('not_found', '管理接口不存在', 404);
    } catch (e) {
      if (res.headersSent || res.destroyed) return true;
      if (e instanceof SyncError) json(res, e.status, { code: e.code, message: e.message });
      else json(res, 500, { code: 'admin_error', message: '管理操作失败，请检查服务和数据库状态' });
      return true;
    }
  }
  private async devices() { return (await this.store.devices()).map(d => ({ ...d, lastSeenAt: this.seen.get(d.id) ?? null })); }
}
