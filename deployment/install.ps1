param(
  [string]$VaultPath,
  [Parameter(Mandatory=$true)][string]$Connection,
  [switch]$Upgrade,
  [string]$ConfigDir = '.obsidian'
)
$ErrorActionPreference = 'Stop'
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
    $picker.Description = 'Choose the Obsidian Vault to connect'; $picker.ShowNewFolderButton = $false
    try { if ($picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { throw 'Installation cancelled.' }; $VaultPath = $picker.SelectedPath } finally { $picker.Dispose() }
  }
}
function Get-InstallHash([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
if (-not $Connection.StartsWith('lansync:') -or $Connection.Length -gt 4096) { throw 'Use the full connection code from your administrator.' }
$encoded = $Connection.Substring(8).Replace('-','+').Replace('_','/')
$encoded = $encoded.PadRight($encoded.Length + (4 - $encoded.Length % 4) % 4, '=')
$connect = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
$server = [Uri]$connect.server
if ($connect.protocol -ne 2 -or $connect.code -notmatch '^[a-f0-9]{24}$' -or $server.Scheme -notin @('http','https') -or $server.UserInfo -or $server.Query -or $server.Fragment -or $server.AbsolutePath -ne '/') { throw 'Invalid connection code.' }
if ($ConfigDir -notmatch '^\.[a-zA-Z0-9_-]+$') { throw 'Invalid Obsidian configuration directory.' }
if (-not (Test-Path -LiteralPath $VaultPath -PathType Container)) { throw 'Vault folder does not exist. Create an empty Vault in Obsidian first.' }
$vault = (Resolve-Path -LiteralPath $VaultPath).Path
$base = Join-Path $vault $ConfigDir
if (-not (Test-Path -LiteralPath $base -PathType Container)) { throw 'This folder is not an initialized Obsidian Vault. Open it in Obsidian first.' }
$plugins = Join-Path $base 'plugins'
$target = Join-Path $plugins 'lan-note-sync'
foreach ($candidate in @($vault,$base,$plugins,$target)) {
  if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation through a symbolic link or junction is not supported.' }
}
if (Test-Path -LiteralPath $target) {
  if (Get-Process -Name Obsidian -ErrorAction SilentlyContinue) { throw 'Close Obsidian before upgrading the plugin.' }
}
Add-Type -AssemblyName System.Net.Http
$handler = New-Object Net.Http.HttpClientHandler
if ($server.Host -match '^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[?::1\]?$|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$)') { $handler.UseProxy = $false }
$http = New-Object Net.Http.HttpClient($handler)
$http.Timeout = [TimeSpan]::FromSeconds(30)
$manifest = $http.GetStringAsync($server.AbsoluteUri.TrimEnd('/') + '/install/manifest').GetAwaiter().GetResult() | ConvertFrom-Json
if ($manifest.id -ne 'lan-note-sync' -or @($manifest.files).Count -ne 3) { throw 'Unexpected plugin manifest.' }
$names = @('manifest.json','main.js','styles.css')
if (@($manifest.files | ForEach-Object {$_.name} | Sort-Object -Unique).Count -ne 3) { throw 'Duplicate plugin assets.' }
New-Item -ItemType Directory -Force -Path $plugins | Out-Null
$stage = Join-Path $plugins ('.lan-note-sync-stage-' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($asset in $manifest.files) {
  if ($asset.name -notin $names -or $asset.sha256 -notmatch '^[a-f0-9]{64}$' -or $asset.size -lt 0 -or $asset.size -gt 10485760) { throw 'Invalid plugin asset.' }
  $file = Join-Path $stage $asset.name
  [IO.File]::WriteAllBytes($file, $http.GetByteArrayAsync($server.AbsoluteUri.TrimEnd('/') + '/install/files/' + $asset.name).GetAwaiter().GetResult())
  if ((Get-Item -LiteralPath $file).Length -ne $asset.size -or (Get-InstallHash $file) -ne $asset.sha256) { throw 'Plugin download failed integrity verification. Existing installation was not changed.' }
}
$pluginManifest = Get-Content -Raw -LiteralPath (Join-Path $stage 'manifest.json') | ConvertFrom-Json
if ($pluginManifest.id -ne 'lan-note-sync' -or $pluginManifest.version -ne $manifest.version) { throw 'Downloaded plugin identity does not match.' }
if (Test-Path -LiteralPath $target) {
  foreach ($item in Get-ChildItem -Force -LiteralPath $target) { if ($item.Name -notin $names) { Copy-Item -LiteralPath $item.FullName -Destination $stage -Recurse -Force } }
  $dataFile = Join-Path $stage 'data.json'
  $bound = $false
  if (Test-Path -LiteralPath $dataFile) {
    $oldSettings = Get-Content -Raw -Encoding UTF8 -LiteralPath $dataFile | ConvertFrom-Json
    $bound = -not [string]::IsNullOrWhiteSpace($oldSettings.vaultId)
  }
  if (-not $bound) { @{schema=1;connection=$Connection} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'bootstrap.json') -Encoding UTF8 }
  $backupRoot = Join-Path $base 'lan-note-sync-backups'
  if ((Test-Path -LiteralPath $backupRoot) -and ((Get-Item -LiteralPath $backupRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Backup directory must not be a symbolic link.' }
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $backup = Join-Path $backupRoot ('lan-note-sync-' + [Guid]::NewGuid().ToString())
  $resolvedTarget = [IO.Path]::GetFullPath($target)
  $resolvedStage = [IO.Path]::GetFullPath($stage)
  if (-not $resolvedTarget.StartsWith([IO.Path]::GetFullPath($plugins) + [IO.Path]::DirectorySeparatorChar) -or -not $resolvedStage.StartsWith([IO.Path]::GetFullPath($plugins) + [IO.Path]::DirectorySeparatorChar)) { throw 'Unsafe installation target.' }
  Move-Item -LiteralPath $target -Destination $backup
  try { Move-Item -LiteralPath $stage -Destination $target } catch { Move-Item -LiteralPath $backup -Destination $target; throw }
  Write-Host ('Upgraded plugin. Previous installation retained at: ' + $backup)
} else {
  @{schema=1;connection=$Connection} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'bootstrap.json') -Encoding UTF8
  Move-Item -LiteralPath $stage -Destination $target
}
Write-Host ('Installed LAN Note Sync ' + $manifest.version + ' in: ' + $vault)
Write-Host 'Open this Vault in Obsidian, enable LAN Note Sync in Community plugins, and confirm the initial sync preview. Notes and other plugins were not modified.'
$http.Dispose()
