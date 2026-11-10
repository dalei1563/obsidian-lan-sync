import { Changes, CommitResult, Cursor, hash, id, MAX_BYTES, PairResult, PROTOCOL, Revision, Snapshot, SyncError, validCursor, validateRevision } from '../../shared/protocol';
import { normalizeExclusions } from '../../shared/exclusions';

export interface HttpResponse { status: number; body: Buffer }
export type Transport = (url: string, method: string, headers: Record<string, string>, body?: Buffer) => Promise<HttpResponse>;
export function normalizeServer(value: string, allowHttp = false): string {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('请填写服务根地址，例如 https://notes.example.com');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (allowHttp || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('远程服务需要 HTTPS；测试内网 HTTP 需显式开启');
  return u.origin;
}
export class Remote {
  constructor(readonly url: string, readonly vaultId: string, readonly token: string, readonly transport: Transport) {}
  async request(path: string, method = 'GET', body?: Buffer, binary = false): Promise<Buffer> {
    const response = await this.transport(this.url + path, method, {
      Authorization: 'Bearer ' + this.token,
      ...(body ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}),
    }, body);
    if (response.status < 200 || response.status >= 300) {
      let value: any;
      try { value = JSON.parse(response.body.toString('utf8')); } catch { /* sanitized below */ }
      throw new SyncError(typeof value?.code === 'string' ? value.code : 'http_error', typeof value?.message === 'string' ? value.message.slice(0, 200) : `服务器返回 HTTP ${response.status}`, response.status);
    }
    return response.body;
  }
  private path(tail: string) { return `/v1/vaults/${this.vaultId}/${tail}`; }
  async snapshot(): Promise<Snapshot> {
    const s = JSON.parse((await this.request(this.path('state'))).toString('utf8')) as Snapshot;
    if (s.protocol !== PROTOCOL || !Array.isArray(s.files) || !validCursor(s.cursor) || typeof s.epoch !== 'string' || typeof s.serverId !== 'string') throw new Error('服务端协议或快照无效');
    if (s.excludedPaths !== undefined) s.excludedPaths = normalizeExclusions(s.excludedPaths);
    for (const file of s.files) { if (!file.heads.length) throw new Error('远端文件缺少版本'); file.heads = file.heads.map(validateRevision); if (file.heads.some(r => r.fileId !== file.fileId)) throw new Error('远端文件身份无效'); }
    return s;
  }
  async changes(cursor: Cursor, epoch: string): Promise<Changes> {
    const c = JSON.parse((await this.request(this.path(`changes?after=${encodeURIComponent(cursor)}&epoch=${encodeURIComponent(epoch)}`))).toString('utf8')) as Changes;
    if (!Array.isArray(c.changes) || !validCursor(c.cursor)) throw new Error('远端游标无效');
    if (c.excludedPaths !== undefined) c.excludedPaths = normalizeExclusions(c.excludedPaths);
    for (const event of c.changes) {
      if (!validCursor(event.seq) || !event.file.heads.length || (typeof cursor === 'number' && typeof event.seq === 'number' && event.seq <= cursor)) throw new Error('远端事件无效');
      event.file.heads = event.file.heads.map(validateRevision);
      if (event.file.heads.some(r => r.fileId !== event.file.fileId)) throw new Error('远端事件身份无效');
    }
    return c;
  }
  async put(data: Buffer, sha: string): Promise<void> { await this.request(this.path('objects/' + sha), 'PUT', data, true); }
  async get(sha: string): Promise<Buffer> {
    const data = await this.request(this.path('objects/' + sha));
    if (data.length > MAX_BYTES || hash(data) !== sha) throw new Error('下载内容校验失败');
    return data;
  }
  async commit(revision: Revision): Promise<CommitResult> {
    const r = JSON.parse((await this.request(this.path('commits'), 'POST', Buffer.from(JSON.stringify(revision)))).toString('utf8')) as CommitResult;
    if (JSON.stringify(validateRevision(r.revision)) !== JSON.stringify(validateRevision(revision))) throw new Error('提交回执与本地修订不一致');
    return r;
  }
  async commitStrict(revision: Revision, expectedHeads: string[]): Promise<CommitResult> {
    const r = JSON.parse((await this.request(this.path('reconcile'), 'POST', Buffer.from(JSON.stringify({ revision, expectedHeads })))).toString('utf8')) as CommitResult;
    if (JSON.stringify(validateRevision(r.revision)) !== JSON.stringify(validateRevision(revision))) throw new Error('提交回执与本地修订不一致');
    return r;
  }
  async history(fileId: string, before?: Cursor): Promise<{ seq: Cursor; revision: Revision }[]> {
    const value = JSON.parse((await this.request(this.path('history/' + fileId + (before !== undefined ? '?before=' + encodeURIComponent(before) : '')))).toString('utf8'));
    return value.revisions.map((r: any) => ({ seq: r.seq, revision: validateRevision(r.revision) }));
  }
  async known(ids: string[]): Promise<Set<string>> {
    const result = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const page = JSON.parse((await this.request(this.path('check'), 'POST', Buffer.from(JSON.stringify({ revisions: ids.slice(offset, offset + 100) })))).toString('utf8'));
      if (!Array.isArray(page.known) || page.known.some((v: unknown) => typeof v !== 'string' || !ids.includes(v))) throw new Error('版本核对响应无效');
      for (const value of page.known) result.add(value);
    }
    return result;
  }
  static async pair(url: string, code: string, name: string, transport: Transport, requestId: string = id()): Promise<PairResult> {
    const remote = new Remote(url, '', '', transport);
    return JSON.parse((await remote.request('/v1/pair', 'POST', Buffer.from(JSON.stringify({ code, deviceName: name, requestId })))).toString('utf8'));
  }
}
