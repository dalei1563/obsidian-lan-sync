interface VaultSummary {
  id: string; name: string; createdAt: number | null; files: number; deletedFiles: number;
  conflicts: number; revisionCount: number; bytes: number; devices: number; excludedPaths: string[];
}
interface DeviceInfo { id: string; vault_id: string; name: string; revoked: number; lastSeenAt?: number | null }
interface ActivityItem {
  id: string; vaultId: string; vaultName: string; fileId: string; path: string;
  action: 'create' | 'update' | 'rename' | 'delete' | 'resolve'; deviceId: string; deviceName: string;
  bytes: number; createdAt: number | null;
}
interface ActivityPage { items: ActivityItem[]; nextCursor: string | null }
interface Overview {
  serverId: string; backend: string; protocol: number; version: string; uptimeSeconds: number;
  vaults: VaultSummary[]; devices: DeviceInfo[];
  totals: { vaults: number; files: number; conflicts: number; devices: number; bytes: number; revisions: number };
}
interface Invitation { vaultId: string; expires: number; connection: string; windowsCommand: string; macCommand: string }
type View = 'overview' | 'vaults' | 'activity' | 'devices' | 'settings';
type IconName = 'grid' | 'folder' | 'activity' | 'devices' | 'settings' | 'arrow' | 'plus' | 'refresh' | 'copy' | 'logout' | 'close' | 'search' | 'server' | 'file' | 'check' | 'alert' | 'clock' | 'shield';
const paths: Record<IconName, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  activity: 'M3 12h4l3-8 4 16 3-8h4', devices: 'M3 4h18v12H3z M8 21h8 M12 16v5',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  arrow: 'M5 12h14 M13 6l6 6-6 6', plus: 'M12 5v14 M5 12h14',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-2l2 2 M4 17l2 2a7 7 0 0 0 12-2',
  copy: 'M8 8h13v13H8z M4 16H3V3h13v1', logout: 'M10 4H4v16h6 M8 12h13 M16 7l5 5-5 5',
  close: 'M6 6l12 12 M6 18 18 6', search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  server: 'M3 3h18v7H3z M3 14h18v7H3z M7 6h.01 M7 17h.01',
  file: 'M14 2H5v20h14V7z M14 2v5h5 M8 12h8 M8 16h8', check: 'M5 12l4 4L19 6',
  alert: 'M12 3 2 21h20z M12 9v5 M12 17h.01', clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z M8 12l3 3 5-6',
};
function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', paths[name]); svg.append(p); return svg;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
}
function append<T extends Node>(parent: T, ...children: (Node | string | null | undefined)[]): T {
  for (const child of children) if (child !== null && child !== undefined) parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); return parent;
}
function button(text: string, action?: () => void, kind = '', glyph?: IconName): HTMLButtonElement {
  const b = el('button', 'button ' + kind); b.type = 'button'; if (glyph) b.append(icon(glyph)); b.append(document.createTextNode(text)); if (action) b.addEventListener('click', action); return b;
}
function badge(text: string, color = '') { return el('span', 'badge ' + color, text); }
function date(value: number | null | undefined, full = false): string {
  if (!value || !Number.isFinite(value)) return '历史记录 · 时间未知';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', ...(full ? { year: 'numeric' as const } : {}), hour: '2-digit', minute: '2-digit', hour12: false });
}
function size(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const power = Math.min(3, Math.floor(Math.log(value) / Math.log(1024))); return (value / 1024 ** power).toFixed(power ? 1 : 0) + ' ' + ['B', 'KiB', 'MiB', 'GiB'][power];
}
function count(value: number) { return Number(value || 0).toLocaleString('zh-CN'); }
function uptime(seconds: number): string { const m = Math.floor(seconds / 60); return m >= 1440 ? `${Math.floor(m / 1440)} 天 ${Math.floor(m % 1440 / 60)} 小时` : m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`; }
class ApiError extends Error { constructor(readonly status: number, message: string, readonly data?: Record<string, unknown>, readonly generation = -1) { super(message); } }
const appRoot = document.getElementById('app')!;
const toastRoot = document.getElementById('toasts')!;
function toast(message: string, error = false) {
  const node = el('div', 'toast' + (error ? ' error' : '')); node.setAttribute('role', error ? 'alert' : 'status');
  append(node, icon(error ? 'alert' : 'check'), el('span', '', message)); toastRoot.append(node); window.setTimeout(() => node.remove(), error ? 8000 : 3800);
}
async function copy(text: string): Promise<void> {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); return; } } catch { /* HTTP and browser permissions use the fallback below. */ }
  const focused = document.activeElement as HTMLElement | null, helper = el('textarea', 'clipboard-helper'); helper.value = text; helper.setAttribute('readonly', '');
  // A native modal makes the rest of the document inert. Keep the fallback
  // selection inside that modal so copy also works on plain HTTP origins.
  (document.querySelector('dialog[open]') ?? document.body).append(helper); helper.select(); helper.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy'); helper.remove(); focused?.focus();
  if (!copied) throw new Error('浏览器未允许复制，请选中文本后手动复制'); toast('已复制到剪贴板');
}

class Manager {
  private csrf = '';
  private authenticated = false;
  private overview?: Overview;
  private view: View = 'overview';
  private selectedVault = '';
  private activityFilter = '';
  private deviceFilter = '';
  private activity?: ActivityPage;
  private activityBusy = false;
  private activityRequest = 0;
  private dashboardActivity?: ActivityItem[];
  private refreshedAt = 0;
  private refreshing = false;
  private overviewSequence = 0;
  private sessionGeneration = 0;
  private started = false;
  private content?: HTMLElement;
  private dialog?: HTMLDialogElement;
  private drafts = new Map<string, string>();
  private repoSearch = '';
  private readonly viewNames: Record<View, string> = { overview: '同步总览', vaults: '笔记仓库', activity: '同步记录', devices: '设备管理', settings: '服务设置' };

  async start() {
    if (!this.started) {
      this.started = true;
    window.addEventListener('hashchange', () => { if (this.authenticated) this.route(); });
    window.setInterval(() => {
      if (!this.authenticated || this.refreshing || this.dialog?.open || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '')) return;
      if (this.content?.contains(document.activeElement) && document.activeElement instanceof HTMLButtonElement) return;
      void this.loadOverview(this.view === 'overview').catch(e => {
        if (e instanceof ApiError && e.generation >= 0 && e.generation !== this.sessionGeneration) return;
        if (e instanceof ApiError && e.status === 401) { this.authenticated = false; this.csrf = ''; this.overview = undefined; this.renderLogin(false, '登录已过期，请重新输入管理员密码'); }
        else { const status = document.getElementById('service-status'); if (status) { status.className = 'badge orange'; status.textContent = '连接待检查'; } }
      });
    }, 20000);
    }
    try {
      const session = await this.api<{ authenticated: boolean; csrfToken: string }>('/session');
      this.authenticated = session.authenticated; this.csrf = session.csrfToken;
      if (!this.authenticated) return this.renderLogin();
      await this.loadOverview(false); this.renderShell(); this.route();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.data?.configured === false)) this.renderLogin(e.data?.configured === false);
      else this.renderLogin(false, e instanceof Error ? e.message : '服务暂时不可用');
    }
  }

  private async api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const generation = this.sessionGeneration;
    const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/admin/api' + path, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method !== 'GET' && this.csrf ? { 'X-CSRF-Token': this.csrf } : {}) },
        body: data === undefined ? undefined : JSON.stringify(data) });
      let value: Record<string, unknown>;
      if (response.status === 204) value = {};
      else { try { value = await response.json(); } catch { throw new ApiError(response.status || 500, '服务器没有返回管理接口数据，请检查服务地址与反向代理', undefined, generation); } }
      if (!response.ok) throw new ApiError(response.status, typeof value.message === 'string' ? value.message.slice(0, 400) : `请求失败（HTTP ${response.status}）`, value, generation);
      return value as T;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(0, controller.signal.aborted ? '请求超时，请检查服务状态后重试' : '无法连接同步服务，请检查网络后重试', undefined, generation);
    } finally { window.clearTimeout(timer); }
  }

  private async run(task: () => Promise<unknown>, b?: HTMLButtonElement): Promise<void> {
    if (b?.disabled) return;
    const wasFocused = !!b && document.activeElement === b;
    if (b) { b.disabled = true; b.setAttribute('aria-busy', 'true'); }
    try { await task(); }
    catch (e) {
      if (e instanceof ApiError && e.generation >= 0 && e.generation !== this.sessionGeneration) return;
      if (e instanceof ApiError && e.status === 401) {
        this.authenticated = false; this.csrf = ''; this.overview = undefined; this.closeDialog(); this.renderLogin(false, '登录已过期，请重新输入管理员密码');
      } else toast(e instanceof Error ? e.message : '操作失败，请稍后重试', true);
    } finally { if (b) { b.disabled = false; b.removeAttribute('aria-busy'); if (wasFocused && b.isConnected && (!document.activeElement || document.activeElement === document.body)) b.focus(); } }
  }

  private renderLogin(unconfigured = false, error = '') {
    this.sessionGeneration++; this.authenticated = false; this.dashboardActivity = undefined; this.activity = undefined; this.activityRequest++; appRoot.replaceChildren();
    const screen = el('main', 'login-screen'), wrap = el('div', 'login-wrap'), brand = el('div', 'login-brand');
    append(brand, el('span', 'brand-mark', 'N'), el('span', '', 'LAN Note Sync'));
    const card = el('section', 'login-card'); append(card, el('h1', '', '管理你的笔记同步'), el('p', '', '输入管理员密码，进入你自己的同步服务。'));
    if (unconfigured) {
      const info = el('div', 'notice warn'); append(info, icon('shield'), el('span', '', '后台尚未设置管理员密码。请在服务端配置 SYNC_ADMIN_PASSWORD 并重新启动网关。新部署可由安装脚本自动生成。'));
      const retry = button('重新检查', () => void this.start(), 'primary', 'refresh'); append(card, info, retry);
    } else {
      const form = el('form'), label = el('label', 'field-label', '管理员密码'), input = el('input', 'input');
      label.htmlFor = 'admin-password'; input.id = 'admin-password'; input.name = 'password'; input.type = 'password'; input.autocomplete = 'current-password'; input.required = true; input.maxLength = 256;
      input.placeholder = '请输入管理员密码';
      const err = el('div', 'inline-error', error); err.hidden = !error; err.setAttribute('role', 'alert');
      const submit = button('登录管理台', undefined, 'primary', 'arrow'); submit.type = 'submit';
      form.addEventListener('submit', event => {
        event.preventDefault(); if (submit.disabled) return; submit.disabled = true; submit.setAttribute('aria-busy', 'true'); err.hidden = true;
        void (async () => {
          try {
            const result = await this.api<{ csrfToken: string }>('/login', 'POST', { password: input.value }); input.value = '';
            this.sessionGeneration++; this.authenticated = true; this.csrf = result.csrfToken; await this.loadOverview(false); this.renderShell(); this.route();
          } catch (e) { this.authenticated = false; this.csrf = ''; err.textContent = e instanceof Error ? e.message : '登录失败'; err.hidden = false; input.value = ''; input.focus(); }
          finally { submit.disabled = false; submit.removeAttribute('aria-busy'); }
        })();
      });
      append(form, label, input, err, submit); card.append(form); window.setTimeout(() => input.focus(), 0);
    }
    append(wrap, brand, card, el('p', 'login-foot', '一个管理员密码，无需注册账户。')); screen.append(wrap); appRoot.append(screen);
  }

  private async loadOverview(render = true) {
    const sequence = ++this.overviewSequence, generation = this.sessionGeneration;
    this.refreshing = true;
    try {
      const overview = await this.api<Overview>('/overview');
      if (sequence !== this.overviewSequence || generation !== this.sessionGeneration) return;
      this.overview = overview; this.refreshedAt = Date.now();
      const status = document.getElementById('service-status'); if (status) { status.className = 'badge green'; status.replaceChildren(el('span', 'status-dot'), document.createTextNode('服务已连接')); }
      const stamp = document.getElementById('refresh-stamp'); if (stamp) stamp.textContent = '更新于 ' + new Date(this.refreshedAt).toLocaleTimeString('zh-CN', { hour12: false });
      if (render && this.view === 'overview') this.dashboardActivity = undefined;
      if (render && this.authenticated) this.renderContent();
    } finally { if (sequence === this.overviewSequence) this.refreshing = false; }
  }

  private navigate(view: View, vaultId = '') {
    const hash = '#/' + view + (vaultId ? '/' + encodeURIComponent(vaultId) : '');
    if (location.hash === hash) this.route(); else location.hash = hash;
  }
  private route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    this.view = Object.prototype.hasOwnProperty.call(this.viewNames, parts[0]) ? parts[0] as View : 'overview';
    try { this.selectedVault = this.view === 'vaults' && parts[1] ? decodeURIComponent(parts[1]) : ''; } catch { this.selectedVault = ''; }
    for (const item of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view]'))) { const selected = item.dataset.view === this.view; item.classList.toggle('active', selected); if (selected) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); }
    const crumb = document.getElementById('breadcrumb-current'); if (crumb) crumb.textContent = this.viewNames[this.view];
    document.title = this.viewNames[this.view] + ' · LAN Note Sync'; this.renderContent();
  }

  private renderShell() {
    appRoot.replaceChildren(); const layout = el('div', 'layout'), side = el('aside', 'sidebar');
    const brand = el('div', 'sidebar-brand'), copy = el('div', 'brand-copy'); append(copy, el('strong', '', 'LAN Note Sync'), el('span', '', 'SELF HOSTED SYNC'));
    append(brand, el('span', 'brand-mark', 'N'), copy); side.append(brand, el('div', 'nav-label', '工作空间'));
    const nav = el('nav', 'nav'); nav.setAttribute('aria-label', '管理导航');
    const items: [View, IconName][] = [['overview', 'grid'], ['vaults', 'folder'], ['activity', 'activity'], ['devices', 'devices'], ['settings', 'settings']];
    for (const [view, glyph] of items) {
      const item = el('button', 'nav-item'); item.type = 'button'; item.dataset.view = view; append(item, icon(glyph), el('span', '', this.viewNames[view]));
      if (view === 'vaults') item.append(el('span', 'nav-count', count(this.overview?.vaults.length ?? 0)));
      item.addEventListener('click', () => this.navigate(view)); nav.append(item);
    }
    side.append(nav);
    const bottom = el('div', 'sidebar-bottom'), service = el('div', 'sidebar-server'); const serviceText = el('div');
    append(serviceText, el('strong', '', '自己的同步服务'), el('span', '', '由 CouchDB 持久化数据')); append(service, icon('server'), serviceText); bottom.append(service);
    const logout = el('button', 'nav-item'); append(logout, icon('logout'), el('span', '', '退出管理台')); logout.addEventListener('click', () => void this.logout(logout)); bottom.append(logout); side.append(bottom);
    const main = el('div', 'main'), top = el('header', 'topbar'), breadcrumb = el('div', 'breadcrumb'), current = el('strong', '', this.viewNames[this.view]); current.id = 'breadcrumb-current';
    append(breadcrumb, icon('server'), el('span', '', '管理台'), el('span', '', '/'), current);
    const meta = el('div', 'topbar-meta'), stamp = el('span', 'refresh-label', '更新于 ' + new Date(this.refreshedAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })); stamp.id = 'refresh-stamp';
    const ready = badge('服务已连接', 'green'); ready.id = 'service-status'; ready.prepend(el('span', 'status-dot')); append(meta, stamp, ready, el('span', 'avatar', '管'));
    append(top, breadcrumb, meta); this.content = el('main', 'content'); this.content.id = 'main-content'; append(main, top, this.content); append(layout, side, main); appRoot.append(layout);
  }

  private renderContent() {
    if (!this.authenticated || !this.content || !this.overview) return;
    this.content.replaceChildren();
    if (this.view === 'overview') this.renderOverview();
    else if (this.view === 'vaults') this.selectedVault ? this.renderVaultDetail() : this.renderVaults();
    else if (this.view === 'activity') this.renderActivity();
    else if (this.view === 'devices') this.renderDevices();
    else this.renderSettings();
  }
  private head(title: string, description: string, ...actions: HTMLElement[]) {
    const head = el('div', 'page-head'), text = el('div'); append(text, el('h1', '', title), el('p', '', description));
    append(head, text, append(el('div', 'page-actions'), ...actions)); this.content!.append(head);
  }
  private refreshButton() {
    const b = button('刷新', () => void this.run(async () => { await this.loadOverview(); if (this.view === 'activity') await this.loadActivity(); }, b), 'subtle', 'refresh'); return b;
  }
  private metric(label: string, value: string, note: string, glyph: IconName, color = '') {
    const card = el('div', 'metric'), top = el('div', 'metric-top'); append(top, el('span', '', label), append(el('span', 'metric-icon ' + color), icon(glyph)));
    return append(card, top, el('strong', 'metric-value', value), el('span', 'metric-note', note));
  }
  private card(title: string, subtitle = '', action?: HTMLElement): { card: HTMLElement; body: HTMLElement } {
    const card = el('section', 'card'), head = el('div', 'card-head'), titles = el('div'); append(titles, el('h2', 'card-title', title)); if (subtitle) titles.append(el('p', 'card-subtitle', subtitle)); append(head, titles, action); const body = el('div'); append(card, head, body); return { card, body };
  }
  private empty(title: string, text: string, glyph: IconName = 'folder', action?: HTMLElement) {
    return append(el('div', 'empty'), append(el('div', 'empty-icon'), icon(glyph)), el('strong', '', title), el('p', '', text), action);
  }

  private renderOverview() {
    const data = this.overview!, totals = data.totals;
    this.head('同步总览', '查看笔记仓库、设备授权和最近的文件变更。', this.refreshButton(), button('新建仓库', () => this.vaultNameDialog(), 'primary', 'plus'));
    const metrics = el('div', 'metrics'); append(metrics,
      this.metric('笔记仓库', count(totals.vaults), '独立存储 · 按仓库配对', 'folder'),
      this.metric('同步文件', count(totals.files), '当前有效的逻辑文件', 'file', 'green'),
      this.metric('已授权设备', count(totals.devices), '每台设备使用独立凭证', 'devices', 'purple'),
      this.metric('版本冲突', count(totals.conflicts), totals.conflicts ? '在 Obsidian 插件中选择保留版本' : '当前没有需要选择的并发版本', 'shield', 'orange'));
    this.content!.append(metrics);
    const repos = this.card('笔记仓库', '一个服务可以管理多个独立的 Obsidian 笔记库', button('查看全部', () => this.navigate('vaults'), 'link'));
    repos.body.append(this.vaultTable(data.vaults.slice(0, 5))); this.content!.append(repos.card);
    const columns = el('div', 'two-col'), recent = this.card('最近同步记录', '服务端已接收的文件变更', button('全部记录', () => this.navigate('activity'), 'link'));
    if (this.dashboardActivity) recent.body.append(this.activityTable(this.dashboardActivity, true));
    else {
      recent.body.append(el('div', 'loading', '正在读取最近变更…'));
      void this.api<ActivityPage>('/activity?limit=5').then(page => { this.dashboardActivity = page.items; if (this.view === 'overview' && recent.body.isConnected) recent.body.replaceChildren(this.activityTable(page.items, true)); }).catch(e => { if (recent.body.isConnected) recent.body.replaceChildren(this.empty('暂时无法读取记录', e instanceof Error ? e.message : '请刷新重试', 'activity')); });
    }
    const quick = this.card('快速开始', '把配置留在服务端，让写作更简单'), quickBody = el('div', 'card-body quick-actions');
    quickBody.append(this.quickAction('新建独立仓库', '给另一套笔记留出独立空间', 'folder', () => this.vaultNameDialog()));
    quickBody.append(this.quickAction('连接一台新设备', '选择仓库，生成一次性安装命令', 'devices', () => { if (data.vaults.length === 1) void this.inviteDialog(data.vaults[0]); else this.navigate('vaults'); }));
    quickBody.append(this.quickAction('设置排除规则', '按仓库决定哪些文件参与同步', 'shield', () => { if (data.vaults.length === 1) this.navigate('vaults', data.vaults[0].id); else this.navigate('vaults'); }));
    append(quickBody, el('div', 'divider'), this.infoList([['正文占用', size(totals.bytes)], ['累计业务版本', count(totals.revisions)], ['服务运行', uptime(data.uptimeSeconds)]])); quick.body.append(quickBody); append(columns, recent.card, quick.card); this.content!.append(columns);
    this.content!.append(el('p', 'footnote', '管理台展示服务端状态。设备断网、打开中的笔记和本地待上传项，请在对应 Obsidian 插件中查看。'));
  }
  private quickAction(title: string, description: string, glyph: IconName, action: () => void) {
    const b = el('button', 'quick-action'); b.type = 'button'; const text = el('div'); append(text, el('strong', '', title), el('p', '', description)); append(b, append(el('span', 'quick-icon'), icon(glyph)), text, icon('arrow')); b.addEventListener('click', action); return b;
  }
  private infoList(items: [string, string][]) {
    const list = el('dl', 'info-list'); for (const [label, value] of items) append(list, append(el('div', 'info-row'), el('dt', '', label), el('dd', '', value))); return list;
  }
  private table(headers: string[]) {
    const wrap = el('div', 'table-wrap'), table = el('table'), head = el('thead'), row = el('tr'), body = el('tbody');
    for (const text of headers) row.append(el('th', '', text)); head.append(row); append(table, head, body); wrap.append(table); return { wrap, body };
  }
  private vaultTable(vaults: VaultSummary[]) {
    if (!vaults.length) return this.empty('还没有笔记仓库', '新建一个仓库，再为每台设备生成独立的连接码，就可以开始同步。', 'folder', button('新建仓库', () => this.vaultNameDialog(), 'primary small', 'plus'));
    const { wrap, body } = this.table(['仓库名称', '文件', '正文占用', '设备', '状态', '操作']);
    for (const vault of vaults) {
      const row = el('tr'), name = el('td'), cell = el('div', 'name-cell'), text = el('div');
      const title = button(vault.name, () => this.navigate('vaults', vault.id), 'link'); title.title = vault.name;
      append(text, append(el('strong'), title), el('div', 'subline mono', vault.id.slice(0, 8))); append(cell, append(el('span', 'folder-icon'), icon('folder')), text); name.append(cell);
      const state = el('td'); state.append(vault.conflicts ? badge(`${count(vault.conflicts)} 项冲突`, 'orange') : badge('正常', 'green'));
      const actions = el('td'), buttons = el('div', 'table-actions');
      append(buttons, button('管理', () => this.navigate('vaults', vault.id), 'small'), button('连接设备', () => void this.inviteDialog(vault), 'small primary')); actions.append(buttons);
      append(row, name, el('td', '', count(vault.files)), el('td', '', size(vault.bytes)), el('td', '', count(vault.devices)), state, actions); body.append(row);
    }
    return wrap;
  }

  private renderVaults() {
    this.head('笔记仓库', '每个 Obsidian 笔记库都能独立配对，数据按仓库隔离。', this.refreshButton(), button('新建仓库', () => this.vaultNameDialog(), 'primary', 'plus'));
    const card = el('section', 'card'), toolbar = el('div', 'card-toolbar'), search = el('div', 'search'), input = el('input', 'input');
    input.type = 'search'; input.placeholder = '搜索仓库名称或 ID'; input.setAttribute('aria-label', '搜索仓库'); input.value = this.repoSearch;
    append(search, icon('search'), input); append(toolbar, search, el('span', 'muted small-text', `共 ${count(this.overview!.vaults.length)} 个仓库`));
    const tableRoot = el('div'), update = () => {
      const term = input.value.trim().toLowerCase(); this.repoSearch = input.value;
      const matches = this.overview!.vaults.filter(v => v.name.toLowerCase().includes(term) || v.id.toLowerCase().includes(term));
      tableRoot.replaceChildren(matches.length || !term ? this.vaultTable(matches) : this.empty('没有匹配的仓库', '试试其他名称，或清空搜索条件。', 'search'));
    }; input.addEventListener('input', update); update(); append(card, toolbar, tableRoot); this.content!.append(card);
    this.content!.append(el('p', 'footnote', '插件在每个本地笔记库中分别安装和保存连接。同一远端仓库可连接多台设备；新建远端仓库后，为它单独生成连接码。'));
  }

  private renderVaultDetail() {
    const vault = this.overview!.vaults.find(v => v.id === this.selectedVault);
    if (!vault) { this.head('仓库不存在', '这个仓库可能尚未加载，请刷新列表。', button('返回仓库列表', () => this.navigate('vaults'))); return; }
    const back = button('返回仓库列表', () => this.navigate('vaults'), 'link'); back.classList.add('back-link'); this.content!.append(back);
    this.head(vault.name, `仓库 ID：${vault.id}`, button('重命名', () => this.vaultNameDialog(vault)), button('连接新设备', () => void this.inviteDialog(vault), 'primary', 'plus'));
    const cols = el('div', 'two-col'), policy = this.card('排除同步', '规则保存在这个仓库中，供配套插件读取'), policyBody = el('div', 'card-body');
    const notice = el('div', 'notice'); append(notice, icon('shield'), el('span', '', '.obsidian 和隐藏路径始终不会同步。新增排除规则会暂停相关文件的同步，保留本地文件和已同步的云端内容。'));
    const chips = el('div', 'rule-chips'); chips.append(el('span', 'rule-chip', '.obsidian/**'), el('span', 'rule-chip', '隐藏目录 · 固定排除'));
    const label = el('label', 'field-label', '自定义排除规则 · 每行一条'), rules = el('textarea', 'input textarea'); rules.id = 'exclusion-rules'; label.htmlFor = rules.id; rules.rows = 7; rules.spellcheck = false;
    rules.placeholder = '私人笔记/**\n**/草稿/**\n**/*.tmp.md'; rules.value = this.drafts.get(vault.id) ?? vault.excludedPaths.join('\n');
    rules.addEventListener('input', () => this.drafts.set(vault.id, rules.value));
    const hint = el('p', 'field-help', '支持具体文件、目录以及 *、?、** 通配符。例如：私人笔记/**、**/草稿/**。排除规则需使用 0.4 或更新版本插件。');
    const save = button('保存排除规则', () => void this.run(async () => {
      const excludedPaths = rules.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      const result = await this.api<{ excludedPaths: string[] }>('/vaults/' + encodeURIComponent(vault.id) + '/exclusions', 'PUT', { excludedPaths });
      this.drafts.delete(vault.id); rules.value = result.excludedPaths.join('\n'); await this.loadOverview(); toast('排除规则已保存，设备下次同步时生效');
    }, save), 'primary', 'check');
    append(policyBody, notice, chips, label, rules, hint, append(el('div', 'save-row'), el('span', '', '不会删除任何已同步文件。重新纳入后会继续核对版本。'), save)); policy.body.append(policyBody);
    const info = this.card('仓库信息'), infoBody = el('div', 'card-body');
    const stats = el('div', 'detail-stats'); for (const [value, text] of [[count(vault.files), '当前文件'], [count(vault.devices), '已授权设备'], [count(vault.conflicts), '并发冲突']] as [string, string][]) append(stats, append(el('div', 'detail-stat'), el('strong', '', value), el('span', '', text)));
    append(infoBody, stats, this.infoList([['正文占用', size(vault.bytes)], ['累计业务版本', count(vault.revisionCount)], ['已删除文件身份', count(vault.deletedFiles)], ['创建时间', date(vault.createdAt, true)]]));
    const copyId = button('复制完整仓库 ID', () => void this.run(() => copy(vault.id)), 'small', 'copy'); infoBody.append(el('div', 'divider'), copyId);
    info.body.append(infoBody); append(cols, policy.card, info.card); this.content!.append(cols);
    const linked = this.card('连接到这个仓库的设备', '每台设备使用自己的连接码和凭证', button('查看设备管理', () => { this.deviceFilter = vault.id; this.navigate('devices'); }, 'link'));
    linked.body.append(this.deviceTable(this.overview!.devices.filter(d => d.vault_id === vault.id))); this.content!.append(linked.card);
  }

  private vaultFilter(value: string, onChange: (value: string) => void, label: string): HTMLSelectElement {
    const select = el('select', 'select'); select.setAttribute('aria-label', label); const all = el('option', '', '全部仓库'); all.value = ''; select.append(all);
    for (const vault of this.overview!.vaults) { const option = el('option', '', vault.name); option.value = vault.id; select.append(option); }
    select.value = value; select.addEventListener('change', () => onChange(select.value)); return select;
  }
  private renderActivity() {
    this.head('同步记录', '查看服务端已接收的文件变更，支持按仓库筛选。', this.refreshButton());
    const card = this.card('文件变更记录', '正文内容和设备凭证不会展示在这里'), toolbar = el('div', 'card-toolbar');
    append(toolbar, this.vaultFilter(this.activityFilter, value => { this.activityFilter = value; this.activity = undefined; void this.run(() => this.loadActivity()); }, '筛选记录的仓库'), el('span', 'muted small-text', '最近的变更在前'));
    card.body.append(toolbar); const rows = el('div'); rows.id = 'activity-rows'; card.body.append(rows); this.content!.append(card.card);
    if (this.activity) this.renderActivityRows(); else { rows.append(el('div', 'loading', '正在读取记录…')); void this.run(() => this.loadActivity()); }
    this.content!.append(el('p', 'footnote', '这里是已提交的业务版本记录。设备离线时发生的网络错误不会出现在服务端记录中，请在插件查看。旧版本没有记录时间时会标明“时间未知”。'));
  }
  private async loadActivity(more = false) {
    if (this.activityBusy && more) return;
    const sequence = ++this.activityRequest; this.activityBusy = true;
    const rows = document.getElementById('activity-rows'); if (!more && rows) rows.replaceChildren(el('div', 'loading', '正在读取记录…'));
    try {
      const params = new URLSearchParams({ limit: '50' }); if (this.activityFilter) params.set('vaultId', this.activityFilter); if (more && this.activity?.nextCursor) params.set('before', this.activity.nextCursor);
      const result = await this.api<ActivityPage>('/activity?' + params);
      if (sequence !== this.activityRequest) return;
      this.activity = { items: more ? [...(this.activity?.items ?? []), ...result.items] : result.items, nextCursor: result.nextCursor };
      if (this.view === 'activity') this.renderActivityRows();
    } catch (e) {
      if (sequence === this.activityRequest && rows?.isConnected) rows.replaceChildren(this.empty('暂时无法读取记录', e instanceof Error ? e.message : '请刷新重试', 'activity'));
      throw e;
    } finally { if (sequence === this.activityRequest) this.activityBusy = false; }
  }
  private renderActivityRows() {
    const root = document.getElementById('activity-rows'); if (!root || !this.activity) return;
    root.replaceChildren(this.activityTable(this.activity.items));
    const footer = el('div', 'table-footer'); footer.append(el('span', '', `已显示 ${count(this.activity.items.length)} 条记录`));
    if (this.activity.nextCursor) { const more = button('加载更早记录', () => void this.run(() => this.loadActivity(true), more), 'small'); footer.append(more); }
    else footer.append(el('span', '', '已加载全部')); root.append(footer);
  }
  private activityTable(items: ActivityItem[], compact = false) {
    if (!items.length) return this.empty('还没有同步记录', '连接设备并提交笔记变更后，记录会显示在这里。', 'activity');
    const { wrap, body } = this.table(compact ? ['文件 / 操作', '仓库', '时间'] : ['操作', '文件路径', '仓库', '设备', '正文大小', '时间']);
    const labels: Record<ActivityItem['action'], string> = { create: '新增', update: '更新', rename: '移动', delete: '删除', resolve: '解决冲突' };
    for (const item of items) {
      const row = el('tr'), action = el('span', 'action-tag ' + item.action, labels[item.action] ?? '变更'); action.prepend(icon(item.action === 'delete' ? 'close' : item.action === 'resolve' ? 'check' : 'file'));
      if (compact) {
        const file = el('td'), text = el('div', 'activity-file', item.path); text.title = item.path; append(file, text, append(el('div', 'subline'), action)); append(row, file, el('td', '', item.vaultName), el('td', 'muted', date(item.createdAt)));
      } else {
        const file = el('td', 'path-cell', item.path); file.title = item.path;
        append(row, append(el('td'), action), file, el('td', '', item.vaultName), el('td', '', item.deviceName || item.deviceId.slice(0, 8)), el('td', '', size(item.bytes)), el('td', 'muted', date(item.createdAt, true)));
      }
      body.append(row);
    }
    return wrap;
  }

  private renderDevices() {
    this.head('设备管理', '查看设备授权；遗失或停用的设备可以单独撤销。', this.refreshButton());
    const card = this.card('连接设备', '授权状态与实时在线状态不同'), toolbar = el('div', 'card-toolbar');
    append(toolbar, this.vaultFilter(this.deviceFilter, value => { this.deviceFilter = value; this.renderContent(); }, '筛选设备的仓库'), el('span', 'muted small-text', `${count(this.overview!.devices.filter(d => !d.revoked).length)} 台已授权`));
    card.body.append(toolbar, this.deviceTable(this.overview!.devices.filter(d => !this.deviceFilter || d.vault_id === this.deviceFilter))); this.content!.append(card.card);
    const note = el('div', 'notice'); append(note, icon('shield'), el('span', '', '撤销设备不会删除它已经提交的笔记和历史。重新使用这台设备时，需要为它生成新的连接码。')); this.content!.append(note);
  }
  private deviceTable(items: DeviceInfo[]) {
    if (!items.length) return this.empty('还没有连接设备', '选择笔记仓库，生成一条安装命令，然后在对应电脑的笔记库中启用插件。', 'devices');
    const { wrap, body } = this.table(['设备名称', '所属仓库', '最近活动', '授权状态', '操作']);
    for (const device of [...items].sort((a, b) => Number(!!a.revoked) - Number(!!b.revoked))) {
      const row = el('tr'), name = el('td'), label = el('div', 'name-cell'), text = el('div'); append(text, el('strong', '', device.name || '未命名设备'), el('div', 'subline mono', device.id.slice(0, 8))); append(label, append(el('span', 'folder-icon'), icon('devices')), text); name.append(label);
      const repo = this.overview!.vaults.find(v => v.id === device.vault_id), recent = device.lastSeenAt ? date(device.lastSeenAt) : '本次启动后暂无记录';
      const state = el('td'); state.append(device.revoked ? badge('已撤销') : badge('已授权', 'green')); const action = el('td', 'align-right');
      if (!device.revoked) action.append(button('撤销授权', () => this.revokeDialog(device), 'small danger'));
      else action.append(el('span', 'muted', '—'));
      append(row, name, el('td', '', repo?.name ?? device.vault_id.slice(0, 8)), el('td', 'muted', recent), state, action); body.append(row);
    }
    return wrap;
  }

  private renderSettings() {
    const data = this.overview!;
    this.head('服务设置', '查看当前服务信息和管理入口。', this.refreshButton());
    const grid = el('div', 'settings-grid'), info = this.card('服务信息'), body = el('div', 'card-body');
    append(body, this.infoList([['服务状态', '数据库连接正常'], ['网关版本', data.version || '—'], ['数据库', data.backend === 'couchdb' ? 'CouchDB' : data.backend], ['同步协议', String(data.protocol)], ['运行时间', uptime(data.uptimeSeconds)], ['服务标识', data.serverId]])); info.body.append(body);
    const access = this.card('管理员访问'), accessBody = el('div', 'card-body');
    append(accessBody, el('p', 'section-note', '管理台只使用一个管理员密码。登录会话保存在当前浏览器，退出后需要重新输入密码。'), append(el('div', 'notice'), icon('shield'), el('span', '', '管理员密码由服务端配置。更换密码后重建网关容器，浏览器需重新登录。')),
      el('div', 'divider'), button('退出当前会话', () => void this.logout(), '', 'logout'));
    access.body.append(accessBody); append(grid, info.card, access.card); this.content!.append(grid);
    const foot = el('p', 'footnote', '排除规则和设备授权在各仓库中管理。备份应覆盖数据库、网关状态和部署配置，保留原始身份信息。'); this.content!.append(foot);
  }

  private openDialog(title: string, description = '', wide = false) {
    this.closeDialog(); const dialog = el('dialog', wide ? 'wide' : ''), header = el('div', 'dialog-header'), titles = el('div');
    const heading = el('h2', '', title); heading.id = 'dialog-heading'; dialog.setAttribute('aria-labelledby', heading.id); append(titles, heading); if (description) titles.append(el('p', '', description));
    const close = el('button', 'dialog-close'); close.type = 'button'; close.setAttribute('aria-label', '关闭对话框'); close.append(icon('close')); close.addEventListener('click', () => dialog.close());
    append(header, titles, close); const body = el('div', 'dialog-body'), actions = el('div', 'dialog-actions'); append(dialog, header, body, actions);
    dialog.addEventListener('close', () => { dialog.remove(); if (this.dialog === dialog) this.dialog = undefined; }); document.body.append(dialog); this.dialog = dialog; dialog.showModal(); return { dialog, body, actions };
  }
  private closeDialog() { if (this.dialog) { this.dialog.close(); this.dialog.remove(); this.dialog = undefined; } }
  private vaultNameDialog(vault?: VaultSummary) {
    const modal = this.openDialog(vault ? '重命名仓库' : '新建笔记仓库', vault ? '只更改显示名称，已有设备连接保持有效。' : '每个仓库都拥有独立的笔记、版本和设备授权。');
    const form = el('form'), label = el('label', 'field-label', '仓库名称'), input = el('input', 'input'); label.htmlFor = 'vault-name'; input.id = 'vault-name'; input.name = 'name'; input.required = true; input.maxLength = 100; input.value = vault?.name ?? ''; input.placeholder = '例如：个人笔记、工作资料';
    append(form, label, input, el('p', 'field-help', '最多 100 个字符。名称用于识别仓库，设备会通过独立连接码接入。')); modal.body.append(form);
    const submit = button(vault ? '保存名称' : '创建仓库', () => { if (!form.reportValidity()) return; void this.run(async () => {
      const name = input.value.trim(); if (!name) throw new Error('请输入仓库名称');
      const result = vault ? await this.api('/vaults/' + encodeURIComponent(vault.id), 'PATCH', { name }) : await this.api<{ vault: { id: string; name: string } }>('/vaults', 'POST', { name });
      modal.dialog.close(); await this.loadOverview(false); this.renderShell(); this.navigate('vaults', vault?.id ?? (result as { vault: { id: string } }).vault.id); toast(vault ? '仓库名称已更新' : '仓库已创建，现在可以连接设备');
    }, submit); }, 'primary');
    form.addEventListener('submit', e => { e.preventDefault(); submit.click(); }); append(modal.actions, button('取消', () => modal.dialog.close()), submit); input.focus(); input.select();
  }

  private async inviteDialog(vault: VaultSummary) {
    const modal = this.openDialog('连接新设备', vault.name + ' · 为每台设备单独生成邀请', true); modal.body.append(el('div', 'loading', '正在生成一次性连接信息…'));
    try {
      const invitation = await this.api<Invitation>('/vaults/' + encodeURIComponent(vault.id) + '/invites', 'POST', { server: location.origin });
      if (!modal.dialog.open) return;
      const tabs = el('div', 'invite-tabs'), code = el('pre', 'code-block'); code.tabIndex = 0; code.setAttribute('aria-label', '安装命令或连接码');
      const choices: ['windows' | 'mac' | 'code', string][] = [['windows', 'Windows'], ['mac', 'macOS'], ['code', '连接码']];
      let current: 'windows' | 'mac' | 'code' = /Mac/i.test(navigator.platform) ? 'mac' : 'windows';
      const value = () => current === 'windows' ? invitation.windowsCommand : current === 'mac' ? invitation.macCommand : invitation.connection;
      const hint = el('p', 'section-note');
      const update = () => {
        for (const b of Array.from(tabs.querySelectorAll<HTMLButtonElement>('button'))) { const selected = b.dataset.tab === current; b.classList.toggle('active', selected); b.setAttribute('aria-pressed', String(selected)); }
        code.textContent = value(); hint.textContent = current === 'code' ? '插件已安装时，打开插件设置并粘贴这段完整连接码。' : current === 'mac' ? '在要连接的 Mac 上打开“终端”，粘贴下面的整条命令。' : '在要连接的 Windows 电脑上打开 PowerShell，粘贴下面的整条命令。';
      };
      for (const [key, label] of choices) { const b = el('button', 'invite-tab', label); b.type = 'button'; b.dataset.tab = key; b.addEventListener('click', () => { current = key; update(); }); tabs.append(b); }
      const copyButton = button('复制', () => void this.run(() => copy(value()), copyButton), 'primary small', 'copy');
      const expiry = el('span', '', `有效期至 ${date(invitation.expires, true)}`), steps = el('ol', 'steps');
      for (const text of ['在 Obsidian 中创建或打开目标笔记库。', '运行命令并选择该笔记库；在第三方插件中启用 LAN Note Sync。', '查看首次同步预览，再确认开始。每个本地笔记库分别连接。']) steps.append(el('li', '', text));
      modal.body.replaceChildren(tabs, hint, code, append(el('div', 'invite-info'), expiry, copyButton), steps);
      const note = el('div', 'notice'); append(note, icon('clock'), el('span', '', '连接信息 10 分钟有效，限首次认领设备使用。新设备请重新生成，长期设备凭证不会显示在这里。')); modal.body.append(el('div', 'divider'), note);
      append(modal.actions, button('关闭', () => modal.dialog.close()), button('为另一台设备生成', () => void this.inviteDialog(vault), '', 'refresh')); update();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { this.closeDialog(); this.authenticated = false; this.csrf = ''; this.renderLogin(false, '登录已过期，请重新登录'); return; }
      if (modal.dialog.open) { modal.body.replaceChildren(this.empty('邀请生成失败', e instanceof Error ? e.message : '请重试', 'alert')); modal.actions.append(button('关闭', () => modal.dialog.close())); }
    }
  }

  private revokeDialog(device: DeviceInfo) {
    const modal = this.openDialog('撤销设备授权', device.name || '未命名设备');
    modal.body.append(el('p', 'dialog-description', '撤销后，这台设备将无法继续访问该仓库。它已经提交的笔记和历史会保留；重新接入需要生成新的连接码。'));
    const confirm = button('确认撤销', () => void this.run(async () => { await this.api('/devices/' + encodeURIComponent(device.id) + '/revoke', 'POST', {}); modal.dialog.close(); await this.loadOverview(); toast('设备授权已撤销'); }, confirm), 'danger'); append(modal.actions, button('取消', () => modal.dialog.close()), confirm);
  }
  private async logout(b?: HTMLButtonElement) {
    await this.run(async () => { await this.api('/logout', 'POST', {}); this.authenticated = false; this.csrf = ''; this.overview = undefined; this.closeDialog(); this.renderLogin(); toast('已退出管理台'); }, b);
  }
}

void new Manager().start();
export {};
