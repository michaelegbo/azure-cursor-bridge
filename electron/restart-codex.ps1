param([string]$StatusPath)
$ErrorActionPreference = 'Stop'
function Write-Status([string]$Message) {
  try { Set-Content -LiteralPath $StatusPath -Value $Message -Encoding UTF8 } catch {}
}
try {
  # Close any running Codex instance immediately. Codex persists its state
  # continuously, so a forced close is safe and keeps the restart instant.
  $processes = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)
  $exe = $processes | ForEach-Object { try { $_.Path } catch { $null } } | Where-Object { $_ -like '*OpenAI.Codex_*\app\ChatGPT.exe' } | Select-Object -First 1
  if ($processes) {
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(4)
    while ((Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 150 }
  }
  # Codex is an MSIX app: activate it through the shell so it keeps its package
  # identity (a direct exe launch can hide its signed-in state). The family
  # name is version-independent, so the direct AUMID is the fast path.
  $launched = $false
  try { Start-Process explorer.exe 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App'; $launched = $true } catch {}
  if (-not $launched) {
    try {
      $pkg = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop
      if ($pkg) { Start-Process explorer.exe "shell:AppsFolder\$($pkg.PackageFamilyName)!App"; $launched = $true }
    } catch {}
  }
  if (-not $launched -and $exe) { Start-Process -FilePath $exe; $launched = $true }
  if (-not $launched) { throw 'Could not launch the Codex desktop app.' }
  Write-Status 'Codex restarted'
} catch {
  Write-Status ('Codex restart failed: ' + $_.Exception.Message)
}
