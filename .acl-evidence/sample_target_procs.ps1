$ErrorActionPreference = "Continue"

$targetPids = @("18532", "15968", "5052", "24932")
$targetInts = @(18532, 15968, 5052, 24932)
$outputJson = "C:\Users\wkiri\development\veyyon-wt\acl-startup-20261105\.acl-evidence\target-procs-sample.json"

function Get-ProcSnapshot {
    param([int[]]$Pids)
    $res = @{}
    foreach ($p in $Pids) {
        $pKey = "$p"
        $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
        if ($proc) {
            $cpuTime = $null
            try { $cpuTime = $proc.TotalProcessorTime.TotalSeconds } catch {}
            $userTime = $null
            try { $userTime = $proc.UserProcessorTime.TotalSeconds } catch {}
            $privTime = $null
            try { $privTime = $proc.PrivilegedProcessorTime.TotalSeconds } catch {}
            $threads = $null
            try { $threads = $proc.Threads.Count } catch {}
            $ws = $null
            try { $ws = [math]::Round($proc.WorkingSet64 / 1MB, 2) } catch {}
            $name = $proc.ProcessName

            $res[$pKey] = [PSCustomObject]@{
                Pid = $p
                Name = $name
                Running = $true
                TotalCpuSeconds = $cpuTime
                UserCpuSeconds = $userTime
                PrivilegedCpuSeconds = $privTime
                ThreadCount = $threads
                WorkingSetMB = $ws
            }
        } else {
            $res[$pKey] = [PSCustomObject]@{
                Pid = $p
                Name = "UNKNOWN"
                Running = $false
                TotalCpuSeconds = $null
                UserCpuSeconds = $null
                PrivilegedCpuSeconds = $null
                ThreadCount = $null
                WorkingSetMB = $null
            }
        }
    }
    return $res
}

function Get-PsChildren {
    param([int[]]$ParentPids)
    $children = @()
    try {
        $allPs = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $allPs) {
            if ($ParentPids -contains [int]$p.ParentProcessId) {
                $children += [PSCustomObject]@{
                    Pid = [int]$p.ProcessId
                    ParentPid = [int]$p.ParentProcessId
                    Name = $p.Name
                    CreationDate = [string]$p.CreationDate
                }
            }
        }
    } catch {}
    return $children
}

$sample1Utc = (Get-Date).ToUniversalTime().ToString("o")
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$s1 = Get-ProcSnapshot -Pids $targetInts
$c1 = Get-PsChildren -ParentPids $targetInts

$observedChildren = @{}
foreach ($c in $c1) { $observedChildren["$($c.Pid)"] = $c }

$sleepRounds = 30
for ($i = 0; $i -lt $sleepRounds; $i++) {
    Start-Sleep -Seconds 1
    $currChildren = Get-PsChildren -ParentPids $targetInts
    foreach ($c in $currChildren) {
        $k = "$($c.Pid)"
        if (-not $observedChildren.ContainsKey($k)) {
            $observedChildren[$k] = $c
        }
    }
}

$sw.Stop()
$elapsedSec = [math]::Round($sw.Elapsed.TotalSeconds, 3)
$sample2Utc = (Get-Date).ToUniversalTime().ToString("o")
$s2 = Get-ProcSnapshot -Pids $targetInts

$deltaResults = @{}
foreach ($p in $targetInts) {
    $pKey = "$p"
    $p1 = $s1[$pKey]
    $p2 = $s2[$pKey]
    if ($p1.Running -and $p2.Running -and $p1.TotalCpuSeconds -ne $null -and $p2.TotalCpuSeconds -ne $null) {
        $cpuDelta = [math]::Round($p2.TotalCpuSeconds - $p1.TotalCpuSeconds, 3)
        $cpuCorePct = [math]::Round(($cpuDelta / $elapsedSec) * 100.0, 2)
        $cpu16CoreNormalized = [math]::Round($cpuCorePct / 16.0, 2)
        $deltaResults[$pKey] = [PSCustomObject]@{
            Pid = $p
            Name = $p2.Name
            Running = $true
            Sample1_Utc = $sample1Utc
            Sample2_Utc = $sample2Utc
            ElapsedSeconds = $elapsedSec
            CpuDeltaSeconds = $cpuDelta
            CpuCorePercent = $cpuCorePct
            Cpu16CoreNormalizedPercent = $cpu16CoreNormalized
            Sample1_ThreadCount = $p1.ThreadCount
            Sample2_ThreadCount = $p2.ThreadCount
            Sample1_WorkingSetMB = $p1.WorkingSetMB
            Sample2_WorkingSetMB = $p2.WorkingSetMB
        }
    } else {
        $deltaResults[$pKey] = [PSCustomObject]@{
            Pid = $p
            Running = ($p2.Running)
            ElapsedSeconds = $elapsedSec
            CpuDeltaSeconds = $null
            CpuCorePercent = $null
            Cpu16CoreNormalizedPercent = $null
            Sample1_ThreadCount = $p1.ThreadCount
            Sample2_ThreadCount = $p2.ThreadCount
            Sample1_WorkingSetMB = $p1.WorkingSetMB
            Sample2_WorkingSetMB = $p2.WorkingSetMB
        }
    }
}

$childrenList = @($observedChildren.Values)

$report = [PSCustomObject]@{
    TargetPids = $targetPids
    Sample1Utc = $sample1Utc
    Sample2Utc = $sample2Utc
    ActualElapsedSeconds = $elapsedSec
    DenominatorCores = 16
    ProcessDeltas = $deltaResults
    ObservedPsChildrenCount = $childrenList.Count
    ObservedPsChildren = $childrenList
}

$jsonStr = $report | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($outputJson, $jsonStr, [System.Text.Encoding]::UTF8)
Write-Output "Sampling complete. Results saved to $outputJson"
