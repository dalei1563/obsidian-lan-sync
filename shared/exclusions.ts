import { SyncError } from './protocol';

/** The same bounded rule format is used by server policy and per-Vault settings.
 * A trailing slash means a directory; * and ? stay within one segment, ** is a
 * complete segment matching any depth. A bare name also matches descendants. */
export function normalizeExclusions(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 64) throw new SyncError('invalid_exclusions', '排除规则必须是数组，最多 64 条', 400);
  const result: string[] = [], seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') throw new SyncError('invalid_exclusions', '每条排除规则必须是文本', 400);
    let rule = item.trim().normalize('NFC').replace(/\\/g, '/');
    if (!rule) continue;
    if (rule.startsWith('./')) rule = rule.slice(2);
    if (rule.endsWith('/')) rule += '**';
    const parts = rule.split('/');
    if (rule.length > 256 || !rule || /[\x00-\x1f\x7f<>:"|\[\]{}]/.test(rule) ||
      parts.some(p => !p || p === '.' || p === '..' || (p.includes('**') && p !== '**'))) {
      throw new SyncError('invalid_exclusions', '排除规则需使用相对路径；支持 *、?、** 和目录末尾 /，最长 256 字符', 400);
    }
    const key = rule.toLowerCase(); if (!seen.has(key)) { seen.add(key); result.push(rule); }
  }
  return result;
}

function segmentMatches(pattern: string, text: string): boolean {
  // Classic wildcard matching with linear backtracking to the latest star;
  // unlike building a regex, user-supplied repeated stars cannot cause ReDoS.
  let p = 0, t = 0, star = -1, retry = 0;
  while (t < text.length) {
    if (pattern[p] === '?' || pattern[p] === text[t]) { p++; t++; }
    else if (pattern[p] === '*') { star = p++; retry = t; }
    else if (star >= 0) { p = star + 1; t = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
function pathMatches(pattern: string[], path: string[]): boolean {
  // DP over path segments gives deterministic O(rule × path) work for **.
  let previous = Array<boolean>(path.length + 1).fill(false); previous[0] = true;
  for (const part of pattern) {
    const next = Array<boolean>(path.length + 1).fill(false);
    if (part === '**') {
      next[0] = previous[0];
      for (let i = 1; i <= path.length; i++) next[i] = previous[i] || next[i - 1];
    } else for (let i = 1; i <= path.length; i++) next[i] = previous[i - 1] && segmentMatches(part, path[i - 1]);
    previous = next;
  }
  return previous[path.length];
}
export function isExcluded(path: string, rules: readonly string[], configDir = '.obsidian'): boolean {
  const parts = path.normalize('NFC').replace(/\\/g, '/').toLowerCase().split('/');
  if (parts.some(p => p.startsWith('.'))) return true;
  const config = configDir.replace(/\\/g, '/').toLowerCase().split('/');
  if (config.every((p, i) => parts[i] === p)) return true;
  for (const rule of rules) {
    const pattern = rule.toLowerCase().split('/');
    if (pattern.length === 1 && pattern[0] !== '**') {
      if (parts.some(part => segmentMatches(pattern[0], part))) return true;
    } else if (pathMatches(pattern, parts)) return true;
  }
  return false;
}
