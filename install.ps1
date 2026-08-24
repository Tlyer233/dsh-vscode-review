# One-click install: dsh plugin + VS Code extension + editorInsets argv.json
# Idempotent: safe to re-run. Replaces the current dsh-review VS Code extension.
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtId = 'dsn.dsh-review-vscode'
$ExtVer = '0.1.0'
$DshPlugin = Join-Path $Root 'dsh-review'
$VscodeSrc = Join-Path $Root 'dsh-review-vscode'
$VscodeExtDir = if ($env:VSCODE_EXTENSIONS_DIR) { $env:VSCODE_EXTENSIONS_DIR } else { Join-Path $env:USERPROFILE '.vscode\extensions' }

# Write JSON array as UTF-8 without BOM. PS 5.1 `ConvertTo-Json` + `Set-Content UTF8` breaks VS Code:
# one item becomes `{...}` not `[{...}]`, and UTF8 encoding adds a BOM.
function Write-Utf8JsonArray {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [AllowEmptyCollection()][object[]]$Items
  )
  $list = @($Items)
  if ($list.Count -eq 0) {
    $text = '[]' # catalog must stay an array
  } elseif ($list.Count -eq 1) {
    $one = ConvertTo-Json -InputObject $list[0] -Depth 16 -Compress
    $text = '[' + $one + ']' # wrap: PS 5.1 emits a bare object for a 1-item array
  } else {
    $text = ConvertTo-Json -InputObject $list -Depth 16 -Compress
  }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $text + "`n", $utf8)
}

# UTF-8 without BOM. PS 5.1 Set-Content -Encoding UTF8 writes a BOM that VS Code argv.json may ignore.
function Write-Utf8NoBom {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Text)
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

# Read argv.json as UTF-8 (strip BOM) or UTF-16 LE if that is what is on disk.
function Read-TextBestEffort {
  param([Parameter(Mandatory = $true)][string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    return [System.Text.UTF8Encoding]::new($false).GetString($bytes, 3, $bytes.Length - 3)
  }
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    return [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
  }
  return [System.Text.UTF8Encoding]::new($false).GetString($bytes)
}

# Register an unpacked folder or .vsix with the VS Code CLI. Returns $true on exit 0.
function Install-VscodeExtensionCli {
  param([Parameter(Mandatory = $true)][string]$Target)
  $code = Get-Command code -ErrorAction SilentlyContinue
  if (-not $code) { return $false }
  # code.cmd writes to stderr; cmd.exe keeps that from becoming a terminating NativeCommandError.
  cmd.exe /c "`"$($code.Source)`" --install-extension `"$Target`" --force"
  return ($LASTEXITCODE -eq 0)
}

function Merge-ArgvJson {
  param([string]$File, [string]$Id)
  $dir = Split-Path -Parent $File
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  $fresh = "{`n`t`"enable-proposed-api`": [`"$Id`"]`n}`n"
  if (-not (Test-Path $File)) {
    Write-Utf8NoBom -Path $File -Text $fresh
    Write-Host "created $File"
    return
  }
  $text = Read-TextBestEffort -Path $File
  $pattern = '"enable-proposed-api"\s*:\s*\[([^\]]*)\]'
  $match = [regex]::Match($text, $pattern)
  if ($match.Success) {
    $inner = $match.Groups[1].Value
    $ids = @()
    foreach ($m in [regex]::Matches($inner, '"([^"]+)"')) {
      $item = $m.Groups[1].Value
      if ($ids -notcontains $item) { $ids += $item }
    }
    if ($ids -notcontains $Id) { $ids += $Id }
    $rendered = '[' + (($ids | ForEach-Object { '"' + $_ + '"' }) -join ', ') + ']'
    $newText = $text.Substring(0, $match.Groups[0].Index) + '"enable-proposed-api": ' + $rendered + $text.Substring($match.Groups[0].Index + $match.Groups[0].Length)
    if ($newText -eq $text) {
      Write-Host "already listed in $File"
      return
    }
    Write-Utf8NoBom -Path $File -Text ($newText.TrimEnd() + "`n")
    Write-Host "updated $File"
    return
  }
  # Insert after the root `{` on its own line so comment headers with `{` are not used.
  $brace = [regex]::Match($text, '(?m)^[ \t]*\{')
  if ($brace.Success) {
    $at = $brace.Index + $brace.Length
    $text = $text.Insert($at, "`n`t`"enable-proposed-api`": [`"$Id`"],")
  } else {
    $text = $fresh
  }
  Write-Utf8NoBom -Path $File -Text ($text.TrimEnd() + "`n")
  Write-Host "updated $File"
}

