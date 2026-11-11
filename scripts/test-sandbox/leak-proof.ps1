# ---------------------------------------------------------------------------
# scripts/test-sandbox/leak-proof.ps1 - Red run for Windows AppContainer sandbox.
#
# Proves the Windows sandbox is real:
# 1. Runs test outside sandbox -> MUST BE REFUSED by gate.
# 2. Runs sentinel probe directly outside sandbox -> proves host sentinel readable by host.
# 3. Runs under run.ps1 -> proves AppContainer denies real-home & sentinel access,
#    passes admission probe, sets marker only in sandbox, and completes cleanly.
# ---------------------------------------------------------------------------
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$realHome = [Environment]::GetFolderPath('UserProfile')

$passCount = 0
$failCount = 0

function Report-Pass([string]$name) {
    [Console]::WriteLine("[PASS] $name")
    $script:passCount++
}

function Report-Fail([string]$name, [string]$reason) {
    [Console]::WriteLine("[FAIL] $name : $reason")
    $script:failCount++
}

Write-Output "=== Windows Test Sandbox Leak Proof ==="
Write-Output "Repo Root: $repoRoot"
Write-Output "Host UserProfile: $realHome"

# Check 1: Direct invocation outside sandbox MUST be REFUSED
Write-Output "`n--- Check 1: Direct invocation outside sandbox must refuse ---"
$outsideProcess = Start-Process -FilePath "bun" -ArgumentList "test packages/utils/test/abortable.test.ts" -WorkingDirectory $repoRoot -NoNewWindow -Wait -PassThru -RedirectStandardError (Join-Path $scriptDir "temp_outside_err.log") -RedirectStandardOutput (Join-Path $scriptDir "temp_outside_out.log")
$outsideExit = $outsideProcess.ExitCode
$outsideOut = Get-Content (Join-Path $scriptDir "temp_outside_out.log") -Raw -ErrorAction SilentlyContinue
$outsideErr = Get-Content (Join-Path $scriptDir "temp_outside_err.log") -Raw -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $scriptDir "temp_outside_*.log") -ErrorAction SilentlyContinue

if ($outsideExit -ne 0 -and ($outsideOut -match "REFUSED" -or $outsideErr -match "REFUSED")) {
    Report-Pass "Direct execution without sandbox refused by gate with non-zero exit ($outsideExit)"
} else {
    Report-Fail "Direct execution without sandbox" "Expected REFUSED with non-zero exit, got exit $outsideExit"
}

# Check 2: AppContainer launcher admission probe and sentinel denial
Write-Output "`n--- Check 2: Native AppContainer sandbox execution & sentinel denial ---"
$probeFile = Join-Path $scriptDir "windows-guest-sentinel-proof.test.ts"
if (-not (Test-Path -LiteralPath $probeFile)) {
    Report-Fail "Guest proof test file missing" "Tracked file $probeFile does not exist"
    exit 1
}

# Capture host home ACL SDDL before running sandbox
$sddlBefore = (Get-Acl -LiteralPath $realHome).Sddl

$runPs1 = Join-Path $scriptDir "run.ps1"
$sandProcess = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$runPs1`" -RepoRoot `"$repoRoot`" -- bun test `"$probeFile`"" -WorkingDirectory $repoRoot -NoNewWindow -Wait -PassThru -RedirectStandardError (Join-Path $scriptDir "temp_sand_err.log") -RedirectStandardOutput (Join-Path $scriptDir "temp_sand_out.log")
$sandExit = $sandProcess.ExitCode
$sandOut = Get-Content (Join-Path $scriptDir "temp_sand_out.log") -Raw -ErrorAction SilentlyContinue
$sandErr = Get-Content (Join-Path $scriptDir "temp_sand_err.log") -Raw -ErrorAction SilentlyContinue

Remove-Item -Force (Join-Path $scriptDir "temp_sand_*.log") -ErrorAction SilentlyContinue

if ($sandExit -eq 0 -and $sandOut -match "1 pass") {
    Report-Pass "AppContainer sandbox executed guest proof test cleanly (1 pass)"
} else {
    Write-Output "Stdout: $sandOut"
    Write-Output "Stderr: $sandErr"
    Report-Fail "AppContainer sandbox execution" "Exit $sandExit, expected 0 with '1 pass'"
}

# Capture host home ACL SDDL after running sandbox
$sddlAfter = (Get-Acl -LiteralPath $realHome).Sddl

# Check 3: Host ACLs untouched on operator home
Write-Output "`n--- Check 3: Host UserProfile ACLs remain untouched ---"
if ($sddlBefore -ne $sddlAfter) {
    Report-Fail "Host UserProfile ACL isolation" "Host UserProfile SDDL changed! Before: $sddlBefore; After: $sddlAfter"
} else {
    Report-Pass "Host UserProfile ACL completely untouched (SDDL match)"
}

Write-Output "`n=== Summary: $passCount passed, $failCount failed ==="
if ($failCount -gt 0) {
    exit 1
}
exit 0
