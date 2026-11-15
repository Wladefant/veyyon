import json
import math
import os
import re
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

import psutil

EVIDENCE_DIR = os.path.abspath(os.path.dirname(__file__))
OUTPUT_JSON = os.path.join(EVIDENCE_DIR, "host-pressure.json")
OUTPUT_MD = os.path.join(EVIDENCE_DIR, "host-pressure.md")

CREATE_NO_WINDOW = 0x08000000

def redact_command_line(cmdline: str) -> str:
    if not cmdline:
        return ""
    # Redact GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
    redacted = re.sub(r"gh[pousr]_[A-Za-z0-9_]{16,}", "[REDACTED_GH_TOKEN]", cmdline)
    # Redact JWT tokens
    redacted = re.sub(r"ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", "[REDACTED_JWT]", redacted)
    # Redact bearer tokens
    redacted = re.sub(r"(?i)bearer\s+[A-Za-z0-9_\-\.]{12,}", "Bearer [REDACTED]", redacted)
    # Redact common key/secret flags: --token <val>, --token=<val>, --key <val>, --password <val>, --secret <val>
    redacted = re.sub(r"(?i)(--(?:token|key|password|secret|auth|apikey|pass)\s*[=:]\s*)[^\s]+", r"\1[REDACTED]", redacted)
    redacted = re.sub(r"(?i)(--(?:token|key|password|secret|auth|apikey|pass)\s+)[^\s]+", r"\1[REDACTED]", redacted)
    # Redact session tokens or auth-like hex/alphanumeric strings (>32 chars)
    redacted = re.sub(r"(?i)(session[_-]?token[=:\s]+)[A-Za-z0-9_\-]{20,}", r"\1[REDACTED]", redacted)
    # Redact bitwarden session keys / tokens
    redacted = re.sub(r"(?i)(BW_SESSION[=:\s]+)[^\s]+", r"\1[REDACTED]", redacted)
    # Redact AWS/Cloudflare/Supabase secret keys
    redacted = re.sub(r"(?i)(sbp_[A-Za-z0-9_]{20,})", "[REDACTED_SUPABASE_KEY]", redacted)
    redacted = re.sub(r"(?i)(cf_key_[A-Za-z0-9_]{16,})", "[REDACTED_CF_KEY]", redacted)
    return redacted

def classify_process(name: str, cmdline: str) -> str:
    lower_name = (name or "").lower()
    lower_cmd = (cmdline or "").lower()

    # 1. build_slot
    if "build_slot.py" in lower_cmd or "build-slot" in lower_cmd or "build_slot" in lower_cmd:
        return "build_slot"

    # 2. tests
    if any(k in lower_cmd for k in ("vitest", "pytest", "jest", "mocha", "test_runner", "-m unittest", "test.mjs")):
        return "tests"

    # 3. veyyon lanes
    if any(k in lower_cmd for k in ("veyyon", "aclstartup", "claudex", "super-board", "claude-p", "claude -p", "profiles/default", "profiles\\default")):
        return "veyyon lanes"
    if "veyyon" in lower_name:
        return "veyyon lanes"

    # 4. browsers
    if any(b in lower_name for b in ("chrome.exe", "msedge.exe", "brave.exe", "firefox.exe", "chromium.exe")):
        return "browsers"
    if "headless" in lower_cmd or "puppeteer" in lower_cmd:
        return "browsers"

    # 5. node/bun
    if lower_name in ("node.exe", "bun.exe"):
        return "node/bun"

    # 6. other
    return "other"

def run_powershell_snapshot(script_path: str) -> Optional[Dict[str, Any]]:
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    powershell_exe = os.path.join(system_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    cmd = [
        powershell_exe,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        script_path,
    ]
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=CREATE_NO_WINDOW,
        )
        if res.stdout.strip():
            return json.loads(res.stdout.strip())
    except Exception as e:
        print(f"PowerShell snapshot warning: {e}", file=sys.stderr)
    return None

