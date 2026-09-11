# Deleting an account must never remove a file of the user's Claude Code
# installation, which the account folder links to.
#
# It did: fs.rmSync(recursive) in VS Code's runtime went through the junctions
# and deleted installed plugins, even with nothing locked. This builds a fake
# installation and a linked account in a temporary folder, holds files open the
# way a running `claude` does, deletes the account with the compiled code, and
# fails if the installation lost anything. Run after `npx tsc -p ./`:
#
#   powershell -File scripts/test-delete.ps1

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$code = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
$base = Join-Path $env:TEMP "claudes-delete-test"
$failed = 0

foreach ($links in 'claudes', 'mklink') {
  foreach ($lock in 'none', 'account', 'installation', 'both') {
    $S = Join-Path $base "$links-$lock"
    Remove-Item -Recurse -Force $S -ErrorAction SilentlyContinue
    foreach ($d in 'main\plugins\cache\aaa-plugin', 'main\plugins\cache\bbb-plugin', 'main\skills\s1', 'acct\sessions') {
      New-Item -ItemType Directory -Force (Join-Path $S $d) | Out-Null
    }
    foreach ($i in 1..5) {
      'x' | Set-Content "$S\main\plugins\cache\aaa-plugin\f$i"
      'x' | Set-Content "$S\main\plugins\cache\bbb-plugin\f$i"
    }
    'x' | Set-Content "$S\main\plugins\.last_inuse_sweep"
    'x' | Set-Content "$S\main\skills\s1\SKILL.md"
    '{}' | Set-Content "$S\main\settings.json"
    't' | Set-Content "$S\acct\.credentials.json"
    '{}' | Set-Content "$S\acct\.claude.json"
    'k' | Set-Content "$S\acct\sessions\123.key"

    $env:ELECTRON_RUN_AS_NODE = '1'
    if ($links -eq 'claudes') {
      & $code -e "require(process.argv[1] + '/dist/sharing.js').shareSettings(process.argv[2], process.argv[3])" $repo "$S\main" "$S\acct" | Out-Null
    } else {
      cmd /c mklink /J "$S\acct\plugins" "$S\main\plugins" | Out-Null
      cmd /c mklink /J "$S\acct\skills" "$S\main\skills" | Out-Null
    }

    $held = @()
    if ($lock -in 'account', 'both') { $held += "$S\acct\sessions\123.key" }
    if ($lock -in 'installation', 'both') { $held += "$S\main\plugins\cache\bbb-plugin\f3" }
    $holder = $null
    if ($held.Count) {
      $open = ($held | ForEach-Object { "[IO.File]::Open('$_','Open','Read','None') | Out-Null;" }) -join ' '
      $holder = Start-Process powershell -ArgumentList '-NoProfile', '-Command', "$open Start-Sleep 6" -WindowStyle Hidden -PassThru
      Start-Sleep -Milliseconds 1500
    }

    Write-Host "links made by $links, file held open in: $lock"
    & $code (Join-Path $PSScriptRoot 'test-delete.js') $S $repo | Write-Host
    if ($LASTEXITCODE -ne 0) { $failed++; Write-Host '  FAILED: the installation lost files' -ForegroundColor Red }
    Remove-Item Env:ELECTRON_RUN_AS_NODE
    if ($holder) { $holder | Wait-Process -Timeout 15 }
  }
}

Remove-Item -Recurse -Force $base -ErrorAction SilentlyContinue
if ($failed) { Write-Host "$failed case(s) FAILED" -ForegroundColor Red; exit 1 }
Write-Host 'All cases passed: the installation kept every file.' -ForegroundColor Green
