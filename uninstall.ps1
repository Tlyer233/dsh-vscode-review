# Reverse install.ps1: drop dsh-review, VS Code extension, argv proposed-api, shadow store.
# Idempotent. Does not touch Cursor argv/extensions.
$ErrorActionPreference = 'Stop'

$ExtId = 'dsn.dsh-review-vscode'
$ExtObsolete = @('demo.my-vscode-plugin')
$VscodeExtDir = if ($env:VSCODE_EXTENSIONS_DIR) { $env:VSCODE_EXTENSIONS_DIR } else { Join-Path $env:USERPROFILE '.vscode\extensions' }

function Unmerge-ArgvJson {
  param([string]$File, [string]$Id, [string[]]$Obsolete)
  if (-not (Test-Path $File)) {
    Write-Host "no $File"
    return
  }
  $text = Get-Content -Raw -Encoding UTF8 $File
  $pattern = '"enable-proposed-api"\s*:\s*\[([^\]]*)\]'
  $match = [regex]::Match($text, $pattern)
  if (-not $match.Success) {
    Write-Host "already clean $File"
    return
  }
  $drop = @($Id) + $Obsolete
  $ids = @()
  foreach ($m in [regex]::Matches($match.Groups[1].Value, '"([^"]+)"')) {
    $item = $m.Groups[1].Value
    if ($drop -contains $item) { continue }
    if ($ids -notcontains $item) { $ids += $item }
  }
  $rendered = '[' + (($ids | ForEach-Object { '"' + $_ + '"' }) -join ', ') + ']'
  $newText = $text.Substring(0, $match.Groups[0].Index) + '"enable-proposed-api": ' + $rendered + $text.Substring($match.Groups[0].Index + $match.Groups[0].Length)
  if ($newText -eq $text) {
    Write-Host "already clean $File"
    return
  }
  Set-Content -Path $File -Encoding UTF8 -Value ($newText.TrimEnd() + "`n")
  Write-Host "updated $File"
}

function Purge-VscodeExtension {
  param([string]$ExtDir, [string]$Id, [string[]]$Obsolete)
  if (-not (Test-Path $ExtDir)) {
    New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null
  }
  $dropIds = @($Obsolete) + $Id
  $removed = @()
  Get-ChildItem -Path $ExtDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $name = $_.Name
    $drop = $false
    foreach ($did in $dropIds) {
      if ($name -eq $did -or $name.StartsWith("$did-")) { $drop = $true }
    }
    if ($drop) {
      Remove-Item -Recurse -Force $_.FullName
      $removed += $name
    }
  }
  $catalog = Join-Path $ExtDir 'extensions.json'
  $entries = @()
  if (Test-Path $catalog) {
    try {
      $raw = Get-Content -Raw -Encoding UTF8 $catalog | ConvertFrom-Json
      if ($raw -is [System.Array]) { $entries = @($raw) }
      elseif ($null -ne $raw) { $entries = @($raw) }
    } catch {
      $entries = @()
    }
  }
  $kept = @()
  foreach ($item in $entries) {
    $eid = $null
    try { $eid = $item.identifier.id } catch { $eid = $null }
    if ($dropIds -contains $eid) { continue }
    $path = $null
    try { $path = $item.location.path } catch { $path = $null }
    if ($path -and -not (Test-Path (Join-Path $path 'package.json'))) { continue }
    $kept += $item
  }
  ($kept | ConvertTo-Json -Depth 8 -Compress) + "`n" | Set-Content -Path $catalog -Encoding UTF8
  if ($removed.Count -gt 0) {
    Write-Host ("removed extension dirs: " + ($removed -join ', '))
  } else {
    Write-Host 'no extension dirs to remove'
  }
  Write-Host "synced $catalog"
}

Write-Host '=== [1/4] Remove dsh plugin (dsh-review) ===' -ForegroundColor Cyan
if (Get-Command dsh -ErrorAction SilentlyContinue) {
  & dsh plugin --profile web remove dsh-review
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'dsh plugin remove returned non-zero (may already be gone)' -ForegroundColor Yellow
  }
} else {
  Write-Host 'dsh not on PATH; skip plugin remove'
}
$cache = Join-Path $env:USERPROFILE '.dsh\profiles\web\.install-cache'
Get-ChildItem -Path $cache -Filter 'dsh-review-*.tgz' -ErrorAction SilentlyContinue | Remove-Item -Force
$nm = Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\dsh-review'
if (Test-Path $nm) { Remove-Item -Recurse -Force $nm }
Write-Host 'cleared install-cache tarballs and leftover node_modules\dsh-review'

Write-Host '=== [2/4] Remove VS Code extension ===' -ForegroundColor Cyan
if (Get-Command code -ErrorAction SilentlyContinue) {
  & code --uninstall-extension $ExtId 2>$null | Out-Null
  foreach ($oid in $ExtObsolete) {
    & code --uninstall-extension $oid 2>$null | Out-Null
  }
} else {
  Write-Host 'code not on PATH; deleting extension folders only'
}
Purge-VscodeExtension -ExtDir $VscodeExtDir -Id $ExtId -Obsolete $ExtObsolete

Write-Host '=== [3/4] Revert VS Code argv.json (enable-proposed-api) ===' -ForegroundColor Cyan
$appData = $env:APPDATA
if (-not $appData) { $appData = Join-Path $env:USERPROFILE 'AppData\Roaming' }
Unmerge-ArgvJson -File (Join-Path $appData 'Code\argv.json') -Id $ExtId -Obsolete $ExtObsolete
$insiders = Join-Path $appData 'Code - Insiders\argv.json'
if (Test-Path (Split-Path $insiders)) {
  Unmerge-ArgvJson -File $insiders -Id $ExtId -Obsolete $ExtObsolete
}

Write-Host '=== [4/4] Remove shadow store ===' -ForegroundColor Cyan
$dshHome = if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { $env:DSH_HOME.Trim() } else { Join-Path $env:USERPROFILE '.dsh' }
$shadow = Join-Path $dshHome 'review\shadow'
if (Test-Path $shadow) {
  Remove-Item -Recurse -Force $shadow
  Write-Host "removed $shadow"
} else {
  Write-Host "no $shadow"
}

Write-Host '=== Done ===' -ForegroundColor Cyan
Write-Host '1. Completely quit VS Code, then reopen.' -ForegroundColor Yellow
Write-Host '2. Restart dsh web if it is running.' -ForegroundColor Yellow
Write-Host 'Cursor argv.json / extensions were not touched.' -ForegroundColor Yellow
