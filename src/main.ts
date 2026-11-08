import { FileSystemAdapter, MarkdownView, Modal, Notice, Plugin, requestUrl, Setting } from 'obsidian';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { Cursor, id, PROTOCOL, Revision } from '../shared/protocol';
import { DEFAULT_SETTINGS, LanSettings, LanSettingTab } from './settings';
import { DiskState } from './sync/disk-state';
import { Engine, newState } from './sync/engine';
import { ObsidianVault } from './sync/obsidian-vault';
import { normalizeServer, Remote, Transport } from './sync/remote';
import { decodeConnection } from '../shared/connection';
import { Enrollment } from './sync/enrollment';

export default class LanSyncPlugin extends Plugin {
  settings: LanSettings = { ...DEFAULT_SETTINGS };
  engine?: Engine;
  disk?: DiskState;
  local?: ObsidianVault;
  status = '未配对';
  private bar!: HTMLElement;
  private debounce?: number;
  private failures = 0;
  private nextAttempt = 0;
  private working = false;
  private disposed = false;
  readonly transport: Transport = async (url, method, headers, body) => {
    try {
      const response = await requestUrl({ url, method, headers, body: body ? Uint8Array.from(body).buffer : undefined, throw: false });
      return { status: response.status, body: Buffer.from(response.arrayBuffer) };
    } catch { throw new Error('无法连接同步服务，请检查网络、地址和证书；本地修改仍保留'); }
  };
  async onload(): Promise<void> {
    const raw = (await this.loadData()) ?? {};
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof LanSettings)[]) {
      if (typeof raw[key] === typeof DEFAULT_SETTINGS[key]) (this.settings as any)[key] = raw[key];
    }
    if (!this.settings.secretId) this.settings.secretId = 'lan-sync-' + id();
    await this.saveSettings();
    this.bar = this.addStatusBarItem();
    this.bar.addClass('lan-sync-status'); this.bar.onclick = () => void this.action(() => this.showIssues());
    this.setStatus('未配对');
    this.addSettingTab(new LanSettingTab(this.app, this));
    this.registerObsidianProtocolHandler('lan-note-sync', params => { if (params.connection) void this.action(() => this.importConnection(params.connection)); });
    this.addRibbonIcon('refresh-cw', '局域网同步', () => void this.action(() => this.sync(true)));
    this.addCommand({ id: 'sync-now', name: '立即同步', callback: () => void this.action(() => this.sync(true)) });
    this.addCommand({ id: 'sync-issues', name: '查看冲突与待处理项', callback: () => void this.action(() => this.showIssues()) });
    this.addCommand({ id: 'sync-history', name: '查看当前笔记历史', callback: () => void this.action(() => this.showHistory()) });
    this.addCommand({ id: 'sync-toggle', name: '暂停 / 恢复自动同步', callback: () => void this.action(async () => {
      this.settings.enabled = !this.settings.enabled; await this.saveSettings(); this.setStatus(this.settings.enabled ? '等待同步' : '自动同步已暂停');
      if (this.settings.enabled) await this.sync(true);
    }) });
    const changed = () => {
      if (!this.engine?.state.initialized || this.local?.applying || this.disposed) return;
      this.setStatus(this.settings.enabled ? '等待同步' : '本地待检查（自动同步已暂停）');
      if (!this.settings.enabled) return;
      if (this.debounce) window.clearTimeout(this.debounce);
      this.debounce = window.setTimeout(() => { if (this.settings.enabled) void this.sync(false); }, 2000);
    };
    this.registerEvent(this.app.vault.on('create', changed));
    this.registerEvent(this.app.vault.on('modify', changed));
    this.registerEvent(this.app.vault.on('delete', changed));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.local?.applying || !this.engine?.state.initialized) return;
      void this.engine.noteRename(oldPath, file.path).then(changed).catch(() => this.setStatus('路径不受支持，请查看设置'));
    }));
    this.registerInterval(window.setInterval(() => { if (this.settings.enabled && Date.now() >= this.nextAttempt) void this.sync(false); }, 5000));
    this.registerEvent(this.app.workspace.on('active-leaf-change', changed));
    this.app.workspace.onLayoutReady(() => { void this.action(async () => {
      if (!this.settings.vaultId) {
        const bootstrap = this.enrollment().bootstrap();
        if (bootstrap) { await this.importConnection(bootstrap); return; }
      }
      await this.setup();
      if (this.settings.enabled) await this.sync(false);
    }); });
  }
  onunload(): void {
    this.disposed = true;
    if (this.debounce) window.clearTimeout(this.debounce);
    const disk = this.disk;
    void (this.engine?.stop() ?? Promise.resolve()).finally(() => disk?.close());
  }
  setStatus(message: string): void {
    if (this.disposed) return;
    this.status = message; this.bar?.setText('局域网同步：' + message); this.bar?.setAttribute('aria-label', '局域网同步：' + message);
  }
  saveSettings(): Promise<void> { return this.saveData(this.settings); }
  private enrollment(): Enrollment {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('此版本仅支持 Windows 和 macOS 桌面端');
    return new Enrollment(join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id));
  }
  async importConnection(value: string): Promise<void> {
    if (this.settings.vaultId) throw new Error('这个 Vault 已经连接，请使用立即同步；更换连接前需保留现有基线');
    const connection = decodeConnection(value);
    const u = new URL(connection.server);
    const httpLan = u.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (httpLan) {
      const accepted = await new Promise<boolean>(resolve => {
        const modal = new Modal(this.app); modal.titleEl.setText('确认内网测试连接');
        modal.contentEl.createEl('p', { text: `管理员提供的 ${u.host} 使用 HTTP，连接码与笔记会明文传输。请仅在可信内网测试时继续；正式使用请向管理员获取 HTTPS 连接码。` });
        modal.onClose = () => resolve(false);
        new Setting(modal.contentEl).addButton(b => b.setButtonText('取消').onClick(() => modal.close())).addButton(b => b.setButtonText('继续内网测试').onClick(() => { resolve(true); modal.close(); })); modal.open();
      });
      if (!accepted) return;
    }
    this.settings.server = connection.server; this.settings.allowHttp = httpLan;
    await this.pair(connection.code); await this.preview();
  }
  async diagnose(): Promise<void> {
    const url = normalizeServer(this.settings.server, this.settings.allowHttp);
    this.setStatus('正在检查连接…');
    const result = await this.transport(url + '/v1/health', 'GET', {});
    let health: any; try { health = JSON.parse(result.body.toString('utf8')); } catch { throw new Error('这个地址不是我们的同步服务，请重新导入连接码'); }
    if (result.status !== 200 || !health.ok) throw new Error(health?.message ?? '服务器尚未就绪，请联系管理员');
    if (health.protocol !== PROTOCOL) throw new Error('客户端与服务端版本不兼容，请向管理员获取更新包');
    this.setStatus('服务连接正常'); new Notice('同步服务与数据库连接正常。');
  }
  async action(fn: () => Promise<void>): Promise<void> {
    try { await fn(); } catch (e) { const message = e instanceof Error ? e.message : '操作失败'; this.setStatus(message); new Notice(message, 8000); }
  }
  async setup(): Promise<void> {
    if (this.engine || !this.settings.vaultId) return;
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('首版仅支持桌面端');
    const url = normalizeServer(this.settings.server, this.settings.allowHttp);
    const token = this.app.secretStorage.getSecret(this.settings.secretId);
    if (!token) throw new Error('设备凭证不可用，请检查 Obsidian 密钥存储；不要删除同步基线');
    this.disk = new DiskState(join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id, 'local-state'));
    try {
      const state = this.disk.load() ?? newState(this.settings.serverId, this.settings.vaultId, this.settings.deviceId);
      if (state.serverId !== this.settings.serverId || state.vaultId !== this.settings.vaultId || state.clientId !== this.settings.deviceId) throw new Error('绑定与本地基线不匹配，已停止同步');
      this.local = new ObsidianVault(this.app, this.disk);
      this.engine = new Engine(new Remote(url, this.settings.vaultId, token, this.transport), this.local, state, s => this.disk!.save(s), m => this.setStatus(m));
      this.setStatus(!state.initialized ? '已配对，等待首次同步预览' : this.settings.enabled ? '等待同步' : '自动同步已暂停');
    } catch (e) { this.disk.close(); this.disk = undefined; throw e; }
  }
  async pair(code: string): Promise<void> {
    if (this.settings.vaultId) throw new Error('此 Vault 已绑定；重新安装或换设备前请先保留同步基线与恢复快照');
    const url = normalizeServer(this.settings.server, this.settings.allowHttp);
    const claim = this.enrollment().claim(url, code.trim());
    const result = await Remote.pair(url, code.trim(), hostname(), this.transport, claim);
    this.app.secretStorage.setSecret(this.settings.secretId, result.token);
    Object.assign(this.settings, { server: url, vaultId: result.vaultId, vaultName: result.vaultName, deviceId: result.deviceId, serverId: result.serverId, enabled: false });
    await this.saveSettings(); await this.setup();
    this.enrollment().complete();
    new Notice('配对成功。先预览首次同步，再确认开始。');
  }
  async preview(): Promise<void> {
    await this.setup();
    if (!this.engine) throw new Error('请先输入配对码连接服务');
    if (this.engine.state.initialized) throw new Error('此 Vault 已初始化，请使用立即同步');
    const p = await this.engine.preview();
    const modal = new Modal(this.app); modal.titleEl.setText('首次同步预览');
    modal.contentEl.createEl('p', { text: `本地 ${p.local} 篇，远端 ${p.remote} 个逻辑文件。` });
    modal.contentEl.createEl('p', { text: `预计上传 ${p.upload} 篇、下载 ${p.download} 篇、相同 ${p.same} 篇、需选择版本 ${p.conflicts} 项。` });
    modal.contentEl.createEl('p', { text: '同名不同内容将保留双方并等待处理。首次绑定不会把缺少的文件视为删除。' });
    new Setting(modal.contentEl).addButton(b => b.setButtonText('取消').onClick(() => modal.close())).addButton(b => b.setButtonText('确认并开始同步').setCta().onClick(() => {
      b.setDisabled(true); void this.action(async () => {
        await this.engine!.initialize(); this.settings.enabled = true; await this.saveSettings(); modal.close(); await this.sync(true);
      }).finally(() => b.setDisabled(false));
    })); modal.open();
  }
  async sync(manual: boolean): Promise<void> {
    if (this.disposed || this.working) return;
    if (!this.engine && this.settings.vaultId) {
      try { await this.setup(); } catch (e) { this.setStatus(e instanceof Error ? e.message : '初始化失败'); if (manual) throw e; return; }
    }
    if (!this.engine?.state.initialized) { if (manual) throw new Error('请在设置中完成配对和首次同步预览'); return; }
    if (!manual && Date.now() < this.nextAttempt) return;
    this.working = true;
    try {
      await this.engine.sync(); this.failures = 0; this.nextAttempt = 0;
      if (manual) new Notice('局域网同步：' + this.status);
    } catch (e) {
      this.failures++; this.nextAttempt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(this.failures - 1, 4));
      const message = e instanceof Error ? e.message : '同步失败'; this.setStatus(message);
      if (manual) new Notice(message, 8000);
    } finally { this.working = false; }
  }
  async showIssues(): Promise<void> {
    if (!this.engine) { new Notice('请在设置中连接同步服务'); return; }
    const engine = this.engine, modal = new Modal(this.app); modal.titleEl.setText('同步待处理项'); modal.contentEl.addClass('lan-sync-modal');
    const state = engine.state;
    const plan = state.deletePlan;
    if (plan) {
      const section = modal.contentEl.createDiv('lan-sync-card');
      section.createEl('h3', { text: `${plan.direction === 'local' ? '上传' : '接收'}批量删除：${plan.paths.length} 篇` });
      section.createEl('pre', { text: plan.paths.join('\n') });
      new Setting(section).addButton(b => b.setButtonText('确认这批删除并同步').setWarning().onClick(() => {
        modal.close(); void this.action(async () => { await engine.approveDeletes(); await this.sync(true); });
      }));
    }
    const issues = Object.entries(state.issues).filter(([fileId]) => fileId !== '__deletes__');
    if (!issues.length && !plan) modal.contentEl.createEl('p', { text: state.pending.length ? `还有 ${state.pending.length} 项待上传。` : '当前没有冲突或待处理项。' });
    for (const [fileId, message] of issues) {
      const entry = state.entries[fileId], file = state.remote[fileId];
      const card = modal.contentEl.createDiv('lan-sync-card');
      card.createEl('h3', { text: entry?.path ?? file?.heads[0]?.path ?? fileId }); card.createEl('p', { text: message });
      if (!file) {
        if (entry && state.pending.some(p => p.revision.fileId === fileId)) {
          card.createEl('p', { text: '若为新文件重名，请先在 Obsidian 中改名，再点击重试。' });
          new Setting(card).addButton(b => b.setButtonText('重试改名后的新文件').onClick(() => {
            modal.close(); void this.action(async () => { await engine.retryRenamed(fileId); await this.sync(true); });
          }));
        }
        continue;
      }
      if (entry) new Setting(card).setName('使用本地当前内容').setDesc('提交为新的解决版本；本地缺失表示删除。').addButton(b => b.setButtonText('选择本地').onClick(() => this.confirmResolution(modal, fileId, 'local', '本地当前内容')));
      for (const head of file.heads) new Setting(card).setName(head.deleted ? '远端删除版本' : head.path).setDesc(`${head.id.slice(0, 8)} · ${head.size} 字节`).addButton(b => b.setButtonText('预览 / 选择').onClick(() => void this.action(() => this.previewRevision(modal, fileId, head))));
    }
    modal.contentEl.createEl('p', { text: '选择版本会保留已提交的历史；被替换的本地内容另存于插件 local-state/snapshots 恢复目录。打开中的笔记会等待关闭后再应用。' });
    modal.open();
  }
  private confirmResolution(parent: Modal, fileId: string, choice: 'local' | Revision, label: string): void {
    const modal = new Modal(this.app); modal.titleEl.setText('确认使用所选版本');
    modal.contentEl.createEl('p', { text: `将使用“${label}”创建新版本。原版本保留，可从历史恢复。` });
    new Setting(modal.contentEl).addButton(b => b.setButtonText('取消').onClick(() => modal.close())).addButton(b => b.setButtonText('确认选择').setCta().onClick(() => {
      b.setDisabled(true); void this.action(async () => { await this.engine!.resolve(fileId, choice); modal.close(); parent.close(); await this.sync(true); }).finally(() => b.setDisabled(false));
    })); modal.open();
  }
  private async previewRevision(parent: Modal, fileId: string, revision: Revision): Promise<void> {
    const data = revision.deleted ? null : await this.engine!.remote.get(revision.hash!);
    const modal = new Modal(this.app); modal.titleEl.setText(revision.deleted ? '删除版本' : revision.path); modal.contentEl.addClass('lan-sync-modal');
    modal.contentEl.createEl('pre', { text: data ? data.toString('utf8').slice(0, 12000) : '此版本表示删除；选择后文件会进入回收站。' });
    new Setting(modal.contentEl).addButton(b => b.setButtonText('选择这个版本').setCta().onClick(() => { modal.close(); this.confirmResolution(parent, fileId, revision, revision.id.slice(0, 8)); })); modal.open();
  }
  async showHistory(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const engine = this.engine;
    const entry = view?.file && engine ? Object.values(engine.state.entries).find(e => e.path === view.file!.path) : null;
    if (!engine || !entry) throw new Error('请先打开一篇已参与同步的笔记');
    const modal = new Modal(this.app); modal.titleEl.setText('历史版本：' + entry.path); modal.contentEl.addClass('lan-sync-modal');
    const list = modal.contentEl.createDiv(); let before: Cursor | undefined;
    const load = async () => {
      const history = await engine.remote.history(entry.fileId, before);
      for (const { seq, revision } of history) new Setting(list).setName(revision.deleted ? '删除版本' : revision.path).setDesc(`序号 ${seq} · ${revision.id.slice(0, 8)} · ${revision.size} 字节`).addButton(b => b.setButtonText('预览 / 恢复').onClick(() => void this.action(() => this.previewRevision(modal, entry.fileId, revision))));
      before = history[history.length - 1]?.seq;
      if (!history.length) list.createEl('p', { text: '没有更早的版本。' });
      return history.length;
    };
    await load();
    new Setting(modal.contentEl).addButton(b => b.setButtonText('加载更早的版本').onClick(() => { b.setDisabled(true); void this.action(async () => { if (before && await load()) b.setDisabled(false); }); })); modal.open();
  }
}
