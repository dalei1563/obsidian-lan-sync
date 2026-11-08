import { App, PluginSettingTab, Setting } from 'obsidian';
import type LanSyncPlugin from './main';

export interface LanSettings {
  server: string; allowHttp: boolean; enabled: boolean; vaultId: string;
  vaultName: string; deviceId: string; serverId: string; secretId: string;
}
export const DEFAULT_SETTINGS: LanSettings = {
  server: 'http://127.0.0.1:27123', allowHttp: false, enabled: false,
  vaultId: '', vaultName: '', deviceId: '', serverId: '', secretId: '',
};
export class LanSettingTab extends PluginSettingTab {
  constructor(app: App, readonly plugin: LanSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this, plugin = this.plugin; containerEl.empty(); containerEl.addClass('lan-sync-settings');
    containerEl.createEl('h2', { text: '自己的笔记同步' });
    containerEl.createEl('p', { text: '在 Windows 和 macOS 之间同步 Markdown 笔记。复制完整连接码即可开始，数据库参数由服务端管理。' });
    const card = containerEl.createDiv('lan-sync-card'); card.createEl('strong', { text: plugin.status });
    if (!plugin.settings.vaultId) {
      let connection = '';
      new Setting(containerEl).setName('连接码').setDesc('粘贴管理员提供的 lansync: 完整连接码。通过安装命令接入时会自动填写。').addTextArea(t => {
        t.setPlaceholder('lansync:…').onChange(v => { connection = v.trim(); }); t.inputEl.rows = 3; t.inputEl.style.width = '100%'; t.inputEl.setAttribute('spellcheck', 'false');
      });
      new Setting(containerEl).addButton(b => b.setButtonText('连接并预览').setCta().onClick(() => {
        b.setDisabled(true); void plugin.action(async () => { await plugin.importConnection(connection); this.display(); }).finally(() => b.setDisabled(false));
      }));
    } else {
      card.createEl('p', { text: `已连接：${plugin.settings.vaultName}` });
      if (!plugin.engine?.state.initialized) new Setting(containerEl).setName('首次同步').setDesc('先确认要上传、下载的笔记，再开始。').addButton(b => b.setButtonText('预览首次同步').setCta().onClick(() => void plugin.action(() => plugin.preview())));
      new Setting(containerEl).setName('自动同步').setDesc('正常写作即可；断网后会在恢复连接时重试。').addToggle(t => t.setValue(plugin.settings.enabled).setDisabled(!plugin.engine?.state.initialized).onChange(async enabled => {
        plugin.settings.enabled = enabled; await plugin.saveSettings(); plugin.setStatus(enabled ? '等待同步' : '自动同步已暂停'); if (enabled) await plugin.sync(true);
      }));
      new Setting(containerEl).addButton(b => b.setButtonText('立即同步').setCta().onClick(() => void plugin.action(() => plugin.sync(true)))).addButton(b => b.setButtonText('查看待处理项').onClick(() => void plugin.action(() => plugin.showIssues())));
    }
    const details = containerEl.createEl('details'); details.createEl('summary', { text: '连接诊断与恢复' });
    details.createEl('p', { text: '打开中的笔记会等待关闭后再接收远端替换。查看旧版本：打开笔记，执行“查看当前笔记历史”命令。' });
    if (plugin.settings.vaultId) {
      details.createEl('p', { text: `服务：${plugin.settings.server}；设备：${plugin.settings.deviceId.slice(0, 8)}` });
      new Setting(details).addButton(b => b.setButtonText('检查连接').onClick(() => void plugin.action(async () => { await plugin.diagnose(); this.display(); })));
    }
    if (plugin.disk) details.createEl('code', { text: plugin.disk.directory + '/snapshots' });
    details.createEl('p', { text: '凭证保存在 Obsidian 密钥存储中。不要删除同步状态来修复连接，也不要同时对这个 Vault 启用其他同步插件。' });
  }
}
