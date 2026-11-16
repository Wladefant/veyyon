# ---------------------------------------------------------------------------
# scripts/test-sandbox/leak-proof.ps1 - Proof suite for Windows AppContainer sandbox.
#
# Proves all isolation, staging, lifecycle, and argument boundaries:
# 1. Direct bun test outside sandbox -> refused by gate.
# 2. AppContainer guest sentinel & hostile-write proof + zero host-home residue + SDDL match.
# 3. Non-zero exit code propagation (e.g. exit 37).
# 4. Detached descendant process termination via Job Object.
# 5. Synthetic hostile source junction rejection (F1).
# 6. Synthetic root .env exclusion via config allowlist (F2).
# 7. Missing-leaf scratch ancestor junction rejection (F3).
# 8. Private scratch DACL blocks inherited public ACEs (F4).
# 9. Directory-boundary path remapping does not mangle sibling prefixes (F10).
# ---------------------------------------------------------------------------
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$realHome = [Environment]::GetFolderPath('UserProfile')
$runPs1 = Join-Path $scriptDir "run.ps1"

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

$logDir = Join-Path ([System.IO.Path]::GetTempPath()) ("veyyon-leak-proof-" + [Guid]::NewGuid().ToString("N"))
$programDataRoot = if ($env:ProgramData) { $env:ProgramData } else { "C:\ProgramData" }
$publicParent = Join-Path $programDataRoot ("veyyon-leak-proof-f4-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stepIdx = 0

function Invoke-LoggedProcess([string]$filePath, [string]$argumentList, [string]$workDir) {
    $script:stepIdx++
    $outPath = Join-Path $logDir ("step_" + $script:stepIdx + "_out.log")
    $errPath = Join-Path $logDir ("step_" + $script:stepIdx + "_err.log")
    $proc = Start-Process -FilePath $filePath -ArgumentList $argumentList -WorkingDirectory $workDir -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outPath -RedirectStandardError $errPath
    $outText = if (Test-Path -LiteralPath $outPath) { Get-Content -LiteralPath $outPath -Raw -ErrorAction SilentlyContinue } else { "" }
    $errText = if (Test-Path -LiteralPath $errPath) { Get-Content -LiteralPath $errPath -Raw -ErrorAction SilentlyContinue } else { "" }
    return @{
        ExitCode = $proc.ExitCode
        Stdout = if ($outText) { $outText } else { "" }
        Stderr = if ($errText) { $errText } else { "" }
    }
}

try {
    Write-Output "=== Windows Test Sandbox Leak Proof ==="
    Write-Output "Repo Root: $repoRoot"
    Write-Output "Host UserProfile: $realHome"
    Write-Output "Isolated Log Dir: $logDir"

    # Check 1: Direct invocation outside sandbox MUST be REFUSED
    Write-Output "`n--- Check 1: Direct invocation outside sandbox must refuse ---"
    $r1 = Invoke-LoggedProcess "bun" "test packages/utils/test/abortable.test.ts" $repoRoot
    if ($r1.ExitCode -ne 0 -and ($r1.Stdout -match "REFUSED" -or $r1.Stderr -match "REFUSED")) {
        Report-Pass "Direct execution without sandbox refused by gate with non-zero exit ($($r1.ExitCode))"
    } else {
        Report-Fail "Direct execution without sandbox" "Expected REFUSED with non-zero exit, got exit $($r1.ExitCode)"
    }

    # Check 2: AppContainer guest sentinel & hostile-write proof + host-home inventory + SDDL
    Write-Output "`n--- Check 2: Native AppContainer sandbox execution, hostile write denial, & zero host residue ---"
    $probeFile = Join-Path $scriptDir "windows-guest-sentinel-proof.test.ts"
    if (-not (Test-Path -LiteralPath $probeFile)) {
        Report-Fail "Guest proof test file missing" "Tracked file $probeFile does not exist"
        exit 1
    }

    $homeEntriesBefore = @(Get-ChildItem -LiteralPath $realHome -Force | Select-Object -ExpandProperty Name | Sort-Object)
    $sddlBefore = (Get-Acl -LiteralPath $realHome).Sddl

    $r2 = Invoke-LoggedProcess "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$runPs1`" -RepoRoot `"$repoRoot`" -- bun test `"$probeFile`"" $repoRoot
    if ($r2.ExitCode -eq 0 -and $r2.Stdout -match "1 pass") {
        Report-Pass "AppContainer sandbox executed guest proof test cleanly (1 pass)"
    } else {
        Write-Output "Stdout: $($r2.Stdout)"
        Write-Output "Stderr: $($r2.Stderr)"
        Report-Fail "AppContainer sandbox execution" "Exit $($r2.ExitCode), expected 0 with '1 pass'"
    }

    $homeEntriesAfter = @(Get-ChildItem -LiteralPath $realHome -Force | Select-Object -ExpandProperty Name | Sort-Object)
    $diffHome = Compare-Object -ReferenceObject $homeEntriesBefore -DifferenceObject $homeEntriesAfter
    if ($diffHome) {
        $leakedNames = ($diffHome | ForEach-Object { "$($_.SideIndicator)$($_.InputObject)" }) -join ", "
        Report-Fail "Host UserProfile zero-residue check" "Host UserProfile entries changed: $leakedNames"
    } else {
        Report-Pass "Host UserProfile has zero leftover sentinel or test entries"
    }

    $sddlAfter = (Get-Acl -LiteralPath $realHome).Sddl
    if ($sddlBefore -ne $sddlAfter) {
        Report-Fail "Host UserProfile ACL isolation" "Host UserProfile SDDL changed! Before: $sddlBefore; After: $sddlAfter"
    } else {
        Report-Pass "Host UserProfile ACL completely untouched (SDDL match)"
    }

    # Check 3: Non-zero exit code propagation
    Write-Output "`n--- Check 3: Non-zero guest exit code propagation ---"
    $r3 = Invoke-LoggedProcess "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$runPs1`" -RepoRoot `"$repoRoot`" -- bun -e `"process.exit(37)`"" $repoRoot

    # Check 2b: Pure kernel write denial (bun -e without bunfig preload)
    $r2b = Invoke-LoggedProcess "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$runPs1`" -RepoRoot `"$repoRoot`" -- bun -e `"const fs=require('node:fs'),p=require('node:path'); const f=p.join(process.env.VEYYON_TEST_HOST_HOME,'.veyyon-kernel-write-'+Date.now()+'.tmp'); try{fs.writeFileSync(f,'x');process.exit(99);}catch(e){console.log('KERNEL_WRITE_ERR='+e.code);}`"" $repoRoot
    if ($r2b.ExitCode -eq 0 -and ($r2b.Stdout -match "KERNEL_WRITE_ERR=(EPERM|EACCES)")) {
        Report-Pass "Kernel AppContainer denied hostile write without preload ($($Matches[1]))"
    } else {
        Report-Fail "Kernel hostile write denial" "Exit $($r2b.ExitCode), stdout: $($r2b.Stdout), stderr: $($r2b.Stderr)"
    }
    if ($r3.ExitCode -eq 37) {
        Report-Pass "Guest non-zero exit code propagated accurately (37)"
    } else {
        Report-Fail "Non-zero exit propagation" "Expected exit 37, got $($r3.ExitCode) (stderr: $($r3.Stderr))"
    }

    # Check 4: Detached descendant process termination via Job Object
    Write-Output "`n--- Check 4: Detached descendant process termination ---"
    $r4 = Invoke-LoggedProcess "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$runPs1`" -RepoRoot `"$repoRoot`" -- bun -e `"const cp=require('node:child_process'); const c=cp.spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'}); console.log('DETACHED_PID='+c.pid); c.unref();`"" $repoRoot
    $detachedPid = $null
    if ($r4.Stdout -match "DETACHED_PID=(\d+)") {
        $detachedPid = [int]$Matches[1]
    }
    if ($r4.ExitCode -eq 0 -and $detachedPid) {
        Start-Sleep -Milliseconds 300
        $stillAlive = Get-Process -Id $detachedPid -ErrorAction SilentlyContinue
        if (-not $stillAlive) {
            Report-Pass "Detached descendant process ($detachedPid) terminated on job close"
        } else {
            Stop-Process -Id $detachedPid -Force -ErrorAction SilentlyContinue
            Report-Fail "Detached descendant termination" "Detached child PID $detachedPid survived sandbox exit"
        }
    } else {
        Report-Fail "Detached descendant termination" "Exit $($r4.ExitCode), stdout: $($r4.Stdout), stderr: $($r4.Stderr)"
    }

    # Check 5: Synthetic hostile fixtures (F1 source junction, F2 .env exclusion, F3 missing-leaf junction, F4 private DACL, F10 boundary remap)
    Write-Output "`n--- Check 5: Hostile staging, ancestry, ACL, and boundary-remap defenses ---"

    # F1: Source junction in packages/external -> secret dir must be rejected
    $repoF1 = Join-Path $logDir "repo-f1"
    $secretF1 = Join-Path $logDir "secret-f1"
    New-Item -ItemType Directory -Path (Join-Path $repoF1 "packages") -Force | Out-Null
    New-Item -ItemType Directory -Path $secretF1 -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $repoF1 "package.json") -Value '{"name":"f1-test"}' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $secretF1 "token.txt") -Value "synthetic-secret" -Encoding utf8
    cmd.exe /c "mklink /J `"$repoF1\packages\external`" `"$secretF1`"" | Out-Null
    $r5a = Invoke-LoggedProcess "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$runPs1`" -RepoRoot `"$repoF1`" -- bun -e `"console.log('F1_RAN')`"" $repoRoot
    if ($r5a.ExitCode -ne 0 -and $r5a.Stdout -notmatch "F1_RAN") {
        Report-Pass "F1: Source junction rejected before staging (exit $($r5a.ExitCode))"
    } else {
        Report-Fail "F1: Source junction rejection" "Expected refusal, got exit $($r5a.ExitCode) stdout: $($r5a.Stdout)"
    }

    # F2: Root .env must NOT be staged into guest scratch
    $repoF2 = Join-Path $logDir "repo-f2"
    New-Item -ItemType Directory -Path $repoF2 -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $repoF2 "package.json") -Value '{"name":"f2-test"}' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $repoF2 ".env") -Value "SYNTHETIC_TOKEN=do-not-stage" -Encoding utf8
    $r5b = Invoke-LoggedProcess "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$runPs1`" -RepoRoot `"$repoF2`" -- bun -e `"const fs=require('node:fs'); console.log(fs.existsSync('.env') ? 'ENV_LEAKED' : 'ENV_ABSENT')`"" $repoRoot
    if ($r5b.ExitCode -eq 0 -and $r5b.Stdout -match "ENV_ABSENT" -and $r5b.Stdout -notmatch "ENV_LEAKED") {
        Report-Pass "F2: Root .env excluded by runtime config allowlist"
    } else {
        Report-Fail "F2: Root .env exclusion" "Exit $($r5b.ExitCode), stdout: $($r5b.Stdout), stderr: $($r5b.Stderr)"
    }

    # F3: Missing-leaf scratch ancestor junction must be rejected
    $targetF3 = Join-Path $logDir "target-f3"
    $linkF3 = Join-Path $logDir "link-f3"
    New-Item -ItemType Directory -Path $targetF3 -Force | Out-Null
    cmd.exe /c "mklink /J `"$linkF3`" `"$targetF3`"" | Out-Null
    $missingLeaf = Join-Path $linkF3 "fresh-scratch"
    $r5c = Invoke-LoggedProcess "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$runPs1`" -RepoRoot `"$repoF2`" -ScratchRoot `"$missingLeaf`" -- bun -e `"console.log('F3_RAN')`"" $repoRoot
    if ($r5c.ExitCode -ne 0 -and -not (Test-Path -LiteralPath (Join-Path $targetF3 "fresh-scratch"))) {
        Report-Pass "F3: Missing-leaf scratch ancestor junction rejected"
    } else {
        Report-Fail "F3: Missing-leaf ancestor junction" "Expected refusal and no target creation, got exit $($r5c.ExitCode)"
    }

    # F4: Private scratch DACL strips inherited Everyone:(OI)(CI)(R) from parent
    # F4: Private scratch DACL strips inherited Everyone:(OI)(CI)(R) from parent (placed under ProgramData outside realHome)
    New-Item -ItemType Directory -Path $publicParent -Force | Out-Null
    $r5d = Invoke-LoggedProcess "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$runPs1`" -RepoRoot `"$repoF2`" -ScratchRoot `"$publicParent`" -- powershell.exe -NoProfile -Command `"`$s = Split-Path -Parent `$env:HOME; `$a = Get-Acl -LiteralPath `$s; `$pub = `$a.Access | Where-Object { `$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -in @('S-1-1-0','S-1-5-32-545','S-1-5-11') }; Write-Output ('PROT=' + `$a.AreAccessRulesProtected + ';PUB=' + (@(`$pub).Count))`"" $repoRoot
    if ($r5d.ExitCode -eq 0 -and $r5d.Stdout -match "PROT=True;PUB=0") {
        Report-Pass "F4: Private scratch DACL blocks inherited public ACEs"
    } else {
        Report-Fail "F4: Private scratch DACL" "Exit $($r5d.ExitCode), stdout: $($r5d.Stdout), stderr: $($r5d.Stderr)"
    }

    # F10: Directory-boundary path remapping does not mangle sibling prefix path
    $siblingPath = $repoRoot.TrimEnd('\', '/') + "-other\case.test.ts"
    $r5e = Invoke-LoggedProcess "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$runPs1`" -RepoRoot `"$repoRoot`" -- bun -e `"console.log('ARG=' + process.argv[1])`" `"$siblingPath`"" $repoRoot
    if ($r5e.ExitCode -eq 0 -and $r5e.Stdout.Contains("ARG=$siblingPath")) {
        Report-Pass "F10: Sibling prefix path outside RepoRoot preserved without mangling"
    } else {
        Report-Fail "F10: Directory boundary remap" "Expected ARG=$siblingPath, got exit $($r5e.ExitCode), stdout: $($r5e.Stdout)"
    }

    Write-Output "`n=== Summary: $passCount passed, $failCount failed ==="
    if ($failCount -gt 0) {
        exit 1
    }
    exit 0
} finally {
    if (Test-Path -LiteralPath $logDir) {
        Get-ChildItem -LiteralPath $logDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                [System.IO.Directory]::Delete($_.FullName)
            }
        }
    if (Test-Path -LiteralPath $publicParent) {
        Remove-Item -LiteralPath $publicParent -Recurse -Force -ErrorAction SilentlyContinue
    }
        Remove-Item -LiteralPath $logDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
