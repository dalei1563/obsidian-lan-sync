import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type LanSyncPlugin from './main';
import { normalizeExclusions } from '../shared/exclusions';
import type { StorageReport } from './sync/storage-report';

export interface LanSettings {
  server: string; allowHttp: boolean; enabled: boolean; vaultId: string;
  vaultName: string; deviceId: string; serverId: string; secretId: string;
  excludedPaths: string[]; autoUpdate: boolean;
  storageLimitMiB: number; storageSample: {at: number; report: StorageReport} | null;
}
export const DEFAULT_SETTINGS: LanSettings = {
  server: 'http://127.0.0.1:27123', allowHttp: false, enabled: false,
  vaultId: '', vaultName: '', deviceId: '', serverId: '', secretId: '',
  excludedPaths: [], autoUpdate: true, storageLimitMiB: 1024, storageSample: null,
};
export class LanSettingTab extends PluginSettingTab {
  private connectionDraft = '';
  private exclusionDraft?: string;
  private statusEl?: HTMLElement;
  constructor(app: App, readonly plugin: LanSyncPlugin) { super(app, plugin); }
  updateStatus(message: string): void { if (!this.plugin.unloaded) this.statusEl?.setText(message); }
  refreshBinding(): void { if (!this.plugin.unloaded && this.containerEl.isConnected) this.display(); }
  display(): void {
    if (this.plugin.unloaded) return;
    const { containerEl } = this, plugin = this.plugin; containerEl.empty(); containerEl.addClass('lan-sync-settings');
    containerEl.createEl('h2', { text: '自己的笔记同步' });
    containerEl.createEl('p', { text: '在 Windows 和 macOS 之间同步 Markdown 笔记。每个本地笔记库可独立连接自己的远端仓库，复制该仓库的连接码即可开始。' });
    const card = containerEl.createDiv('lan-sync-card'); this.statusEl = card.createEl('strong', { text: plugin.status });
    if (!plugin.settings.vaultId) {
      new Setting(containerEl).setName('连接码').setDesc('每台设备使用新的一次性连接码。多设备同步同一仓库时，请在后台的同一仓库分别生成新码。粘贴 lansync: 完整连接码；通过安装命令接入时会自动填写。').addTextArea(t => {
        t.setValue(this.connectionDraft).setPlaceholder('lansync:…').onChange(v => { this.connectionDraft = v; }); t.inputEl.rows = 3; t.inputEl.style.width = '100%'; t.inputEl.setAttribute('spellcheck', 'false');
      });
      new Setting(containerEl).addButton(b => b.setButtonText(plugin.connecting ? '正在连接…' : '连接并预览').setDisabled(plugin.connecting).setCta().onClick(() => {
        b.setDisabled(true); void plugin.action(() => plugin.importConnection(this.connectionDraft.trim())).finally((): void => { if (!plugin.unloaded) { b.setDisabled(false); this.refreshBinding(); } });
      }));
    } else {
      card.createEl('p', { text: `已连接：${plugin.settings.vaultName}` });
      new Setting(containerEl).setName(plugin.engine?.state.initialized ? '覆盖同步' : '首次同步').setDesc('选择云端或本地作为准，各项修改和删除会先显示供你确认。').addButton(b => b.setButtonText(plugin.previewing ? '正在获取预览…' : '选择并预览').setDisabled(plugin.previewing).setCta().onClick(() => {
        b.setDisabled(true); void plugin.action(() => plugin.preview()).finally((): void => { if (!plugin.unloaded) { b.setDisabled(false); this.refreshBinding(); } });
      }));
      new Setting(containerEl).setName('自动同步').setDesc('正常写作即可；断网后会在恢复连接时重试。').addToggle(t => t.setValue(plugin.settings.enabled).setDisabled(!plugin.engine?.state.initialized || !!plugin.engine?.state.overwrite).onChange(async enabled => {
        plugin.settings.enabled = enabled; await plugin.saveSettings(); plugin.setStatus(enabled ? '等待同步' : '自动同步已暂停'); if (enabled) await plugin.sync(true);
      }));
      new Setting(containerEl).addButton(b => b.setButtonText('立即同步').setCta().onClick(() => void plugin.action(() => plugin.sync(true)))).addButton(b => b.setButtonText('查看待处理项').onClick(() => void plugin.action(() => plugin.showIssues())));
      new Setting(containerEl).setName('插件自动更新').setDesc('从已连接的同步服务检查并下载新版，重启 Obsidian 后生效；笔记和连接配置会保留。').addToggle(t => t.setValue(plugin.settings.autoUpdate).onChange(async enabled => { plugin.settings.autoUpdate = enabled; await plugin.saveSettings(); }));
      new Setting(containerEl).addButton(b => b.setButtonText('检查插件更新').onClick(() => void plugin.action(() => plugin.checkUpdate(true))));
    }
    containerEl.createEl('h3', { text: '排除同步' });
    containerEl.createEl('p', { text: '.obsidian、当前配置目录和隐藏目录始终不参与同步。以下规则仅作用于当前本地笔记库，并与后台仓库规则合并。新增排除规则会暂停相关文件的上传、下载和删除；已同步内容会保留。' });
    if (this.exclusionDraft === undefined) this.exclusionDraft = plugin.settings.excludedPaths.join('\n');
    new Setting(containerEl).setName('本机额外排除规则').setDesc('每行一条，例如 private/、**/草稿/**、*.tmp.md；支持 *、? 和 **。').addTextArea(t => {
      t.setValue(this.exclusionDraft!).setPlaceholder('private/\n**/草稿/**\n*.tmp.md').onChange(v => { this.exclusionDraft = v; }); t.inputEl.rows = 4; t.inputEl.style.width = '100%'; t.inputEl.setAttribute('spellcheck', 'false');
    });
    new Setting(containerEl).addButton(b => b.setButtonText('保存排除规则').onClick(() => {
      b.setDisabled(true); void plugin.action(async () => {
        plugin.settings.excludedPaths = normalizeExclusions(this.exclusionDraft!.split(/\r?\n/)); await plugin.saveSettings(); this.exclusionDraft = plugin.settings.excludedPaths.join('\n');
        plugin.setStatus('排除规则已保存'); if (plugin.settings.enabled) await plugin.sync(true); this.display();
      }).finally((): void => { if (!plugin.unloaded) b.setDisabled(false); });
    }));
    const serverRules = plugin.engine?.state.serverExcludedPaths ?? [];
    if (serverRules.length) containerEl.createEl('p', { text: '后台仓库排除规则：' + serverRules.join('；') });
    const details = containerEl.createEl('details'); details.createEl('summary', { text: '连接诊断与恢复' });
    details.createEl('p', { text: '打开中的笔记会等待关闭后再接收远端替换。历史版本可在管理员后台查看和恢复。' });
    if (plugin.settings.vaultId) {
      details.createEl('p', { text: `服务：${plugin.settings.server}；设备：${plugin.settings.deviceId.slice(0, 8)}` });
      new Setting(details).addButton(b => b.setButtonText('检查连接').onClick(() => void plugin.action(async () => { await plugin.diagnose(); this.display(); })));
    }
    if (plugin.disk) details.createEl('code', { text: plugin.disk.directory + '/snapshots' });
    if (plugin.disk && plugin.engine) {
      let limit = String(plugin.settings.storageLimitMiB);
      new Setting(details).setName('容量告警阈值（MiB）').setDesc('任一统计项达到此值时提示；0 表示关闭告警，不会自动清理。').addTextArea(t => {
        t.setValue(limit).onChange(value => { limit = value; }); t.inputEl.rows = 1;
      });
      new Setting(details).addButton(b => b.setButtonText('保存阈值').onClick(() => void plugin.action(async () => {
        const value = Number(limit); if (!Number.isFinite(value) || value < 0 || value > 10000000) throw new Error('请输入有效的非负容量阈值');
        plugin.settings.storageLimitMiB = value; await plugin.saveSettings(); new Notice('容量告警阈值已保存');
      }))).addButton(b => b.setButtonText('查看容量').onClick(() => void plugin.action(() => plugin.showStorage())));
      new Setting(details).setName('清理本机恢复快照').setDesc('只清理本插件保存的恢复副本；预览和确认后永久删除，无法从本机恢复。').addButton(b => b.setButtonText('预览清理').onClick(() => void plugin.action(() => plugin.previewSnapshotCleanup())));
    }
    details.createEl('p', { text: '凭证保存在 Obsidian 密钥存储中。不要删除同步状态来修复连接，也不要同时对这个 Vault 启用其他同步插件。' });
  }
}
