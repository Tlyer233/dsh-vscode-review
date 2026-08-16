# dsh-vscode-review — one-click install for dsh + VSCode (Windows PowerShell)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host '=== [1/3] Install dsh-review ===' -ForegroundColor Cyan
& dsh plugin --profile web add (Join-Path $root 'packages\dsh-review')

Write-Host '=== [2/3] Install dsh-review-changes ===' -ForegroundColor Cyan
& dsh plugin --profile web add (Join-Path $root 'packages\dsh-review-changes')

Write-Host '=== [3/3] Install VSCode extension ===' -ForegroundColor Cyan
$vsix = Join-Path $root 'vscode_dsh_plugin\dsh-review-vscode-0.1.0.vsix'
if (Test-Path $vsix) {
  & code --install-extension $vsix --force
} else {
  Write-Host 'VSIX not found; copying dev source into ~/.vscode/extensions instead.' -ForegroundColor Yellow
  $dest = Join-Path $env:USERPROFILE '.vscode\extensions\dsn.dsh-review-vscode-0.1.0'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Recurse (Join-Path $root 'vscode_dsh_plugin\extension.js') $dest
  Copy-Item -Recurse (Join-Path $root 'vscode_dsh_plugin\package.json') $dest
  Copy-Item -Recurse (Join-Path $root 'vscode_dsh_plugin\lib') $dest
  Copy-Item -Recurse (Join-Path $root 'vscode_dsh_plugin\media') $dest
}

Write-Host '=== Done ===' -ForegroundColor Cyan
Write-Host '1. Restart dsh web.' -ForegroundColor Yellow
Write-Host '2. In VSCode run Developer: Reload Window.' -ForegroundColor Yellow
