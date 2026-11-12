# Starts the discord-mcp fork using settings from the repo-root .env.
# Usage (from the repo root):  powershell -ExecutionPolicy Bypass -File scripts\run-discord-mcp.ps1
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { Write-Error "Missing $envFile"; exit 1 }

# Only pass discord-mcp its own settings, not the Anthropic or Supabase keys in the same file.
$allowed = @("SPRING_PROFILES_ACTIVE", "DISCORD_TOKEN", "DISCORD_GUILD_ID", "WHISPCORD_MCP_SECRET", "WHISPCORD_EVENTS_WEBHOOK_URL", "WHISPCORD_MESSAGE_CONTENT")
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$' -and $allowed -contains $Matches[1]) {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim(), "Process")
    }
}
if (-not $env:DISCORD_TOKEN) { Write-Error "DISCORD_TOKEN is empty in .env"; exit 1 }

$jar = Get-ChildItem (Join-Path $root "target") -Filter "discord-mcp-*.jar" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike "*.original" } | Select-Object -First 1
if (-not $jar) {
    Write-Host "Building discord-mcp..."
    Push-Location $root
    mvn -q package -DskipTests
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { exit $code }
    $jar = Get-ChildItem (Join-Path $root "target") -Filter "discord-mcp-*.jar" | Where-Object { $_.Name -notlike "*.original" } | Select-Object -First 1
}
# Separate log file so it doesn't clash with any other discord-mcp running from this folder.
if (-not $env:LOGGING_FILE_NAME) { $env:LOGGING_FILE_NAME = Join-Path $root "target\logs\whispcord-mcp.log" }
Write-Host "Starting $($jar.Name) on http://localhost:8085/mcp"
# Windows-ROOT: use the Windows certificate store for TLS (needed on machines with HTTPS inspection).
java "-Djavax.net.ssl.trustStoreType=Windows-ROOT" -jar $jar.FullName