function Sync-VscodeExtensionCatalog {
  param([string]$ExtDir, [string]$Id, [string]$Ver, [string]$Mode)
  if (-not (Test-Path $ExtDir)) {
    New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null
  }
  $destName = "$Id-$Ver"
  $dest = Join-Path $ExtDir $destName
  $catalog = Join-Path $ExtDir 'extensions.json'
  $removed = @()
  Get-ChildItem -Path $ExtDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $name = $_.Name
    $drop = $false
    if ($Mode -eq 'copy' -and $name.StartsWith("$Id-") -and $name -ne $destName) { $drop = $true }
    if ($drop) {
      Remove-Item -Recurse -Force $_.FullName
      $removed += $name
    }
  }
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
  $dropIds = @()
  if ($Mode -eq 'copy') { $dropIds += $Id }
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
  if ($Mode -eq 'copy' -and (Test-Path (Join-Path $dest 'package.json'))) {
    $kept += [pscustomobject]@{
      identifier = @{ id = $Id }
      version = $Ver
      location = @{ '$mid' = 1; path = $dest; scheme = 'file' }
      relativeLocation = $destName
      metadata = @{
        installedTimestamp = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        pinned = $true
        source = 'vsix'
        isPreReleaseVersion = $false
      }
    }
  }
  Write-Utf8JsonArray -Path $catalog -Items $kept
  if ($removed.Count -gt 0) {
    Write-Host ("removed old extension dirs: " + ($removed -join ', '))
  } else {
    Write-Host 'no old extension dirs to remove'
  }
  Write-Host "synced $catalog"
}

function Install-DshPlugin {
  if (-not (Test-Path $DshPlugin)) {
    throw "missing $DshPlugin"
  }
  $cache = Join-Path $env:USERPROFILE '.dsh\profiles\web\.install-cache'
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  Get-ChildItem -Path $cache -Filter 'dsh-review-*.tgz' -ErrorAction SilentlyContinue | Remove-Item -Force
  Push-Location $DshPlugin
  try {
    if (Get-Command npm -ErrorAction SilentlyContinue) {
      & npm pack --pack-destination $cache
      if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
    } elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
      & pnpm pack --pack-destination $cache
      if ($LASTEXITCODE -ne 0) { throw 'pnpm pack failed' }
    } else {
      throw 'need npm or pnpm to pack dsh-review (adding the folder would link, not copy)'
    }
  } finally {
    Pop-Location
  }
  $tgz = Get-ChildItem -Path $cache -Filter 'dsh-review-*.tgz' -File | Select-Object -First 1
  if (-not $tgz) { throw "pack produced no tarball in $cache" }
  Write-Host "packed $($tgz.FullName)"
  Write-Host 'installing a copy into the web profile (not a source-tree link)'
  & dsh plugin --profile web add $tgz.FullName --force
  if ($LASTEXITCODE -ne 0) { throw 'dsh plugin add failed' }
}

function Reset-ShadowStore {
  $dshHome = if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { $env:DSH_HOME.Trim() } else { Join-Path $env:USERPROFILE '.dsh' }
  $root = Join-Path $dshHome 'review\shadow'
  $gitDir = Join-Path $root 'repo.git'
  $pend = Join-Path $root 'pending'
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'missing command: git'
  }
  New-Item -ItemType Directory -Force -Path $pend | Out-Null
  if (Test-Path $gitDir) {
    Remove-Item -Recurse -Force $gitDir
  }
  & git init --bare --template= $gitDir
  if ($LASTEXITCODE -ne 0) { throw 'git init --bare failed' }
  & git --git-dir="$gitDir" config commit.gpgSign false
  & git --git-dir="$gitDir" config user.name dsh-shadow
  & git --git-dir="$gitDir" config user.email shadow@localhost
  Get-ChildItem -Path $root -Filter '.index-*' -File -ErrorAction SilentlyContinue | Remove-Item -Force
  Get-ChildItem -Path $pend -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
    [System.IO.File]::WriteAllText($_.FullName, "[]`n")
  }
  Write-Host "reset shadow git $gitDir"
  Write-Host "emptied pending $pend\*.json"
}

