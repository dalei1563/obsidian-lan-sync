# Development-only fallback for a Windows host with network access and an
# isolated WSL Docker daemon. Downloads verified public OCI layers; no install.
param([string]$Image='apache/couchdb',[string]$Tag='3.5.3',[string]$Output='.test-runtime/couchdb-image')
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$root=(Resolve-Path -LiteralPath $Output).Path
$token=(Invoke-RestMethod -Uri ('https://auth.docker.io/token?service=registry.docker.io&scope=repository:'+$Image+':pull') -TimeoutSec 30).token
$headers=@{Authorization='Bearer '+$token;Accept='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'}
$registry='https://registry-1.docker.io/v2/'+$Image
$manifest=Invoke-RestMethod -Uri ($registry+'/manifests/'+$Tag) -Headers $headers -TimeoutSec 30
if ($manifest.manifests) {
  $selected=@($manifest.manifests | Where-Object {$_.platform.os -eq 'linux' -and $_.platform.architecture -eq 'amd64'})[0]
  if (-not $selected) {throw 'No Linux amd64 manifest'}
  $manifest=Invoke-RestMethod -Uri ($registry+'/manifests/'+$selected.digest) -Headers $headers -TimeoutSec 30
}
$layers=@()
foreach ($blob in @($manifest.config)+@($manifest.layers)) {
  if ($blob.digest -notmatch '^sha256:([a-f0-9]{64})$') {throw 'Invalid OCI digest'}
  $digest=$Matches[1]; $download=Join-Path $root ($digest+'.blob')
  if ((Test-Path -LiteralPath $download) -and (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) { Move-Item -LiteralPath $download -Destination ($download+'.partial-'+[Guid]::NewGuid().ToString()) }
  if (-not (Test-Path -LiteralPath $download)) {
    for ($attempt=0;$attempt -lt 3;$attempt++) {
      try {Invoke-WebRequest -Uri ($registry+'/blobs/'+$blob.digest) -Headers @{Authorization='Bearer '+$token} -OutFile $download -TimeoutSec 240; break}
      catch {if ($attempt -eq 2) {throw}; Start-Sleep -Seconds 1}
    }
  }
  if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) {throw 'Layer digest mismatch'}
  if ($blob.digest -eq $manifest.config.digest) {
    $config=$digest+'.json'; Copy-Item -LiteralPath $download -Destination (Join-Path $root $config) -Force
  } else {
    $name=$digest+'.tar'; $layers+=$name
    if (-not (Test-Path -LiteralPath (Join-Path $root $name))) {
      $source=[IO.File]::OpenRead($download);$gzip=New-Object IO.Compression.GZipStream($source,[IO.Compression.CompressionMode]::Decompress);$target=[IO.File]::Create((Join-Path $root $name))
      try {$gzip.CopyTo($target)} finally {$target.Dispose();$gzip.Dispose();$source.Dispose()}
    }
  }
  Write-Host ('Verified '+$digest.Substring(0,12))
}
$archiveManifest=ConvertTo-Json -InputObject @(@{Config=$config;RepoTags=@($Image+':'+$Tag);Layers=$layers}) -Depth 8 -Compress
[IO.File]::WriteAllText((Join-Path $root 'manifest.json'),$archiveManifest,(New-Object Text.UTF8Encoding($false)))
$tarArgs=@('-cf',(Join-Path $root 'image.tar'),'-C',$root,'manifest.json',$config)+$layers
& tar @tarArgs
if ($LASTEXITCODE -ne 0) {throw 'Could not create Docker image archive'}
Write-Host ('Created verified test image archive: '+(Join-Path $root 'image.tar'))
