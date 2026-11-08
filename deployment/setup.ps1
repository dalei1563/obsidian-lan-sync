param(
  [string]$PackagePath = (Get-Location).Path,
  [string]$PublicUrl = 'http://127.0.0.1:27123',
  [switch]$ExposeLan,
  [string]$Name = 'My Notes'
)
$ErrorActionPreference = 'Stop'
$package = (Resolve-Path -LiteralPath $PackagePath).Path
if (-not (Test-Path -LiteralPath (Join-Path $package 'compose.yaml'))) { throw 'Run from the extracted server source package, or specify -PackagePath.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is not installed. Install and start Docker Desktop first.' }
docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop, then rerun this command.' }
docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required.' }
$url = [Uri]$PublicUrl
if ($url.Scheme -notin @('http','https') -or $url.UserInfo -or $url.Query -or $url.Fragment -or $url.AbsolutePath -ne '/') { throw 'PublicUrl must be the root HTTP(S) address that your devices can reach.' }
$environment = Join-Path $package '.env'
if (-not (Test-Path -LiteralPath $environment)) {
  $random = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($random) } finally { $rng.Dispose() }
  $password = ([BitConverter]::ToString($random)).Replace('-','').ToLowerInvariant()
  $listen = if ($ExposeLan) { '0.0.0.0' } else { '127.0.0.1' }
  @("COUCHDB_USER=lan_sync_admin", "COUCHDB_PASSWORD=$password", "SYNC_PUBLIC_URL=$($url.AbsoluteUri.TrimEnd('/'))", "SYNC_LISTEN_ADDRESS=$listen") | Set-Content -LiteralPath $environment -Encoding Ascii
} else { Write-Host 'Existing deployment configuration preserved.' }
$adminPassword = $null
if (-not (Select-String -LiteralPath $environment -Pattern '^SYNC_ADMIN_PASSWORD=.' -Quiet)) {
  $adminRandom = New-Object byte[] 16
  $adminRng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $adminRng.GetBytes($adminRandom) } finally { $adminRng.Dispose() }
  $adminPassword = ([BitConverter]::ToString($adminRandom)).Replace('-','').ToLowerInvariant()
  $configLines = @(Get-Content -LiteralPath $environment | Where-Object {$_ -notmatch '^SYNC_ADMIN_PASSWORD='})
  @($configLines + "SYNC_ADMIN_PASSWORD=$adminPassword") | Set-Content -LiteralPath $environment -Encoding Ascii
}
Push-Location -LiteralPath $package
try {
  docker compose up -d --build --wait --wait-timeout 180
  if ($LASTEXITCODE -ne 0) { throw 'Service startup failed. Configuration and data were preserved. Run docker compose logs --tail 50 to inspect.' }
  Write-Host 'Services are ready. Keep the Vault ID below for additional devices.'
  Write-Host ('Management page: ' + $url.AbsoluteUri.TrimEnd('/') + '/admin/')
  if ($adminPassword) { Write-Host ('Administrator password (save it): ' + $adminPassword) }
  docker compose exec -T sync node dist/server/cli.cjs invite --name $Name
  if ($LASTEXITCODE -ne 0) { throw 'Service started, but invite generation failed. Rerun docker compose exec -T sync node dist/server/cli.cjs invite.' }
} finally { Pop-Location }
