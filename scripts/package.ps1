param([string]$ProjectPath = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$version = (Get-Content -Raw -LiteralPath (Join-Path $project 'manifest.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package version.' }
foreach ($file in @('main.js','dist/server/cli.cjs','dist/distribution/plugin/main.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $project $file))) { throw 'Run npm run build before packaging.' }
}
$dist = Join-Path $project 'dist'
$stage = Join-Path $dist ('package-stage-' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $stage | Out-Null
$server = Join-Path $stage ('lan-note-sync-server-' + $version)
New-Item -ItemType Directory -Path $server | Out-Null
# Explicit source allowlist: never include local credentials, Vaults or runtime data.
foreach ($name in @('src','server','shared','admin','deployment','scripts','tests','.github')) {
  Copy-Item -LiteralPath (Join-Path $project $name) -Destination (Join-Path $server $name) -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $server 'docs') | Out-Null
foreach ($name in @('SERVER_QUICKSTART.md','COUCHDB_DESIGN.md','COUCHDB_TEST_REPORT.md','ONEPANEL_GHCR.md','TAILSCALE_TEST_REPORT.md','ADMIN_GUIDE.md','LAN_SYNC_DESIGN.md','LAN_SYNC_TEST_REPORT.md','screenshots')) {
  Copy-Item -LiteralPath (Join-Path $project ('docs/' + $name)) -Destination (Join-Path $server ('docs/' + $name)) -Recurse
}
foreach ($name in @('README.md','package.json','package-lock.json','tsconfig.json','esbuild.config.mjs','manifest.json','styles.css','Dockerfile','compose.yaml','compose.production.yaml','.dockerignore','.gitignore')) {
  Copy-Item -LiteralPath (Join-Path $project $name) -Destination (Join-Path $server $name)
}
New-Item -ItemType Directory -Path (Join-Path $server 'dist') | Out-Null
foreach ($name in @('server','distribution','admin')) { Copy-Item -LiteralPath (Join-Path $dist $name) -Destination (Join-Path $server ('dist/' + $name)) -Recurse }
$pluginZip = Join-Path $dist ('lan-note-sync-plugin-' + $version + '.zip')
$serverZip = Join-Path $dist ('lan-note-sync-server-' + $version + '.zip')
Compress-Archive -LiteralPath (Join-Path $dist 'plugin/lan-note-sync') -DestinationPath $pluginZip -Force
Compress-Archive -LiteralPath $server -DestinationPath $serverZip -Force
$lines = @($pluginZip,$serverZip) | ForEach-Object { (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant() + '  ' + (Split-Path -Leaf $_) }
$lines | Set-Content -LiteralPath (Join-Path $dist ('SHA256SUMS-' + $version + '.txt')) -Encoding Ascii
Write-Host ('Plugin: ' + $pluginZip)
Write-Host ('Server: ' + $serverZip)
Write-Host ('Reviewable staging directory retained: ' + $stage)
