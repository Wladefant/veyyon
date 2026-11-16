# ---------------------------------------------------------------------------
# scripts/test-sandbox/run.ps1 - run tests inside a native Windows AppContainer
# sandbox whose filesystem view restricts access to the operator's home directory.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-sandbox/run.ps1 -RepoRoot <checkout> -- bun test <paths> -t <filter>
#
# ---------------------------------------------------------------------------
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Log-Message([string]$msg) {
    [Console]::Error.WriteLine("[test-sandbox-windows] $msg")
}

function Die([string]$msg, [int]$exitCode = 2) {
    [Console]::Error.WriteLine("[test-sandbox-windows] error: $msg")
    exit $exitCode
}
function Test-IsUnderOrSame([string]$childPath, [string]$parentPath) {
    $c = [System.IO.Path]::GetFullPath($childPath).TrimEnd('\', '/')
    $p = [System.IO.Path]::GetFullPath($parentPath).TrimEnd('\', '/')
    if ($c.Equals($p, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $c.StartsWith($p + "\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoJunctionOrReparse([string]$pathToCheck) {
    $curr = [System.IO.Path]::GetFullPath($pathToCheck).TrimEnd('\', '/')
    while ($curr) {
        if (Test-Path -LiteralPath $curr) {
            $item = Get-Item -LiteralPath $curr -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                Die "Scratch path or ancestor is a junction/reparse point: $curr"
            }
        }
        $parent = [System.IO.Path]::GetDirectoryName($curr)
        if (-not $parent -or $parent -eq $curr) {
            break
        }
        $curr = $parent
    }
}

function Assert-NoSourceReparsePoints([string]$dirPath) {
    $rootItem = Get-Item -LiteralPath $dirPath -Force
    if ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        Die "Source directory is a junction/reparse point: $dirPath"
    }
    $stack = [System.Collections.Generic.Stack[string]]::new()
    $stack.Push($dirPath)
    while ($stack.Count -gt 0) {
        $current = $stack.Pop()
        foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($current)) {
            $attr = [System.IO.File]::GetAttributes($entry)
            if ($attr -band [System.IO.FileAttributes]::ReparsePoint) {
                Die "Source tree contains a junction/reparse point: $entry"
            }
            if ($attr -band [System.IO.FileAttributes]::Directory) {
                $stack.Push($entry)
            }
        }
    }
}

function Expand-WorkspacePattern([string]$repoDir, [string]$pattern) {
    $norm = $pattern.Replace('/', '\').Trim('\')
    if (-not $norm) { return @() }
    $parts = $norm.Split('\')
    $candidates = @($repoDir)
    foreach ($part in $parts) {
        $next = @()
        foreach ($base in $candidates) {
            if (-not (Test-Path -LiteralPath $base)) { continue }
            if ($part -eq "*") {
                foreach ($d in [System.IO.Directory]::EnumerateDirectories($base)) {
                    $next += $d
                }
            } elseif ($part.Contains("*") -or $part.Contains("?")) {
                foreach ($d in [System.IO.Directory]::EnumerateDirectories($base, $part)) {
                    $next += $d
                }
            } else {
                $sub = Join-Path $base $part
                if (Test-Path -LiteralPath $sub -PathType Container) {
                    $next += $sub
                }
            }
        }
        $candidates = $next
    }
    return $candidates
}


# Parse custom arguments manually from $args to support '--' syntax seamlessly
$RepoRoot = $null
$ScratchRoot = $null
$TimeoutSec = if ($env:VEYYON_TEST_SANDBOX_TIMEOUT_SEC) { [int]$env:VEYYON_TEST_SANDBOX_TIMEOUT_SEC } else { 600 }
$actualCmdArgs = @()

$i = 0
$inCommand = $false
while ($i -lt $args.Count) {
    $arg = $args[$i]
    if (-not $inCommand) {
        if ($arg -eq "--") {
            $inCommand = $true
            $i++
            continue
        }
        if ($arg -eq "-RepoRoot" -or $arg -eq "--RepoRoot" -or $arg -eq "-repo-root") {
            $i++
            if ($i -lt $args.Count) {
                $RepoRoot = $args[$i]
            }
            $i++
            continue
        }
        if ($arg -eq "-ScratchRoot" -or $arg -eq "--ScratchRoot" -or $arg -eq "-scratch-root") {
            $i++
            if ($i -lt $args.Count) {
                $ScratchRoot = $args[$i]
            }
            $i++
            continue
        }
        if ($arg -eq "-TimeoutSec" -or $arg -eq "--TimeoutSec" -or $arg -eq "-timeout-sec") {
            $i++
            if ($i -lt $args.Count) {
                $TimeoutSec = [int]$args[$i]
            }
            $i++
            continue
        }
    }
    $actualCmdArgs += $arg
    $i++
}

# Resolve script directory and repo root
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RepoRoot) {
    if ($env:VEYYON_SANDBOX_REPO_ROOT) {
        $RepoRoot = $env:VEYYON_SANDBOX_REPO_ROOT
    } else {
        $RepoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
    }
} else {
    $RepoRoot = (Resolve-Path $RepoRoot).Path
}

# Resolve real host home (cannot be moved by environment variable HOME)
$realHome = [Environment]::GetFolderPath('UserProfile')
if (-not $realHome) {
    Die "cannot determine real host user profile directory"
}
$realHome = [System.IO.Path]::GetFullPath($realHome)

# Resolve ScratchRoot outside host home
if (-not $ScratchRoot) {
    if ($env:VEYYON_TEST_SCRATCH_ROOT) {
        $ScratchRoot = $env:VEYYON_TEST_SCRATCH_ROOT
    } else {
        $programData = [Environment]::GetFolderPath('CommonApplicationData')
        if (-not $programData) {
            $programData = "C:\ProgramData"
        }
        $ScratchRoot = Join-Path $programData "veyyon-test-sandbox"
    }
}

$ScratchRoot = [System.IO.Path]::GetFullPath($ScratchRoot)

# Guard against ScratchRoot being under real home or being an ancestor of real home
if (Test-IsUnderOrSame $ScratchRoot $realHome) {
    Die "ScratchRoot cannot be located under or equal to host user home ($realHome)"
}
if (Test-IsUnderOrSame $realHome $ScratchRoot) {
    Die "ScratchRoot cannot be an ancestor of host user home ($realHome)"
}

# Reject any junctions or reparse points in scratch path or its ancestors
Assert-NoJunctionOrReparse $ScratchRoot
# Ensure base ScratchRoot directory exists
try {
    if (-not (Test-Path $ScratchRoot)) {
        New-Item -ItemType Directory -Path $ScratchRoot -Force | Out-Null
    }
} catch {
    Die "failed to create ScratchRoot directory '$ScratchRoot': $($_.Exception.Message)"
}
Assert-NoJunctionOrReparse $ScratchRoot

# Compile / load P/Invoke AppContainer launcher
$csPath = Join-Path $scriptDir "windows-appcontainer.cs"
if (-not (Test-Path $csPath)) {
    Die "missing native AppContainer definitions file: $csPath"
}

try {
    Add-Type -Path $csPath -ErrorAction Stop
} catch {
    Die "failed to compile AppContainer P/Invoke definitions: $($_.Exception.Message)"
}

# Resolve host bun binary
$hostBun = (Get-Command bun -ErrorAction SilentlyContinue)
if (-not $hostBun) {
    Die "bun executable not found on host PATH"
}
$hostBunPath = $hostBun.Source

# Create unique profile and scratch instance
$uniqueId = [Guid]::NewGuid().ToString("N")
$profileName = "VeyyonTestSandbox_" + $uniqueId
$sessionScratch = [System.IO.Path]::GetFullPath((Join-Path $ScratchRoot $uniqueId))
if (-not (Test-IsUnderOrSame $sessionScratch $ScratchRoot)) {
    Die "sessionScratch path traversal detected: $sessionScratch outside $ScratchRoot"
}

try {
    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $ds = New-Object System.Security.AccessControl.DirectorySecurity
    $ds.SetAccessRuleProtection($true, $false)
    $inheritFlags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propFlags = [System.Security.AccessControl.PropagationFlags]::None
    $allowType = [System.Security.AccessControl.AccessControlType]::Allow
    $fullRights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $ds.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($currentUserSid, $fullRights, $inheritFlags, $propFlags, $allowType)))
    $ds.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")), $fullRights, $inheritFlags, $propFlags, $allowType)))
    $ds.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")), $fullRights, $inheritFlags, $propFlags, $allowType)))
    [System.IO.Directory]::CreateDirectory($sessionScratch, $ds) | Out-Null
} catch {
    Die "failed to allocate private session scratch directory '$sessionScratch': $($_.Exception.Message)"
}

Assert-NoJunctionOrReparse $sessionScratch
if (Test-IsUnderOrSame $sessionScratch $realHome) {
    Die "sessionScratch resolved under host user home: $sessionScratch"
}

$pSid = [IntPtr]::Zero
$profileCreated = $false
$sentinelPath = $null
$exitCode = 1
$cleanupFailed = $false

try {
    # 1. Create AppContainer Profile
    $sidStr = [AppContainerLauncher]::CreateProfile($profileName, [ref]$pSid)
    $profileCreated = $true
    Log-Message "Created AppContainer profile $profileName ($sidStr)"

    # 2. Grant AppContainer Package SID to private sessionScratch with (OI)(CI)(F) BEFORE populating
    $grantAcl = "*$sidStr`:(OI)(CI)(F)"
    & icacls $sessionScratch /grant $grantAcl /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Die "icacls grant on scratch failed with exit code $LASTEXITCODE"
    }

    $scratchAcl = Get-Acl -LiteralPath $sessionScratch
    if (-not $scratchAcl.AreAccessRulesProtected) {
        Die "sessionScratch DACL inheritance is not protected: $sessionScratch"
    }
    $forbiddenSids = @("S-1-1-0", "S-1-5-32-545", "S-1-5-11")
    foreach ($rule in $scratchAcl.Access) {
        $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        if ($forbiddenSids -contains $ruleSid) {
            Die "sessionScratch DACL contains public/shared ACE ($ruleSid): $sessionScratch"
        }
    }

    # 3. Stage Bun executable into scratch
    $scratchBun = Join-Path $sessionScratch "bun.exe"
    Copy-Item -Path $hostBunPath -Destination $scratchBun -Force

    # 4. Create isolated disposable environment directories
    $guestHome = Join-Path $sessionScratch "home"
    $guestAppData = Join-Path $sessionScratch "appdata\roaming"
    $guestLocalAppData = Join-Path $sessionScratch "appdata\local"
    $guestTmp = Join-Path $sessionScratch "tmp"

    New-Item -ItemType Directory -Path $guestHome -Force | Out-Null
    New-Item -ItemType Directory -Path $guestAppData -Force | Out-Null
    New-Item -ItemType Directory -Path $guestLocalAppData -Force | Out-Null
    New-Item -ItemType Directory -Path $guestTmp -Force | Out-Null
    # 5. Stage execution environment and workspace source trees into disposable scratch
    $stageRepo = Join-Path $sessionScratch "repo"
    New-Item -ItemType Directory -Path $stageRepo -Force | Out-Null
    # Stage explicit allowlist of root runtime/build configuration files (never stage .env, .npmrc, etc.)
    $allowedRootFiles = @(
        "package.json",
        "bunfig.toml",
        "bun.lock",
        "bun.lockb",
        "tsconfig.json",
        "tsconfig.base.json",
        "biome.json",
        "biome.jsonc",
        "Cargo.toml",
        "Cargo.lock"
    )
    foreach ($fileName in $allowedRootFiles) {
        $srcFile = Join-Path $RepoRoot $fileName
        if (Test-Path -LiteralPath $srcFile) {
            $item = Get-Item -LiteralPath $srcFile -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                Die "Root config file is a junction/reparse point: $srcFile"
            }
            if (-not $item.PSIsContainer) {
                Copy-Item -LiteralPath $srcFile -Destination (Join-Path $stageRepo $fileName) -Force
            }
        }
    }

    # Robocopy workspace trees (rejecting any source reparse points and passing /XJ)
    $workspaceDirs = @("packages", "plugins", "contracts", "kernel", "hosts", "clients", "tests", "apps", "scripts", "natives", "types")
    foreach ($d in $workspaceDirs) {
        $srcDir = Join-Path $RepoRoot $d
        if (Test-Path -LiteralPath $srcDir) {
            Assert-NoSourceReparsePoints $srcDir
            $dstDir = Join-Path $stageRepo $d
            & robocopy $srcDir $dstDir /E /XJ /MT:32 /R:0 /W:0 /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) {
                Die "robocopy failed for $d with exit code $LASTEXITCODE"
            }
        }
    }

    # Stage root node_modules (excluding workspace links in @veyyon and .cache)
    $srcNm = Join-Path $RepoRoot "node_modules"
    $dstNm = Join-Path $stageRepo "node_modules"
    if (Test-Path $srcNm) {
        if (-not (Test-Path $dstNm)) {
            New-Item -ItemType Directory -Path $dstNm -Force | Out-Null
        }
        & robocopy $srcNm $dstNm /E /XJ /MT:32 /R:0 /W:0 /NFL /NDL /NJH /NJS /NC /NS /NP /XD "@veyyon" ".cache" | Out-Null
        if ($LASTEXITCODE -ge 8) {
            Die "robocopy failed for node_modules with exit code $LASTEXITCODE"
        }
    }

    # Rebuild workspace aliases from staged package manifests rather than host shared-store target paths
    $stagedRootPkgPath = Join-Path $stageRepo "package.json"
    if ((Test-Path -LiteralPath $dstNm) -and (Test-Path -LiteralPath $stagedRootPkgPath)) {
        $stagedRootPkg = Get-Content -LiteralPath $stagedRootPkgPath -Raw | ConvertFrom-Json
        $wsPatterns = @()
        if ($stagedRootPkg.workspaces) {
            if ($stagedRootPkg.workspaces -is [System.Array]) {
                $wsPatterns = $stagedRootPkg.workspaces
            } elseif ($stagedRootPkg.workspaces.packages) {
                $wsPatterns = $stagedRootPkg.workspaces.packages
            }
        }
        $seenAliases = @{}
        foreach ($pat in $wsPatterns) {
            foreach ($wsDir in (Expand-WorkspacePattern $stageRepo ([string]$pat))) {
                $wsPkgPath = Join-Path $wsDir "package.json"
                if (-not (Test-Path -LiteralPath $wsPkgPath)) { continue }
                $wsPkg = Get-Content -LiteralPath $wsPkgPath -Raw | ConvertFrom-Json
                $pkgName = [string]$wsPkg.name
                if (-not $pkgName -or $seenAliases.ContainsKey($pkgName)) { continue }
                $seenAliases[$pkgName] = $true

                if ($pkgName.StartsWith("@") -and $pkgName.Contains("/")) {
                    $parts = $pkgName.Split("/", 2)
                    $scopeDir = Join-Path $dstNm $parts[0]
                    if (-not (Test-Path -LiteralPath $scopeDir)) {
                        New-Item -ItemType Directory -Path $scopeDir -Force | Out-Null
                    }
                    $linkPath = Join-Path $scopeDir $parts[1]
                } else {
                    $linkPath = Join-Path $dstNm $pkgName
                }

                if (Test-Path -LiteralPath $linkPath) {
                    $existingItem = Get-Item -LiteralPath $linkPath -Force
                    if ($existingItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                        [System.IO.Directory]::Delete($linkPath)
                    } else {
                        Remove-Item -LiteralPath $linkPath -Recurse -Force
                    }
                }

                cmd.exe /c "mklink /J ""$linkPath"" ""$wsDir""" | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    Die "mklink /J failed for workspace alias $pkgName -> $wsDir with exit code $LASTEXITCODE"
                }
            }
        }
    }

    # 6. Create a host-home sentinel file to prove denial
    $sentinelName = ".veyyon-sentinel-" + $uniqueId
    $sentinelPath = Join-Path $realHome $sentinelName
    Set-Content -Path $sentinelPath -Value "veyyon-secret-sentinel-$uniqueId" -Encoding utf8

    # 7. Generate in-container guest probe and runner script
    # The guest runner verifies that realHome and sentinelPath are completely unreadable
    # BEFORE setting VEYYON_TEST_SANDBOX and launching requested command.
    $guestProbeScript = Join-Path $sessionScratch "guest-entry.js"

    if ($actualCmdArgs.Length -eq 0) {
        $actualCmdArgs = @("bun", "test")
    }

    # If first arg is 'bun', point to scratchBun
    if ($actualCmdArgs[0] -eq "bun" -or $actualCmdArgs[0] -eq "bun.exe") {
        $actualCmdArgs[0] = $scratchBun
    }

    # Remap test paths in arguments using strict directory boundary containment
    $remappedArgs = @()
    $repoRootNorm = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')
    foreach ($cmdArg in $actualCmdArgs) {
        $val = $cmdArg
        if ($val -match '^[A-Za-z]:[\\/]' -and (Test-IsUnderOrSame $val $repoRootNorm)) {
            $fullVal = [System.IO.Path]::GetFullPath($val).TrimEnd('\', '/')
            if ($fullVal.Equals($repoRootNorm, [System.StringComparison]::OrdinalIgnoreCase)) {
                $val = $stageRepo
            } else {
                $rel = $fullVal.Substring($repoRootNorm.Length).TrimStart('\', '/')
                $val = Join-Path $stageRepo $rel
            }
        }
        $remappedArgs += $val
    }

    # Pass command and args via JSON in scratch
    $cmdConfig = @{
        realHome = $realHome
        sentinelPath = $sentinelPath
        repoRoot = $stageRepo
        args = $remappedArgs
        marker = "windows-appcontainer"
    }
    $cmdJsonPath = Join-Path $sessionScratch "cmd-config.json"
    $jsonStr = $cmdConfig | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($cmdJsonPath, $jsonStr, [System.Text.UTF8Encoding]::new($false))
    $guestScriptSource = @'
const fs = require('node:fs');
const path = require('node:path');
const child_process = require('node:child_process');

const config = JSON.parse(fs.readFileSync(process.env.GUEST_CONFIG_PATH, 'utf8'));
const realHome = config.realHome;
const sentinelPath = config.sentinelPath;

// 1. In-container admission probe
// Verify real home enumeration is denied
let homeDenied = false;
try {
  fs.readdirSync(realHome);
} catch (e) {
  homeDenied = true;
}

if (!homeDenied) {
  console.error('[guest-entry] FATAL: real host home enumeration was NOT denied: ' + realHome);
  process.exit(126);
}
// Verify host .veyyon directory access is denied
const veyyonDir = path.join(realHome, '.veyyon');
let veyyonDenied = false;
try {
  fs.readdirSync(veyyonDir);
} catch (e) {
  veyyonDenied = true;
}

if (!veyyonDenied) {
  console.error('[guest-entry] FATAL: host .veyyon directory was NOT denied: ' + veyyonDir);
  process.exit(126);
}

// Verify host shared-auth directory access is denied
const sharedAuthDir = path.join(veyyonDir, 'shared-auth');
let sharedAuthDenied = false;
try {
  fs.readdirSync(sharedAuthDir);
} catch (e) {
  sharedAuthDenied = true;
}

if (!sharedAuthDenied) {
  console.error('[guest-entry] FATAL: host shared-auth directory was NOT denied: ' + sharedAuthDir);
  process.exit(126);
}


// Verify sentinel file read is denied
let sentinelDenied = false;
try {
  fs.readFileSync(sentinelPath, 'utf8');
} catch (e) {
  sentinelDenied = true;
}

if (!sentinelDenied) {
  console.error('[guest-entry] FATAL: real host sentinel file read was NOT denied: ' + sentinelPath);
  process.exit(126);
}

// 2. Set sandbox marker only after admission probe passes
process.env.VEYYON_TEST_SANDBOX = config.marker;
process.env.VEYYON_TEST_HOST_HOME = realHome;
process.env.VEYYON_TEST_HOST_SENTINEL = sentinelPath;

// 3. Execute requested test / command inheriting AppContainer token
const [exe, ...cmdArgs] = config.args;
// On Windows, child processes must inherit clean environment with redirected home
const childEnv = Object.assign({}, process.env);

const child = child_process.spawn(exe, cmdArgs, {
  cwd: config.repoRoot,
  stdio: 'inherit',
  env: childEnv,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code !== null ? code : 0);
});

child.on('error', (err) => {
  console.error('[guest-entry] spawn error:', err);
  process.exit(126);
});
'@
    [System.IO.File]::WriteAllText($guestProbeScript, $guestScriptSource, [System.Text.UTF8Encoding]::new($false))

    # Set up explicit whitelist environment dictionary (never inherit caller tokens/secrets/VEYYON markers)
    $cleanEnv = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $cleanEnv["SystemRoot"] = if ($env:SystemRoot) { $env:SystemRoot } else { "C:\Windows" }
    $cleanEnv["SystemDrive"] = if ($env:SystemDrive) { $env:SystemDrive } else { "C:" }
    $cleanEnv["windir"] = if ($env:windir) { $env:windir } else { "C:\Windows" }
    $cleanEnv["ComSpec"] = Join-Path $cleanEnv["SystemRoot"] "System32\cmd.exe"
    $cleanEnv["PATH"] = "$($cleanEnv['SystemRoot'])\System32;$($cleanEnv['SystemRoot']);$($cleanEnv['SystemRoot'])\System32\Wbem;$($cleanEnv['SystemRoot'])\System32\WindowsPowerShell\v1.0\;$sessionScratch"
    $cleanEnv["PATHEXT"] = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
    $cleanEnv["ProgramData"] = if ($env:ProgramData) { $env:ProgramData } else { "C:\ProgramData" }
    $cleanEnv["HOME"] = $guestHome
    $cleanEnv["USERPROFILE"] = $guestHome
    $cleanEnv["HOMEDRIVE"] = (Split-Path -Qualifier $guestHome)
    $cleanEnv["HOMEPATH"] = (Split-Path -NoQualifier $guestHome)
    $cleanEnv["APPDATA"] = $guestAppData
    $cleanEnv["LOCALAPPDATA"] = $guestLocalAppData
    $cleanEnv["TMP"] = $guestTmp
    $cleanEnv["TEMP"] = $guestTmp
    $cleanEnv["GUEST_CONFIG_PATH"] = $cmdJsonPath

    # Launch inside AppContainer
    $outLog = Join-Path $sessionScratch "guest_out.log"
    $launchCmd = 'cmd.exe /c ""' + $scratchBun + '" "' + $guestProbeScript + '" > "' + $outLog + '" 2>&1"'
    $timeoutMs = if ($TimeoutSec -gt 0) { $TimeoutSec * 1000 } else { 600000 }
    $exitCode = [AppContainerLauncher]::Launch(
        $pSid,
        "C:\Windows\System32\cmd.exe",
        $launchCmd,
        $stageRepo,
        $cleanEnv,
        $false,
        $true,
        $timeoutMs
    )

    if (Test-Path -LiteralPath $outLog) {
        $content = Get-Content -LiteralPath $outLog -Raw
        [Console]::Out.Write($content)
    }
} finally {
    # Lifecycle cleanup: delete only own sentinel, verify profile & scratch removal
    if ($sentinelPath -and (Test-Path -LiteralPath $sentinelPath)) {
        try {
            Remove-Item -LiteralPath $sentinelPath -Force -ErrorAction Stop
        } catch {
            Log-Message "cleanup error: failed to remove own sentinel '$sentinelPath': $($_.Exception.Message)"
            $cleanupFailed = $true
        }
    }
    if ($profileCreated) {
        try {
            [AppContainerLauncher]::DeleteProfile($profileName)
        } catch {
            Log-Message "cleanup error: failed to delete AppContainer profile '$profileName': $($_.Exception.Message)"
            $cleanupFailed = $true
        }
    }
    if (Test-Path -LiteralPath $sessionScratch) {
        try {
            Remove-Item -LiteralPath $sessionScratch -Recurse -Force -ErrorAction Stop
        } catch {
            Log-Message "cleanup error: failed to remove session scratch '$sessionScratch': $($_.Exception.Message)"
            $cleanupFailed = $true
        }
    }
}

if ($cleanupFailed -and $exitCode -eq 0) {
    exit 1
}
exit $exitCode
