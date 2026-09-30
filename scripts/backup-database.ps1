param(
  [string]$Destination = (Join-Path $PSScriptRoot '..\backups'),
  [ValidateRange(1,365)][int]$RetentionDays = 14
)
$ErrorActionPreference = 'Stop'
$resolvedRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedDestination = [IO.Path]::GetFullPath($Destination)
if (-not $resolvedDestination.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup destination must remain inside the repository workspace.' }
New-Item -ItemType Directory -Force -Path $resolvedDestination | Out-Null
$statusFile = Join-Path $resolvedDestination 'status.json'

# status.json feeds the Owner/Admin "Backup status" page. It holds times and file names only, never credentials.
function Write-Status([string]$Result, [string]$File, [string]$Detail) {
  $now = (Get-Date).ToUniversalTime().ToString('o')
  $payload = [ordered]@{ lastAttemptAt = $now; result = $Result; file = $File; detail = $Detail }
  if ($Result -eq 'SUCCESS') { $payload['lastSuccessAt'] = $now }
  elseif (Test-Path $statusFile) {
    $previous = Get-Content -Raw $statusFile | ConvertFrom-Json
    if ($previous.lastSuccessAt) { $payload['lastSuccessAt'] = $previous.lastSuccessAt }
  }
  $payload | ConvertTo-Json | Set-Content -Path $statusFile -Encoding utf8
}

try {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $containerFile = "/tmp/rjpos-$stamp.dump"
  $backupFile = Join-Path $resolvedDestination "rjpos-$stamp.dump"
  docker compose -f (Join-Path $resolvedRoot 'docker\docker-compose.yml') exec -T postgres pg_dump -U rjpos -d rjpos --format=custom --no-owner --no-acl --file=$containerFile
  if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed.' }
  docker compose -f (Join-Path $resolvedRoot 'docker\docker-compose.yml') cp "postgres:$containerFile" $backupFile
  if ($LASTEXITCODE -ne 0) { throw 'Copying the backup failed.' }
  docker compose -f (Join-Path $resolvedRoot 'docker\docker-compose.yml') exec -T postgres rm -f $containerFile
  Get-ChildItem -LiteralPath $resolvedDestination -Filter 'rjpos-*.dump' -File | Where-Object LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) | Remove-Item -Force
  Write-Status 'SUCCESS' (Split-Path $backupFile -Leaf) 'Backup completed.'
  Write-Output $backupFile
} catch {
  Write-Status 'FAILURE' '' $_.Exception.Message
  throw
}
