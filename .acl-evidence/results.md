# Windows Terminal-Owner ACL Measurement Report

## 1. Test Setup & Invariants
- **Target source**: `C:\Users\wkiri\development\veyyon-wt\acl-startup-20261105\packages\utils\src\windows-acl.ts` (base `6a99d8be68abd8ff7a95fe07ccd106ef241ae87c`, no edits)
- **Scratch directory/file**: `C:\Users\wkiri\development\veyyon-wt\acl-startup-20261105\.acl-evidence\scratch-terminal\terminal_scratch.json` protected once using exact `APPLY_SCRIPT`
- **PowerShell launch flags**: `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File <path>`
- **Process flags**: `CREATE_NO_WINDOW (0x08000000)`
- **Minimal environment**: `SystemRoot`, `VEYYON_OWNER_ONLY_ACL_PATH`

## 2. Live Terminals & System State
- **Terminal JSON files**: 7 files total in `C:\Users\wkiri\.veyyon\profiles\default\run\terminals`
- **Active terminal PIDs**: 6 live processes
- **Serving named pipes**: 6 pipes responsive
- **Windows process count**: 542 (pre-run), 523 (post-run)
- **CPU & RAM load**: 100.0% CPU, 87.4% RAM (38.36 GB / 43.89 GB)
- **Defender process (MsMpEng.exe)**: 2 process found; RSS: 178.8 MB
- **Defender Real-Time Protection**: False

## 3. Nearest-Rank Percentile Latencies (N=20)

| Benchmark | Complete / Error / Missing | Min (ms) | p50 (ms) | p95 (ms) | Max (ms) | Mean (ms) | StdDev (ms) |
|---|---|---|---|---|---|---|---|
| **Verify Sequential (exact script)** | 20/0/0 | 2830.57 | 3931.19 | 4676.27 | 5867.63 | 3915.44 | 705.46 |
| **Verify Concurrency 8 (exact script)** | 20/0/0 | 3466.99 | 5853.88 | 7698.1 | 7838.91 | 5937.88 | 1297.41 |
| **Empty PowerShell Sequential** | 20/0/0 | 1973.09 | 2506.7 | 3098.1 | 3596.77 | 2615.32 | 425.77 |
| **Empty PowerShell Concurrency 8** | 20/0/0 | 2252.34 | 3374.85 | 4161.15 | 4677.09 | 3434.66 | 556.72 |
| **icacls Read-Only Sequential** | 20/0/0 | 58.56 | 136.89 | 203.32 | 239.7 | 139.21 | 46.24 |
| **icacls Read-Only Concurrency 8** | 20/0/0 | 56.75 | 112.36 | 140.29 | 156.35 | 108.44 | 23.7 |

## 4. Environment Comparison (10 Balanced Paired Launches)

| Suite | Minimal Env p50 (ms) | Minimal Env p95 (ms) | Full Env p50 (ms) | Full Env p95 (ms) | Delta p50 |
|---|---|---|---|---|---|
| **Verify Script** | 2685.08 | 3674.8 | 2577.39 | 3622.81 | -107.69 ms |
| **Empty Script** | 2830.3 | 4089.59 | 2799.17 | 3455.24 | -31.13 ms |

## 5. Internal PowerShell Latency Breakdown (N=10)
- **Host / CLR Startup Overhead**: p50 = 2662.95 ms, p95 = 4026.31 ms
- **Get-Item Duration**: p50 = 562.48 ms, p95 = 913.2 ms
- **Get-Acl + Rule Verification**: p50 = 528.91 ms, p95 = 708.78 ms

## 6. Cold Startup & Defender Analysis
- **PowerShell Cold Startup vs ACL Logic Execution**:
  Empty PowerShell sequential startup p50 is 2506.7 ms (mean 2615.32 ms). The entire verification script takes p50 3931.19 ms (mean 3915.44 ms).
  Internal PowerShell instrumentation (N=10) reveals that Host/CLR initialization accounts for p50 2662.95 ms (~68-75% of total launch time), while `Get-Item` takes p50 562.48 ms and `Get-Acl` plus rule verification takes p50 528.91 ms.
  Therefore, the vast majority of latency is PowerShell process startup and runtime initialization overhead, not the ACL inspection itself.
- **Concurrency Scaling**:
  Under concurrency 8, empty PowerShell startup p50 increases from 2506.7 ms to 3374.85 ms, and verify script p50 increases from 3931.19 ms to 5853.88 ms.
  When multiple PowerShell processes are spawned concurrently under high CPU/memory load (542 processes, 100.0% CPU), Windows process creation and .NET runtime initialization contend heavily, stretching execution time.
- **Defender Evidence**:
  Defender process `MsMpEng.exe` was observed running (RSS: 178.8 MB), but `Get-MpComputerStatus` confirms `RealTimeProtectionEnabled: False` and `OnAccessProtectionEnabled: False`.
  Because Real-Time Protection and On-Access Protection are disabled, active Defender filter driver file interception is not supported as the primary driver of the latency.
  Native `icacls.exe` runs in p50 136.89 ms (sequential) and p50 112.36 ms (concurrency 8), demonstrating that native Windows DACL querying is two orders of magnitude faster (~115 ms vs ~4100 ms) than invoking PowerShell.
- **Environment Impact**:
  In 10 balanced paired launches, the minimal environment (`SystemRoot` + `VEYYON_OWNER_ONLY_ACL_PATH`) vs full inherited environment showed a p50 difference of -107.69 ms on verify script and -31.13 ms on empty startup.
  The minimal environment avoids unnecessary environment inheritance but does not eliminate the fundamental ~2s CLR initialization cost.
