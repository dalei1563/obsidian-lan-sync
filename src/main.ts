import { FileSystemAdapter, Modal, Notice, Plugin, requestUrl, requireApiVersion, Setting } from 'obsidian';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { id, PROTOCOL, Revision } from '../shared/protocol';
import { DEFAULT_SETTINGS, LanSettings, LanSettingTab } from './settings';
import { DiskState } from './sync/disk-state';
import { Engine, newState } from './sync/engine';
import { ObsidianVault } from './sync/obsidian-vault';
import { normalizeServer, Remote, Transport } from './sync/remote';
import { Connection, decodeConnection } from '../shared/connection';
import { Enrollment } from './sync/enrollment';
import { normalizeExclusions } from '../shared/exclusions';
import { DeadlineError, SingleFlight, withDeadline } from './sync/async-flow';
import type { OverwriteMode } from './sync/overwrite-plan';
import { updatePlugin } from './sync/updater';

export default class LanSyncPlugin extends Plugin {
  settings: LanSettings = { ...DEFAULT_SETTINGS, excludedPaths: [] };
  engine?: Engine;
  disk?: DiskState;
  local?: ObsidianVault;
  status = '未配对';
  private bar!: HTMLElement;
  private debounce?: number;
  private failures = 0;
  private nextAttempt = 0;
  private working = false;
  private localGeneration = 0;
  private cleanGeneration = -1;
  private lastFullScan = 0;
  private disposed = false;
  private settingsTab?: LanSettingTab;
  private readonly connectionFlow = new SingleFlight();
  private readonly previewFlow = new SingleFlight();
  private readonly updateFlow = new SingleFlight();
  private previewDialog?: Modal;
  private readonly workflowDialogs = new Set<Modal>();
  get connecting(): boolean { return this.connectionFlow.busy; }
  get previewing(): boolean { return this.previewFlow.busy; }
  get unloaded(): boolean { return this.disposed; }
  readonly transport: Transport = async (url, method, headers, body) => {
    try {
      this.ensureActive();
      const response = await withDeadline(requestUrl({ url, method, headers, body: body ? Uint8Array.from(body).buffer : undefined, throw: false }), 20000, '同步服务响应超时，请检查网络后重试；本地笔记与连接信息已保留');
      this.ensureActive();
      return { status: response.status, body: Buffer.from(response.arrayBuffer) };
    } catch (e) {
      if (e instanceof DeadlineError || this.disposed) throw e;
      throw new Error('无法连接同步服务，请检查网络、地址和证书；本地修改仍保留');
    }
  };
  async onload(): Promise<void> {
    const raw = (await this.loadData()) ?? {};
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof LanSettings)[]) {
      if (key === 'excludedPaths') { this.settings.excludedPaths = normalizeExclusions(raw.excludedPaths ?? []); continue; }
      if (typeof raw[key] === typeof DEFAULT_SETTINGS[key]) (this.settings as any)[key] = raw[key];
    }
    if (!this.settings.secretId) this.settings.secretId = 'lan-sync-' + id();
    await this.saveSettings();
    this.bar = this.addStatusBarItem();
    this.bar.addClass('lan-sync-status'); this.bar.onclick = () => void this.action(() => this.showIssues());
    this.setStatus('未配对');
    this.settingsTab = new LanSettingTab(this.app, this); this.addSettingTab(this.settingsTab);
    this.registerObsidianProtocolHandler('lan-note-sync', params => { if (params.connection) void this.action(() => this.importConnection(params.connection)); });
    this.addRibbonIcon('refresh-cw', '局域网同步', () => void this.action(() => this.sync(true)));
    this.addCommand({ id: 'sync-now', name: '立即同步', callback: () => void this.action(() => this.sync(true)) });
    this.addCommand({ id: 'sync-issues', name: '查看冲突与待处理项', callback: () => void this.action(() => this.showIssues()) });
    this.addCommand({ id: 'sync-toggle', name: '暂停 / 恢复自动同步', callback: () => void this.action(async () => {
      this.settings.enabled = !this.settings.enabled; await this.saveSettings(); this.setStatus(this.settings.enabled ? '等待同步' : '自动同步已暂停');
      if (this.settings.enabled) await this.sync(true);
    }) });
    const changed = () => {
      if (!this.engine?.state.initialized || this.local?.applying || this.disposed) return;
      this.localGeneration++;
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
    this.registerInterval(window.setInterval(() => { if (this.settings.enabled && Date.now() >= this.nextAttempt) void this.sync(false, true); }, 5000));
    this.registerInterval(window.setInterval(() => { if (this.settings.autoUpdate && this.settings.vaultId) void this.checkUpdate(false).catch(() => {}); }, 6 * 60 * 60 * 1000));
    this.registerEvent(this.app.workspace.on('active-leaf-change', changed));
    this.app.workspace.onLayoutReady(() => { void this.action(async () => {
      if (!this.settings.vaultId) {
        const bootstrap = this.enrollment().bootstrap();
        if (bootstrap) { await this.importConnection(bootstrap); return; }
      }
      await this.setup();
      if (this.settings.enabled) await this.sync(false);
      if (this.settings.autoUpdate && this.settings.vaultId) void this.checkUpdate(false).catch(() => {});
    }); });
  }
  onunload(): void {
    this.disposed = true;
    for (const modal of this.workflowDialogs) modal.close();
    this.workflowDialogs.clear();
    if (this.debounce) window.clearTimeout(this.debounce);
    const disk = this.disk;
    void (this.engine?.stop() ?? Promise.resolve()).finally(() => disk?.close());
  }
  setStatus(message: string): void {
    if (this.disposed) return;
    this.status = message; this.bar?.setText('局域网同步：' + message); this.bar?.setAttribute('aria-label', '局域网同步：' + message);
    this.settingsTab?.updateStatus(message);
  }
  private ensureActive(): void { if (this.disposed) throw new Error('插件已卸载，请重新启用后重试'); }
  private refreshSettings(): void { if (!this.disposed) this.settingsTab?.refreshBinding(); }
  saveSettings(): Promise<void> { return this.saveData(this.settings); }
  checkUpdate(manual: boolean): Promise<void> {
    return this.updateFlow.run('plugin-update', async () => {
      this.ensureActive();
      if (!this.settings.vaultId) throw new Error('请先连接同步服务');
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) throw new Error('自动更新仅支持桌面端');
      const root = join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id);
      const result = await updatePlugin(normalizeServer(this.settings.server, this.settings.allowHttp), root, this.manifest.version, this.transport, requireApiVersion);
      this.ensureActive();
      if (result) new Notice(`插件 ${result} 已下载，重启 Obsidian 后生效。`, 10000);
      else if (manual) new Notice('插件已经是服务端提供的最新版本。');
    });
  }
  private enrollment(): Enrollment {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('此版本仅支持 Windows 和 macOS 桌面端');
    return new Enrollment(join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id));
  }
  importConnection(value: string): Promise<void> {
    let connection: Connection;
    try { this.ensureActive(); connection = decodeConnection(value); } catch (e) { return Promise.reject(e); }
    return this.connectionFlow.run(connection.server + '\n' + connection.code, () => this.connect(connection));
  }
  private async connect(connection: Connection): Promise<void> {
    this.ensureActive();
    if (this.settings.vaultId) throw new Error('这个 Vault 已经连接，请使用首次同步预览或立即同步；更换连接前需保留现有基线');
    const u = new URL(connection.server);
    const httpLan = u.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (httpLan) {
      let decide!: (accepted: boolean) => void;
      const decision = new Promise<boolean>(resolve => { decide = resolve; });
      const modal = new Modal(this.app); modal.titleEl.setText('确认内网测试连接');
      modal.contentEl.createEl('p', { text: `管理员提供的 ${u.host} 使用 HTTP，连接码与笔记会明文传输。请仅在可信内网测试时继续；正式使用请向管理员获取 HTTPS 连接码。` });
      modal.onClose = () => decide(false);
      new Setting(modal.contentEl).addButton(b => b.setButtonText('取消').onClick(() => modal.close())).addButton(b => b.setButtonText('继续内网测试').onClick(() => { decide(true); modal.close(); }));
      await this.openMainModal(modal);
      const accepted = await decision; this.ensureActive();
      if (!accepted) { this.setStatus('已取消连接，连接码已保留'); return; }
    }
    this.setStatus('正在配对…');
    await this.pair(connection.code, connection.server, httpLan); this.ensureActive();
    try { await this.preview(); }
    catch (e) { throw new Error('已配对，首次同步预览未完成：' + (e instanceof Error ? e.message : '请稍后重试') + '。请在设置中重试预览，无需重新输入连接码。'); }
  }
  private async focusMainWindow(): Promise<void> {
    this.ensureActive();
    // Obsidian 1.15 settings may live in a native popout. Modal.open() chooses
    // activeWindow after our network awaits, so close that popout before opening.
    const settings: unknown = (this.app as unknown as { setting?: unknown }).setting;
    if (settings && typeof settings === 'object' && 'isOpen' in settings && settings.isOpen === true && 'close' in settings && typeof settings.close === 'function') settings.close();
    const mainWindow = this.app.workspace.containerEl.ownerDocument.defaultView;
    if (!mainWindow || mainWindow.closed) throw new Error('Obsidian 主窗口不可用，请重新打开笔记库后重试');
    for (let attempt = 0; attempt < 20; attempt++) {
      mainWindow.focus();
      await new Promise<void>(resolve => window.setTimeout(resolve, 25));
      this.ensureActive();
      if (!mainWindow.closed && activeWindow === mainWindow) return;
    }
    throw new Error('请切回 Obsidian 主窗口，然后重新打开设置重试；当前绑定已保留');
  }
  private async openMainModal(modal: Modal): Promise<void> {
    await this.focusMainWindow(); this.ensureActive();
    const onClose = modal.onClose.bind(modal);
    modal.onClose = () => { this.workflowDialogs.delete(modal); onClose(); };
    this.workflowDialogs.add(modal); modal.open();
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
    try { await fn(); } catch (e) { if (this.disposed) return; const message = e instanceof Error ? e.message : '操作失败'; this.setStatus(message); new Notice(message, 8000); }
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
      this.engine = new Engine(new Remote(url, this.settings.vaultId, token, this.transport), this.local, state, s => this.disk!.save(s), m => this.setStatus(m), { excludedPaths: () => this.settings.excludedPaths, configDir: this.app.vault.configDir });
      this.setStatus(state.overwrite ? '覆盖尚未完成，请在设置中重新预览' : !state.initialized ? '已配对，等待首次同步预览' : this.settings.enabled ? '等待同步' : '自动同步已暂停');
    } catch (e) { this.disk.close(); this.disk = undefined; throw e; }
  }
  async pair(code: string, server = this.settings.server, allowHttp = this.settings.allowHttp): Promise<void> {
    this.ensureActive();
    if (this.settings.vaultId) throw new Error('此 Vault 已绑定；重新安装或换设备前请先保留同步基线与恢复快照');
    const url = normalizeServer(server, allowHttp);
    const claim = this.enrollment().claim(url, code.trim());
    const result = await Remote.pair(url, code.trim(), hostname(), this.transport, claim);
    this.ensureActive();
    if (this.settings.vaultId) throw new Error('此 Vault 已保存另一份绑定，已停止重复配对');
    const previous = { ...this.settings };
    this.app.secretStorage.setSecret(this.settings.secretId, result.token);
    Object.assign(this.settings, { server: url, allowHttp, vaultId: result.vaultId, vaultName: result.vaultName, deviceId: result.deviceId, serverId: result.serverId, enabled: false });
    try { await this.saveSettings(); } catch (e) { Object.assign(this.settings, previous); throw e; }
    this.ensureActive(); this.refreshSettings();
    await this.setup(); this.ensureActive();
    this.enrollment().complete();
    new Notice('配对成功。先预览首次同步，再确认开始。');
  }
  preview(): Promise<void> {
    const result = this.previewFlow.run('first-sync', () => this.runPreview());
    void result.then(() => this.refreshSettings(), () => this.refreshSettings());
    return result;
  }
  private async runPreview(): Promise<void> {
    this.ensureActive();
    if (this.previewDialog) { await this.focusMainWindow(); return; }
    this.refreshSettings(); this.setStatus('正在生成首次同步预览…');
    await this.setup();
    this.ensureActive();
    if (!this.engine) throw new Error('请先输入配对码连接服务');
    const modal = new Modal(this.app); modal.titleEl.setText('选择覆盖方向');
    modal.onClose = () => { this.previewDialog = undefined; if (!this.engine?.state.initialized && !this.disposed) this.setStatus('已配对，首次同步尚未开始'); };
    modal.contentEl.createEl('p', { text: '请选择以哪一端为准。下一步会列出具体变化，确认之前不会修改笔记。只处理未排除的 Markdown 文件。' });
    if (this.engine.state.overwrite) modal.contentEl.createEl('p', { text: '上次覆盖未完成；请重新预览原方向，然后确认继续。' });
    const choose = (mode: OverwriteMode) => { modal.close(); void this.action(() => this.previewDirection(mode)); };
    new Setting(modal.contentEl).setName('云端覆盖本地').setDesc('本地会变成云端的样子，本地独有的笔记会被删除。请提前自行备份。').addButton(b => b.setButtonText('预览云端覆盖').onClick(() => choose('cloud-to-local')));
    new Setting(modal.contentEl).setName('本地覆盖云端').setDesc('云端会变成本地的样子，云端独有的笔记会被删除；旧版本保留在后台。').addButton(b => b.setButtonText('预览本地覆盖').onClick(() => choose('local-to-cloud')));
    this.previewDialog = modal;
    try { await this.openMainModal(modal); } catch (e) { this.previewDialog = undefined; throw e; }
  }
  private async previewDirection(mode: OverwriteMode): Promise<void> {
    const engine = this.engine; if (!engine) throw new Error('请先连接同步服务');
    this.setStatus('正在比较本地与云端…');
    const plan = await engine.previewOverwrite(mode); this.ensureActive();
    const modal = new Modal(this.app); modal.titleEl.setText(mode === 'cloud-to-local' ? '确认云端覆盖本地' : '确认本地覆盖云端');
    modal.contentEl.addClass('lan-sync-modal');
    modal.contentEl.createEl('p', { text: `本地 ${plan.local} 篇，云端 ${plan.cloud} 篇，相同 ${plan.unchanged} 篇；将执行 ${plan.actions.length} 项变化。` });
    const labels = { upload: '上传 / 覆盖云端', download: '下载 / 覆盖本地', 'delete-local': '删除本地', 'delete-cloud': '删除云端' };
    modal.contentEl.createEl('pre', { text: plan.actions.map(a => `${labels[a.type]}：${a.path}`).join('\n') || '两端已经一致。' });
    modal.contentEl.createEl('p', { text: mode === 'cloud-to-local' ? '本地独有笔记会被删除，同名笔记会被替换。请先自行备份整个本地笔记库。' : '云端删除和覆盖都会生成新版本，历史版本可在管理员后台查看和恢复。' });
    let backedUp = mode !== 'cloud-to-local';
    if (!backedUp) new Setting(modal.contentEl).setName('我已自行备份本地笔记库').addToggle(t => t.onChange(value => { backedUp = value; }));
    new Setting(modal.contentEl).addButton(b => b.setButtonText('取消').onClick(() => modal.close())).addButton(b => b.setButtonText('确认并开始覆盖').setWarning().onClick(() => {
      if (!backedUp) { new Notice('请先自行备份本地笔记库，并确认已备份。'); return; }
      b.setDisabled(true); void this.action(async () => {
        this.settings.enabled = false; await this.saveSettings();
        modal.close(); this.refreshSettings();
        await engine.startOverwrite(plan); this.ensureActive();
        this.settings.enabled = true; await this.saveSettings(); this.refreshSettings();
        new Notice('覆盖完成，自动同步已开启。');
      }).finally((): void => { if (!this.disposed) { b.setDisabled(false); this.refreshSettings(); } });
    }));
    await this.openMainModal(modal);
  }
  async sync(manual: boolean, periodic = false): Promise<void> {
    if (this.disposed || this.working) return;
    if (!this.engine && this.settings.vaultId) {
      try { await this.setup(); } catch (e) { this.setStatus(e instanceof Error ? e.message : '初始化失败'); if (manual) throw e; return; }
    }
    if (!this.engine?.state.initialized) { if (manual) throw new Error('请在设置中完成配对和首次同步预览'); return; }
    if (!manual && Date.now() < this.nextAttempt) return;
    this.working = true;
    try {
      const generation = this.localGeneration;
      const idle = periodic && generation === this.cleanGeneration && Date.now() - this.lastFullScan < 60000;
      await this.engine.sync(idle); this.failures = 0; this.nextAttempt = 0;
      if (!idle) { this.cleanGeneration = generation; this.lastFullScan = Date.now(); }
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
    if (!issues.length && !plan) {
      const held = state.pending.filter(p => engine.isExcluded(p.revision.path) || engine.isExcluded(state.entries[p.revision.fileId]?.path ?? p.revision.path)).length;
      modal.contentEl.createEl('p', { text: state.pending.length ? `待上传 ${state.pending.length - held} 项；${held} 项因排除规则暂停，原快照保留在本地。` : '当前没有冲突或待处理项。' });
    }
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
      b.setDisabled(true); void this.action(async () => { await this.engine!.resolve(fileId, choice); modal.close(); parent.close(); await this.sync(true); }).finally((): void => { if (!this.disposed) b.setDisabled(false); });
    })); modal.open();
  }
  private async previewRevision(parent: Modal, fileId: string, revision: Revision): Promise<void> {
    const data = revision.deleted ? null : await this.engine!.remote.get(revision.hash!);
    const modal = new Modal(this.app); modal.titleEl.setText(revision.deleted ? '删除版本' : revision.path); modal.contentEl.addClass('lan-sync-modal');
    modal.contentEl.createEl('pre', { text: data ? data.toString('utf8').slice(0, 12000) : '此版本表示删除；选择后文件会进入回收站。' });
    new Setting(modal.contentEl).addButton(b => b.setButtonText('选择这个版本').setCta().onClick(() => { modal.close(); this.confirmResolution(parent, fileId, revision, revision.id.slice(0, 8)); })); modal.open();
  }
}
