# Windows Host Pressure & Resource Utilization Report

## 1. Overview & Timestamps
- **Sample 1 UTC**: `2026-11-05T08:43:06.24Z`
  - RAM used: `36.16 GB` / `43.89 GB` (`82.4%`)
  - Free physical memory: `8,545,820 KB`
  - PowerShell LoadPercentage: `66%`
- **Sample 2 UTC**: `2026-11-05T08:43:50.08Z`
  - RAM used: `35.34 GB` / `43.89 GB` (`80.5%`)
  - Free physical memory: `8,438,132 KB`
  - PowerShell LoadPercentage: `100%`
- **Actual Sampling Interval**: `43.85 seconds`
- **CPU Denominator**: `16 logical cores` (AMD Ryzen 7 5700G, 8C/16T). Total capacity: `1600.0%`.
- **Active Consumer CPU Sum**: `739.5%` across 16 cores (normalized machine load: `46.22%`).
  *(Excludes System Idle Process PID 0 which reported 116.9% idle)*
- **Live Processes Tracked**: `461`

## 2. Process Groups Summary (Reclassified)
*Note: `ego.exe` and its renderer subprocesses are classified as `browsers`.*

| Group | Process Count | Sum Interval CPU (%) | Total Working Set (MB) | Description |
|---|---|---|---|---|
| **veyyon lanes** | 86 | 428.8% | 13,360.63 MB | Active Veyyon agent sessions and daemon brokers |
| **browsers** | 57 | 45.9% | 4,285.80 MB | Chrome, Edge, and Citro Labs Ego browser processes |
| **other** | 300 | 264.8% | 19,248.88 MB | System services, Windows Explorer, Telegram, WSL, etc. |
| **node/bun** | 6 | 0.3% | 462.80 MB | Standalone Node/Bun tools outside lanes |
| **build_slot** | 2 | 0.2% | 39.37 MB | Build slot arbiter and queue manager |
| **tests** | 10 | 0.0% | 447.59 MB | Background test harnesses |

## 3. Top Active CPU Consumers (Excluding System Idle Process)

| PID | Name | Group | Interval CPU (%) | Working Set (MB) | Command Line (Redacted) |
|---|---|---|---|---|---|
| 15968 | `veyyon.exe` | veyyon lanes | 130.2% | 3,692.91 MB | `C:\Users\wkiri\AppData\Local\veyyon\veyyon.exe --profile default --resume [REDACTED]` |
| 5052 | `veyyon.exe` | veyyon lanes | 101.8% | 1,688.00 MB | `C:\Users\wkiri\AppData\Local\veyyon\veyyon.exe` |
| 24932 | `veyyon.exe` | veyyon lanes | 69.8% | 38.12 MB | `C:\Users\wkiri\AppData\Local\veyyon\veyyon.exe __veyyon_worker_daemon_broker` |
| 4 | `System` | other | 65.2% | 0.17 MB | `System NT Kernel` |
| 12076 | `herdr.exe` | other | 44.1% | 58.18 MB | `C:\Users\wkiri\.herdr\packages\standalone\releases\...\herdr.exe` |
| 12144 | `ego.exe` | browsers | 37.0% | 615.21 MB | `C:\Program Files\Citro Labs\ego lite\Application\ego.exe [REDACTED]` |
| 30744 | `vmmemWSL` | other | 35.4% | 1,177.78 MB | `WSL2 Virtual Machine Engine` |
| 4204 | `veyyon.exe` | veyyon lanes | 30.7% | 1,627.15 MB | `C:\Users\wkiri\AppData\Local\veyyon\veyyon.exe` |
| 31044 | `bun.exe` | veyyon lanes | 22.6% | 290.59 MB | `C:\Users\wkiri\.bun\bin\bun.exe ...\telegram\daemon\main.ts run` |
| 60168 | `Telegram.exe` | other | 20.6% | 620.45 MB | `C:\Program Files\WindowsApps\TelegramMessengerLLP...` |
| 21524 | `veyyon.exe` | veyyon lanes | 19.4% | 36.72 MB | `C:\Users\wkiri\AppData\Local\veyyon\veyyon.exe __veyyon_worker_daemon_broker` |
| 37472 | `pythonw.exe` | veyyon lanes | 15.9% | 131.13 MB | `C:\Users\wkiri\miniconda3\pythonw.exe ...\chatgpt_research.py` |
| 32692 | `python.exe` | other | 15.1% | 21.88 MB | `C:\Users\wkiri\miniconda3\python.EXE .acl-evidence/host_pressure.py` |
| 18532 | `veyyon.exe` | veyyon lanes | 12.9% | 1,799.55 MB | `C:\Users\wkiri\AppData\Local\veyyon\veyyon.exe` |

## 4. Root Cause Distinction & Findings
- **Correlation vs Causation**: Host CPU saturation and PowerShell startup overhead correlate with higher latency. However, because the 15-second timeout did not reproduce in the isolated event loop test harness (0/14 timed out; all finished in 2.68s to 3.81s), claiming that severe CPU saturation caused the specific 27.4s incident timeout remains an unverified inference.
