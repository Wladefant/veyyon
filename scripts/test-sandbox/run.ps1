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
    $curr = [System.IO.Path]::GetFullPath($pathToCheck)
    while ($curr -and (Test-Path -LiteralPath $curr)) {
        $item = Get-Item -LiteralPath $curr -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            Die "Scratch path or ancestor is a junction/reparse point: $curr"
        }
        $parent = [System.IO.Path]::GetDirectoryName($curr)
        if (-not $parent -or $parent -eq $curr) {
            break
        }
        $curr = $parent
    }
}


# Parse custom arguments manually from $args to support '--' syntax seamlessly
$RepoRoot = $null
$ScratchRoot = $null
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
    New-Item -ItemType Directory -Path $sessionScratch -Force | Out-Null
} catch {
    Die "failed to allocate session scratch directory '$sessionScratch': $($_.Exception.Message)"
}

$pSid = [IntPtr]::Zero
$profileCreated = $false
$sentinelPath = $null

try {
    # 1. Create AppContainer Profile
    $sidStr = [AppContainerLauncher]::CreateProfile($profileName, [ref]$pSid)
    $profileCreated = $true
    Log-Message "Created AppContainer profile $profileName ($sidStr)"

    # 2. Grant AppContainer Package SID to sessionScratch with (OI)(CI)(F) BEFORE populating
    # This enables instant inheritance on all files copied or created subsequently without slow recursive icacls.
    $grantAcl = "*$sidStr`:(OI)(CI)(F)"
    & icacls $sessionScratch /grant $grantAcl /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Die "icacls grant on scratch failed with exit code $LASTEXITCODE"
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
    # Stage root configuration files (package.json, tsconfig.json, bunfig.toml, etc.)
    Get-ChildItem -Path $RepoRoot -File | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $stageRepo $_.Name) -Force
    }


    # Robocopy workspace trees (packages, plugins, contracts, kernel, hosts, clients, tests, apps, scripts)
    $workspaceDirs = @("packages", "plugins", "contracts", "kernel", "hosts", "clients", "tests", "apps", "scripts", "natives", "types")
    foreach ($d in $workspaceDirs) {
        $srcDir = Join-Path $RepoRoot $d
        if (Test-Path $srcDir) {
            $dstDir = Join-Path $stageRepo $d
            & robocopy $srcDir $dstDir /E /MT:32 /R:0 /W:0 /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
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

    # Setup workspace symlinks in staged node_modules (e.g. node_modules/argot, node_modules/@veyyon/*)
    if (Test-Path $srcNm) {
        # 1. Root-level workspace symlinks/junctions in node_modules (like argot, veybot-web)
        Get-ChildItem -Path $srcNm | Where-Object { $_.LinkType } | ForEach-Object {
            $t = $_.Target
            $targetPath = if ($t -is [array]) { $t[0] } else { $t }
            if ($targetPath) {
                $targetPath = $targetPath -replace '^\\\\\?\\', ''
                if (-not [System.IO.Path]::IsPathRooted($targetPath)) {
                    $targetPath = [System.IO.Path]::GetFullPath((Join-Path $srcNm $targetPath))
                }
                if ($targetPath.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $rel = $targetPath.Substring($RepoRoot.Length).TrimStart('\', '/')
                    $stagedTarget = Join-Path $stageRepo $rel
                    if (Test-Path $stagedTarget) {
                        $linkPath = Join-Path $dstNm $_.Name
                        if (-not (Test-Path $linkPath)) {
                            cmd.exe /c "mklink /J ""$linkPath"" ""$stagedTarget""" | Out-Null
                            if ($LASTEXITCODE -ne 0) {
                                Die "mklink /J failed for $linkPath with exit code $LASTEXITCODE"
                            }
                        }
                    }
                }
            }
        }

        # 2. Scoped workspace symlinks/junctions in node_modules/@veyyon
        $srcNmVeyyon = Join-Path $srcNm "@veyyon"
        $dstNmVeyyon = Join-Path $dstNm "@veyyon"
        if (Test-Path $srcNmVeyyon) {
            if (-not (Test-Path $dstNmVeyyon)) {
                New-Item -ItemType Directory -Path $dstNmVeyyon -Force | Out-Null
            }
            Get-ChildItem -Path $srcNmVeyyon | ForEach-Object {
                $t = $_.Target
                $targetPath = if ($t -is [array]) { $t[0] } else { $t }
                if ($targetPath) {
                    $targetPath = $targetPath -replace '^\\\\\?\\', ''
                    if (-not [System.IO.Path]::IsPathRooted($targetPath)) {
                        $targetPath = [System.IO.Path]::GetFullPath((Join-Path $srcNmVeyyon $targetPath))
                    }
                    if ($targetPath.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                        $rel = $targetPath.Substring($RepoRoot.Length).TrimStart('\', '/')
                        $stagedTarget = Join-Path $stageRepo $rel
                        if (Test-Path $stagedTarget) {
                            $linkPath = Join-Path $dstNmVeyyon $_.Name
                            if (-not (Test-Path $linkPath)) {
                                cmd.exe /c "mklink /J ""$linkPath"" ""$stagedTarget""" | Out-Null
                                if ($LASTEXITCODE -ne 0) {
                                    Die "mklink /J failed for $linkPath with exit code $LASTEXITCODE"
                                }
                            }
                        }
                    }
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

    # Remap test paths in arguments if they point to RepoRoot
    $remappedArgs = @()
    foreach ($cmdArg in $actualCmdArgs) {
        $val = $cmdArg
        if ($val.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $val = Join-Path $stageRepo $val.Substring($RepoRoot.Length).TrimStart('\')
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
    $exitCode = [AppContainerLauncher]::Launch(
        $pSid,
        "C:\Windows\System32\cmd.exe",
        $launchCmd,
        $stageRepo,
        $cleanEnv,
        $false,
        $true
    )

    if (Test-Path $outLog) {
        $content = Get-Content $outLog -Raw
        [Console]::Out.Write($content)
    }

    exit $exitCode
} finally {
    # Lifecycle cleanup
    if ($sentinelPath -and (Test-Path $sentinelPath)) {
    }
    if ($profileCreated) {
        [AppContainerLauncher]::DeleteProfile($profileName)
    }
    if (Test-Path $sessionScratch) {
        Remove-Item -Recurse -Force $sessionScratch -ErrorAction SilentlyContinue
    }
}