Write-Host '=== [1/4] Install dsh plugin (dsh-review) ===' -ForegroundColor Cyan
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw 'missing command: dsh'
}
Install-DshPlugin

Write-Host '=== [2/4] Install VS Code extension ===' -ForegroundColor Cyan
if (-not (Test-Path $VscodeSrc)) {
  throw "missing $VscodeSrc"
}
if (-not (Test-Path $VscodeExtDir)) {
  New-Item -ItemType Directory -Force -Path $VscodeExtDir | Out-Null
}
$vsix = Get-ChildItem -Path $VscodeSrc -Filter '*.vsix' -File -ErrorAction SilentlyContinue | Select-Object -First 1
$dest = Join-Path $VscodeExtDir "${ExtId}-${ExtVer}"
if ($vsix) {
  Write-Host "installing $($vsix.FullName)"
  if (-not (Install-VscodeExtensionCli -Target $vsix.FullName)) {
    throw 'code --install-extension failed (add VS Code to PATH, then fully quit VS Code)'
  }
  Sync-VscodeExtensionCatalog -ExtDir $VscodeExtDir -Id $ExtId -Ver $ExtVer -Mode 'vsix'
} else {
  Write-Host "VSIX not found; copying source into $dest" -ForegroundColor Yellow
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item (Join-Path $VscodeSrc 'extension.js') $dest
  Copy-Item (Join-Path $VscodeSrc 'package.json') $dest
  Copy-Item -Recurse (Join-Path $VscodeSrc 'lib') $dest
  Copy-Item -Recurse (Join-Path $VscodeSrc 'media') $dest
  $scripts = Join-Path $VscodeSrc 'scripts'
  if (Test-Path $scripts) { Copy-Item -Recurse $scripts $dest }
  Sync-VscodeExtensionCatalog -ExtDir $VscodeExtDir -Id $ExtId -Ver $ExtVer -Mode 'copy'
  if (Install-VscodeExtensionCli -Target $dest) {
    Write-Host "registered $ExtId via code --install-extension"
  } else {
    Write-Host "code CLI missing or failed; left unpacked extension at $dest" -ForegroundColor Yellow
    Write-Host 'Add `code` to PATH, or fully quit VS Code (not just close the window) and reopen.' -ForegroundColor Yellow
  }
}

Write-Host '=== [3/4] Enable editorInsets in VS Code argv.json ===' -ForegroundColor Cyan
$argvFile = Join-Path $env:USERPROFILE '.vscode\argv.json'
Merge-ArgvJson -File $argvFile -Id $ExtId
if (-not (Select-String -LiteralPath $argvFile -Pattern ([regex]::Escape($ExtId)) -Quiet -ErrorAction SilentlyContinue)) {
  throw "argv.json missing $ExtId (editorInsets will not work): $argvFile"
}
Write-Host "argv.json = $argvFile" -ForegroundColor Yellow
$insiders = Join-Path $env:USERPROFILE '.vscode-insiders\argv.json'
if (Test-Path (Split-Path $insiders)) {
  Merge-ArgvJson -File $insiders -Id $ExtId
}

Write-Host '=== [4/4] Reset dsh-review shadow git ===' -ForegroundColor Cyan
Reset-ShadowStore

Write-Host '=== Done ===' -ForegroundColor Cyan
Write-Host '1. Completely quit VS Code (File > Exit, not just close the window), then reopen. argv.json is only read at startup.' -ForegroundColor Yellow
Write-Host '2. Restart dsh web (or use the sidebar Restart button).' -ForegroundColor Yellow
Write-Host '3. Shadow store was wiped (repo.git + pending/*.json). Unreviewed diffs are gone.' -ForegroundColor Yellow
Write-Host "editorInsets argv.json id: $ExtId" -ForegroundColor Yellow
Write-Host 'dsh-review is copied into ~/.dsh/profiles/web (source folder can be deleted).' -ForegroundColor Yellow
Write-Host "Re-run this script to upgrade both the dsh plugin and the VS Code extension." -ForegroundColor Yellow
