import { connectionUrl, encodeConnection } from '../shared/connection';
import { isTailnetIPv4 } from '../shared/network';

export function invitationInstructions(url: string, code: string) {
  const server = connectionUrl(url), host = new URL(server).hostname;
  const direct = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[::1\])/.test(host) || isTailnetIPv4(host);
  const connection = encodeConnection(server, code);
  const fetchWindows = direct
    ? `(& { $w=New-Object Net.WebClient; $w.Proxy=$null; try { $w.DownloadString('${server}/install.ps1') } finally { $w.Dispose() } })`
    : `(Invoke-WebRequest -UseBasicParsing '${server}/install.ps1').Content`;
  return {
    connection,
    windowsCommand: `& ([scriptblock]::Create(${fetchWindows})) -Connection '${connection}'`,
    macCommand: `curl -fsS${direct ? " --noproxy '*'" : ''} '${server}/install.sh' | bash -s -- --connection '${connection}'`,
  };
}
