param(
  [string]$Destination = (Join-Path $PSScriptRoot '..\backups'),
  [ValidateRange(1,365)][int]$RetentionDays = 14
)
$ErrorActionPreference = 'Stop'
$resolvedRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedDestination = [IO.Path]::GetFullPath($Destination)
if (-not $resolvedDestination.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup destination must remain inside the repository workspace.' }
New-Item -ItemType Directory -Force -Path $resolvedDestination | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$containerFile = "/tmp/rjpos-$stamp.dump"
$backupFile = Join-Path $resolvedDestination "rjpos-$stamp.dump"
docker compose -f (Join-Path $resolvedRoot 'docker\docker-compose.yml') exec -T postgres pg_dump -U rjpos -d rjpos --format=custom --no-owner --no-acl --file=$containerFile
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed.' }
docker compose -f (Join-Path $resolvedRoot 'docker\docker-compose.yml') cp "postgres:$containerFile" $backupFile
if ($LASTEXITCODE -ne 0) { throw 'Copying the backup failed.' }
docker compose -f (Join-Path $resolvedRoot 'docker\docker-compose.yml') exec -T postgres rm -f $containerFile
Get-ChildItem -LiteralPath $resolvedDestination -Filter 'rjpos-*.dump' -File | Where-Object LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) | Remove-Item -Force
Write-Output $backupFile
