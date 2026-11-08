import { requestUrl } from 'obsidian';

/** POC only: credentials remain in this process and are never persisted. */
export interface AuthenticationProbeResult {
  ok: boolean;
  code?: number;
  expiresIn?: number;
  message: string;
}

export async function probeAuthentication(): Promise<AuthenticationProbeResult> {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const appId = runtime.process?.env?.XXL_APP_ID;
  const appSecret = runtime.process?.env?.XXL_APP_SECRET;
  if (!appId || !appSecret) {
    return { ok: false, message: 'Obsidian 进程未读取到 XXL_APP_ID 或 XXL_APP_SECRET。请设置环境变量后完全重启 Obsidian。' };
  }

  try {
    const response = await requestUrl({
      url: 'https://accounts.feishu.cn/oauth/v3/token',
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: appId, client_secret: appSecret }),
      throw: false,
    });
    const data = response.json as { code?: unknown; access_token?: unknown; expires_in?: unknown };
    const code = typeof data?.code === 'number' ? data.code : undefined;
    if (response.status >= 200 && response.status < 300 && code === 0 && typeof data.access_token === 'string' && data.access_token.length > 0) {
      return {
        ok: true,
        code,
        expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
        message: '应用鉴权成功；云盘和多维表格的资源权限尚未验证。',
      };
    }
    return { ok: false, code, message: `应用鉴权失败（HTTP ${response.status}${code === undefined ? '' : `，代码 ${code}`}）。` };
  } catch {
    // Never log error objects: a transport error could contain the request body.
    return { ok: false, message: '无法完成鉴权请求，请检查网络和飞书服务。' };
  }
}
