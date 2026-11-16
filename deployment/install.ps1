param(
  [string]$VaultPath,
  [Parameter(Mandatory=$true)][string]$Connection,
  [switch]$Upgrade,
  [ValidateSet('Ask','Keep','Switch')][string]$ConnectionAction = 'Ask',
  [switch]$ConfirmSwitch,
  [string]$ConfigDir = '.obsidian'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Write-Host 'LAN Note Sync 安装助手'
Write-Host '正在检查笔记库和连接信息…'
if ([string]::IsNullOrWhiteSpace($VaultPath)) {
  $registered = @()
  $registryFile = Join-Path $env:APPDATA 'obsidian\obsidian.json'
  if (Test-Path -LiteralPath $registryFile) {
    try { $registry = Get-Content -Raw -Encoding UTF8 -LiteralPath $registryFile | ConvertFrom-Json; $registered = @($registry.vaults.PSObject.Properties | ForEach-Object {$_.Value.path} | Where-Object {$_ -and (Test-Path -LiteralPath $_ -PathType Container)} | Sort-Object -Unique) } catch { $registered = @() }
  }
  if ($registered.Count -eq 1) { $VaultPath = $registered[0] }
  else {
    Add-Type -AssemblyName System.Windows.Forms
    $picker = New-Object Windows.Forms.FolderBrowserDialog
    $picker.Description = '请选择要安装或更新插件的 Obsidian 笔记库'; $picker.ShowNewFolderButton = $false
    try { if ($picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { throw '已取消安装，原有文件未修改。' }; $VaultPath = $picker.SelectedPath } finally { $picker.Dispose() }
  }
}
function Get-InstallHash([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
if (-not $Connection.StartsWith('lansync:') -or $Connection.Length -gt 4096) { throw '连接码不完整，请从管理后台重新复制整条安装命令。' }
$encoded = $Connection.Substring(8).Replace('-','+').Replace('_','/')
$encoded = $encoded.PadRight($encoded.Length + (4 - $encoded.Length % 4) % 4, '=')
try { $connect = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json } catch { throw '连接码无法解析，请从管理后台重新复制完整命令。' }
$server = [Uri]$connect.server
if ($connect.protocol -ne 3 -or $connect.code -notmatch '^[a-f0-9]{24}$' -or $server.Scheme -notin @('http','https') -or $server.UserInfo -or $server.Query -or $server.Fragment -or $server.AbsolutePath -ne '/') { throw '连接码无效，请从管理后台重新生成安装命令。' }
if ($ConfigDir -notmatch '^\.[a-zA-Z0-9_-]+$') { throw 'Obsidian 配置目录无效，请检查目录名称。' }
if (-not (Test-Path -LiteralPath $VaultPath -PathType Container)) { throw '找不到笔记库文件夹，请先在 Obsidian 中创建或打开笔记库。' }
$vault = (Resolve-Path -LiteralPath $VaultPath).Path
$base = Join-Path $vault $ConfigDir
if (-not (Test-Path -LiteralPath $base -PathType Container)) { throw '该文件夹尚未初始化，请先在 Obsidian 中打开它，再运行安装命令。' }
$plugins = Join-Path $base 'plugins'
$target = Join-Path $plugins 'lan-note-sync'
foreach ($candidate in @($vault,$base,$plugins,$target)) {
  if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '不支持通过快捷链接或目录联接安装，请选择笔记库的实际目录。' }
}
if (Test-Path -LiteralPath $target) {
  if (Get-Process -Name Obsidian -ErrorAction SilentlyContinue) { throw '请先完全退出 Obsidian，再重新运行安装命令。' }
}
# Decide before downloading or changing the existing installation.
$bound = $false
$reconnect = $false
$oldSettings = $null
$dataFile = Join-Path $target 'data.json'
if (Test-Path -LiteralPath $dataFile) {
  try { $oldSettings = Get-Content -Raw -Encoding UTF8 -LiteralPath $dataFile | ConvertFrom-Json } catch { throw '原连接配置无法读取，已停止安装。请先备份并检查 data.json，不会自动重置配置。' }
  $bound = -not [string]::IsNullOrWhiteSpace($oldSettings.vaultId)
}
$targetId = [string]$connect.vaultId
$targetName = '未提供仓库名称，请重新生成命令'
if ($targetId -and $connect.vaultLabel) {
  try { $targetName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($connect.vaultLabel)) } catch { throw '目标仓库信息无效，请重新生成安装命令。' }
}
Write-Host ('本地笔记库：' + $vault)
Write-Host ('本次目标仓库：' + $targetName + '  [' + $targetId + ']')
if ($bound -and -not $reconnect) {
  Write-Host ('当前连接：' + $oldSettings.vaultName + '  [' + $oldSettings.vaultId + ']')
  Write-Host ('当前服务：' + $oldSettings.server)
  $sameTarget = $targetId -and $oldSettings.vaultId -eq $targetId -and ([string]$oldSettings.server).TrimEnd('/') -eq $server.AbsoluteUri.TrimEnd('/')
  if ($sameTarget -and $ConnectionAction -eq 'Ask') {
    $ConnectionAction = 'Keep'
    Write-Host '已连接到本次目标仓库，将仅更新插件。'
  }
  if ($ConnectionAction -eq 'Ask') {
    Write-Host '检测到已有连接，请选择：'
    Write-Host '  1. 仅更新插件，保留原连接（不会连接本次新仓库）'
    Write-Host '  2. 切换到本次目标仓库，备份原配置和同步基线'
    Write-Host '  0. 取消，不修改任何文件'
    $choice = Read-Host '请输入 1、2 或 0'
    if ($choice -eq '1') { $ConnectionAction = 'Keep' }
    elseif ($choice -eq '2') { $ConnectionAction = 'Switch' }
    else { throw '已取消安装，原有文件未修改。' }
  }
  if ($ConnectionAction -eq 'Switch') {
    if ($targetId -notmatch '^[a-f0-9-]{36}$') { throw '这条旧命令没有目标仓库信息，请从后台重新生成命令后切换。' }
    Write-Host '切换将保留本地笔记，并备份原连接和同步基线。新仓库需要重新配对、预览和确认，不会立即同步。'
    if (-not $ConfirmSwitch -and (Read-Host '确认切换请输入：切换') -cne '切换') { throw '已取消切换，原有文件未修改。' }
    $reconnect = $true
  }
}
Add-Type -AssemblyName System.Net.Http
$handler = New-Object Net.Http.HttpClientHandler
if ($server.Host -match '^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[?::1\]?$|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$)') { $handler.UseProxy = $false }
$http = New-Object Net.Http.HttpClient($handler)
$http.Timeout = [TimeSpan]::FromSeconds(30)
Write-Host '正在获取服务端版本…'
try { $manifest = $http.GetStringAsync($server.AbsoluteUri.TrimEnd('/') + '/install/manifest').GetAwaiter().GetResult() | ConvertFrom-Json } catch { throw '无法获取服务端插件信息，请检查网络和服务地址后重试。' }
if ($manifest.id -ne 'lan-note-sync' -or @($manifest.files).Count -ne 3) { throw '服务端插件信息异常，请联系管理员检查发布文件。' }
$names = @('manifest.json','main.js','styles.css')
if (@($manifest.files | ForEach-Object {$_.name} | Sort-Object -Unique).Count -ne 3) { throw '服务端插件文件列表重复，请联系管理员检查发布文件。' }
New-Item -ItemType Directory -Force -Path $plugins | Out-Null
$stage = Join-Path $plugins ('.lan-note-sync-stage-' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $stage | Out-Null
Write-Host '正在下载并校验插件文件…'
foreach ($asset in $manifest.files) {
  if ($asset.name -notin $names -or $asset.sha256 -notmatch '^[a-f0-9]{64}$' -or $asset.size -lt 0 -or $asset.size -gt 10485760) { throw '服务端插件文件信息无效，请联系管理员检查发布文件。' }
  $file = Join-Path $stage $asset.name
  try {[IO.File]::WriteAllBytes($file, $http.GetByteArrayAsync($server.AbsoluteUri.TrimEnd('/') + '/install/files/' + $asset.name).GetAwaiter().GetResult()) } catch { throw ('插件文件下载失败：' + $asset.name + '。请检查网络后重试，原有安装未修改。') }
  if ((Get-Item -LiteralPath $file).Length -ne $asset.size -or (Get-InstallHash $file) -ne $asset.sha256) { throw '插件下载校验失败，原有安装未修改，请检查网络后重试。' }
}
$pluginManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $stage 'manifest.json') | ConvertFrom-Json
if ($pluginManifest.id -ne 'lan-note-sync' -or $pluginManifest.version -ne $manifest.version) { throw '下载的插件名称或版本不匹配，已停止安装，请联系管理员。' }
if (Test-Path -LiteralPath $target) {
  if (-not $reconnect) {
    foreach ($item in Get-ChildItem -Force -LiteralPath $target) { if ($item.Name -notin $names) { Copy-Item -LiteralPath $item.FullName -Destination $stage -Recurse -Force } }
  }
  if (-not $bound -or $reconnect) { @{schema=1;connection=$Connection} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'bootstrap.json') -Encoding UTF8 }
  if ($reconnect) { [IO.File]::WriteAllText((Join-Path $stage 'data.json'), '{"enabled":false}', (New-Object Text.UTF8Encoding($false))) }
  $backupRoot = Join-Path $base 'lan-note-sync-backups'
  if ((Test-Path -LiteralPath $backupRoot) -and ((Get-Item -LiteralPath $backupRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '备份目录不能是符号链接，请使用实际目录。' }
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $backup = Join-Path $backupRoot ('lan-note-sync-' + [Guid]::NewGuid().ToString())
  $resolvedTarget = [IO.Path]::GetFullPath($target)
  $resolvedStage = [IO.Path]::GetFullPath($stage)
  if (-not $resolvedTarget.StartsWith([IO.Path]::GetFullPath($plugins) + [IO.Path]::DirectorySeparatorChar) -or -not $resolvedStage.StartsWith([IO.Path]::GetFullPath($plugins) + [IO.Path]::DirectorySeparatorChar)) { throw '安装目录校验未通过，已停止操作，请重新选择笔记库。' }
  Move-Item -LiteralPath $target -Destination $backup
  try { Move-Item -LiteralPath $stage -Destination $target } catch { Move-Item -LiteralPath $backup -Destination $target; throw }
  Write-Host ('插件已更新，原版本备份位于：' + $backup)
} else {
  @{schema=1;connection=$Connection} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'bootstrap.json') -Encoding UTF8
  Move-Item -LiteralPath $stage -Destination $target
}
Write-Host ''
Write-Host ('安装完成：LAN Note Sync ' + $manifest.version) -ForegroundColor Green
Write-Host ('笔记库位置：' + $vault)
if ($bound -and -not $reconnect) {
  Write-Host ('仅更新完成，仍连接原仓库：' + $oldSettings.vaultName)
  Write-Host '原有连接配置和同步状态已保留。本次命令的新连接码未使用。'
} else {
  if ($reconnect) { Write-Host '已准备切换仓库，原连接与同步基线已备份。' }
  Write-Host '连接配置已写入，尚未完成设备连接。接下来：'
  Write-Host '  1. 打开上述笔记库，进入「设置 → 第三方插件」。'
  Write-Host '  2. 启用 LAN Note Sync，按提示完成连接。'
  Write-Host '  3. 检查并确认首次同步预览，再开始同步。'
  Write-Host '首次连接请在邀请有效期内完成；若已过期，请重新生成命令。'
}
Write-Host '笔记内容和其他插件未修改。现在可以关闭此窗口。'
$http.Dispose()
