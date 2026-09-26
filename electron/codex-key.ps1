$ErrorActionPreference = 'Stop'
$configPath = Join-Path $env:LOCALAPPDATA 'CodexCursorProxy\config.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($config.apiKey)) { exit 1 }
[Console]::Out.WriteLine($config.apiKey)
