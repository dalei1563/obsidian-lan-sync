import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeConnection } from '../../shared/connection';
import { id } from '../../shared/protocol';

/** Keeps the same claim ID across a lost pairing response or app restart. No
 * permanent device token is stored here. Pairing codes expire server-side. */
export class Enrollment {
  constructor(readonly folder: string) {}
  private read(name: string): any {
    const file = join(this.folder, name); if (!existsSync(file)) return null;
    const bytes = readFileSync(file); if (bytes.length > 8192) throw new Error('安装连接信息过大，请重新获取安装命令');
    return JSON.parse(bytes.toString('utf8').replace(/^\ufeff/, ''));
  }
  bootstrap(): string | null {
    const value = this.read('bootstrap.json');
    if (!value) return null;
    if (value.schema !== 1 || typeof value.connection !== 'string') throw new Error('安装连接信息无效，请重新获取安装命令');
    decodeConnection(value.connection); return value.connection;
  }
  claim(server: string, code: string): string {
    const previous = this.read('pair-claim.json');
    if (previous?.server === server && previous?.code === code && typeof previous.requestId === 'string') return previous.requestId;
    const requestId = id(); mkdirSync(this.folder, { recursive: true });
    writeFileSync(join(this.folder, 'pair-claim.json'), JSON.stringify({ server, code, requestId }), { mode: 0o600 });
    return requestId;
  }
  complete(): void {
    for (const name of ['bootstrap.json', 'pair-claim.json']) { const file = join(this.folder, name); if (existsSync(file)) unlinkSync(file); }
  }
}
