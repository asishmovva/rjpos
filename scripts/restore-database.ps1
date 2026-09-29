param(
  [Parameter(Mandatory=$true)][string]$BackupPath,
  [string]$TargetDatabase = 'rjpos_restore_test'
)
$ErrorActionPreference = 'Stop'
if ($TargetDatabase -notmatch '^[a-z0-9_]+_restore_test$') { throw 'Restore is restricted to an explicitly designated *_restore_test database.' }
$resolvedRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedBackup = [IO.Path]::GetFullPath($BackupPath)
if (-not (Test-Path -LiteralPath $resolvedBackup -PathType Leaf)) { throw 'Backup file does not exist.' }
if (-not $resolvedBackup.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup file must be inside the repository workspace.' }
$compose = Join-Path $resolvedRoot 'docker\docker-compose.yml'
$containerFile = "/tmp/$([IO.Path]::GetFileName($resolvedBackup))"
docker compose -f $compose cp $resolvedBackup "postgres:$containerFile"
if ($LASTEXITCODE -ne 0) { throw 'Copying the backup into PostgreSQL failed.' }
docker compose -f $compose exec -T postgres dropdb -U rjpos --if-exists $TargetDatabase
docker compose -f $compose exec -T postgres createdb -U rjpos $TargetDatabase
docker compose -f $compose exec -T postgres pg_restore -U rjpos -d $TargetDatabase --no-owner --no-acl --exit-on-error $containerFile
if ($LASTEXITCODE -ne 0) { throw 'pg_restore failed.' }
docker compose -f $compose exec -T postgres psql -U rjpos -d $TargetDatabase -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) AS migration_count FROM "_prisma_migrations";'
docker compose -f $compose exec -T postgres rm -f $containerFile
Write-Output "Restore verified in isolated database: $TargetDatabase"
