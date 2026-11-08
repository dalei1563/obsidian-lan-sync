/** Tailscale IPv4 addresses use the shared-address range 100.64.0.0/10.
 * Keep the exact range: public addresses elsewhere in 100.0.0.0/8 must retain
 * their usual proxy settings. Hostnames that merely start with it do not match.
 */
export function isTailnetIPv4(host: string): boolean {
  const octets = host.split('.');
  return octets.length === 4 && octets.every(v => /^\d{1,3}$/.test(v) && Number(v) <= 255) &&
    Number(octets[0]) === 100 && Number(octets[1]) >= 64 && Number(octets[1]) <= 127;
}