def main():
    print("=== Host Pressure Measurement (Two Samples, 30s Interval) ===")

    # Write ps1 helper for snapshot if needed
    ps1_helper = os.path.join(EVIDENCE_DIR, "host_pressure_snapshot.ps1")
    with open(ps1_helper, "w", encoding="utf-8") as f:
        f.write("""$ErrorActionPreference = 'SilentlyContinue'
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os = Get-CimInstance Win32_OperatingSystem
[PSCustomObject]@{
    CpuLoadPercent = $cpu
    FreePhysicalMemoryKB = $os.FreePhysicalMemory
    TotalVisibleMemorySizeKB = $os.TotalVisibleMemorySize
    ProcessCount = (Get-Process).Count
} | ConvertTo-Json -Compress
""")

    # Sample 1 at t=0
    print("Capturing Sample 1 at t=0s...")
    t0_time = time.time()
    vmem1 = psutil.virtual_memory()
    procs_sample1 = {}

    # Initialize CPU measurement per process
    for p in psutil.process_iter(["pid", "name", "cmdline", "memory_info", "create_time"]):
        try:
            pid = p.info["pid"]
            # Calling cpu_percent(interval=None) primes the counter
            p.cpu_percent(interval=None)
            cmd = " ".join(p.info["cmdline"] or []) if p.info.get("cmdline") else ""
            procs_sample1[pid] = {
                "proc": p,
                "name": p.info["name"] or "",
                "cmdline": cmd,
                "create_time": p.info.get("create_time"),
            }
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    ps_snap1 = run_powershell_snapshot(ps1_helper)

    interval_sec = 30.0
    print(f"Waiting {interval_sec} seconds for interval measurement...")
    time.sleep(interval_sec)

    # Sample 2 at t=30s
    print("Capturing Sample 2 at t=30s...")
    t1_time = time.time()
    elapsed = t1_time - t0_time
    vmem2 = psutil.virtual_memory()
    ps_snap2 = run_powershell_snapshot(ps1_helper)

    # Read CPU percent and memory for all live processes
    records = []
    num_cpus = psutil.cpu_count(logical=True) or 1

    for pid, info in procs_sample1.items():
        proc = info["proc"]
        try:
            cpu_pct = proc.cpu_percent(interval=None)
            mem = proc.memory_info()
            rss_mb = round(mem.rss / (1024 * 1024), 2)
            vms_mb = round(mem.vms / (1024 * 1024), 2)
            raw_cmd = info["cmdline"]
            redacted_cmd = redact_command_line(raw_cmd)
            group = classify_process(info["name"], raw_cmd)

            records.append({
                "pid": pid,
                "name": info["name"],
                "interval_cpu_percent": round(cpu_pct, 2),
                "working_set_mb": rss_mb,
                "vms_mb": vms_mb,
                "group": group,
                "command_line": redacted_cmd,
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    # Sort and rank
    by_cpu = sorted(records, key=lambda r: r["interval_cpu_percent"], reverse=True)
    by_mem = sorted(records, key=lambda r: r["working_set_mb"], reverse=True)

    top15_cpu = by_cpu[:15]
    top15_mem = by_mem[:15]

    # Group summaries
    groups = {}
    for r in records:
        g = r["group"]
        if g not in groups:
            groups[g] = {"process_count": 0, "total_cpu_percent": 0.0, "total_working_set_mb": 0.0, "pids": []}
        groups[g]["process_count"] += 1
        groups[g]["total_cpu_percent"] += r["interval_cpu_percent"]
        groups[g]["total_working_set_mb"] += r["working_set_mb"]
        groups[g]["pids"].append(r["pid"])

    for g in groups:
        groups[g]["total_cpu_percent"] = round(groups[g]["total_cpu_percent"], 2)
        groups[g]["total_working_set_mb"] = round(groups[g]["total_working_set_mb"], 2)

    total_procs = len(records)
    total_cpu_sum = round(sum(r["interval_cpu_percent"] for r in records), 2)
    total_mem_sum = round(sum(r["working_set_mb"] for r in records), 2)

    data = {
        "timestamp_start": t0_time,
        "timestamp_end": t1_time,
        "actual_interval_seconds": round(elapsed, 2),
        "host_summary": {
            "logical_cpus": num_cpus,
            "sample1_ram_percent": vmem1.percent,
            "sample1_ram_used_gb": round(vmem1.used / (1024**3), 2),
            "sample2_ram_percent": vmem2.percent,
            "sample2_ram_used_gb": round(vmem2.used / (1024**3), 2),
            "total_ram_gb": round(vmem2.total / (1024**3), 2),
            "powershell_snapshot_sample1": ps_snap1,
            "powershell_snapshot_sample2": ps_snap2,
            "tracked_processes": total_procs,
            "sum_interval_cpu_percent": total_cpu_sum,
            "sum_working_set_mb": total_mem_sum,
        },
        "group_summary": groups,
        "top15_cpu": top15_cpu,
        "top15_working_set": top15_mem,
    }

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    # Markdown report
    md_lines = [
        "# Windows Host Pressure & Resource Utilization Report",
        "",
        f"- **Sampling Interval**: {round(elapsed, 1)} seconds (two snapshots 30s apart)",
        f"- **Host RAM**: {vmem2.percent}% used ({round(vmem2.used / (1024**3), 2)} GB / {round(vmem2.total / (1024**3), 2)} GB)",
        f"- **Live Processes Tracked**: {total_procs}",
        f"- **PowerShell CPU Load reading**: {ps_snap2.get('CpuLoadPercent', 'unknown')}%",
        "",
        "## Process Groups Summary",
        "",
        "| Group | Process Count | Sum Interval CPU (%) | Total Working Set (MB) |",
        "|---|---|---|---|",
    ]
    for gname in ("veyyon lanes", "node/bun", "browsers", "build_slot", "tests", "other"):
        if gname in groups:
            ginfo = groups[gname]
            md_lines.append(f"| **{gname}** | {ginfo['process_count']} | {ginfo['total_cpu_percent']}% | {ginfo['total_working_set_mb']} MB |")
        else:
            md_lines.append(f"| **{gname}** | 0 | 0.0% | 0.0 MB |")

    md_lines.extend([
        "",
        "## Top 15 Processes by Interval CPU",
        "",
        "| PID | Name | Group | Interval CPU (%) | Working Set (MB) | Command Line (Redacted) |",
        "|---|---|---|---|---|---|",
    ])
    for p in top15_cpu:
        cmd_short = p["command_line"][:90] + ("…" if len(p["command_line"]) > 90 else "")
        md_lines.append(f"| {p['pid']} | `{p['name']}` | {p['group']} | {p['interval_cpu_percent']}% | {p['working_set_mb']} MB | `{cmd_short}` |")

    md_lines.extend([
        "",
        "## Top 15 Processes by Working Set (Memory)",
        "",
        "| PID | Name | Group | Working Set (MB) | Interval CPU (%) | Command Line (Redacted) |",
        "|---|---|---|---|---|---|",
    ])
    for p in top15_mem:
        cmd_short = p["command_line"][:90] + ("…" if len(p["command_line"]) > 90 else "")
        md_lines.append(f"| {p['pid']} | `{p['name']}` | {p['group']} | {p['working_set_mb']} MB | {p['interval_cpu_percent']}% | `{cmd_short}` |")

    with open(OUTPUT_MD, "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines) + "\n")

    print(f"Host pressure data saved to: {OUTPUT_JSON}")
    print(f"Host pressure markdown report saved to: {OUTPUT_MD}")

if __name__ == "__main__":
    main()
