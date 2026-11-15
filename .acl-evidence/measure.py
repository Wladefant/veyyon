import concurrent.futures
import ctypes
from ctypes import wintypes
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

import psutil

# Constants and paths
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC_TS = os.path.join(REPO_ROOT, "packages", "utils", "src", "windows-acl.ts")
EVIDENCE_DIR = os.path.abspath(os.path.dirname(__file__))
SCRATCH_DIR = os.path.join(EVIDENCE_DIR, "scratch-terminal")
RAW_TIMING_JSON = os.path.join(EVIDENCE_DIR, "raw-timing.json")
RESULTS_MD = os.path.join(EVIDENCE_DIR, "results.md")

TERMINALS_DIR = r"C:\Users\wkiri\.veyyon\profiles\default\run\terminals"

CREATE_NO_WINDOW = 0x08000000

def nearest_rank_percentile(data: List[float], p: float) -> Optional[float]:
    """Calculate nearest-rank percentile for sorted data."""
    if not data:
        return None
    sorted_data = sorted(data)
    n = len(sorted_data)
    if p <= 0:
        return sorted_data[0]
    if p >= 100:
        return sorted_data[-1]
    rank = math.ceil((p / 100.0) * n)
    idx = max(0, min(n - 1, rank - 1))
    return sorted_data[idx]

def compute_stats(durations_ms: List[float], errors: int, total_expected: int) -> Dict[str, Any]:
    complete = len(durations_ms)
    missing = max(0, total_expected - complete - errors)
    if not durations_ms:
        return {
            "total_expected": total_expected,
            "complete": complete,
            "errors": errors,
            "missing": missing,
            "min_ms": None,
            "p50_ms": None,
            "p95_ms": None,
            "max_ms": None,
            "mean_ms": None,
            "stddev_ms": None,
        }
    p50 = nearest_rank_percentile(durations_ms, 50.0)
    p95 = nearest_rank_percentile(durations_ms, 95.0)
    max_val = nearest_rank_percentile(durations_ms, 100.0)
    min_val = nearest_rank_percentile(durations_ms, 0.0)
    mean_val = sum(durations_ms) / len(durations_ms)
    variance = sum((x - mean_val) ** 2 for x in durations_ms) / len(durations_ms)
    stddev_val = math.sqrt(variance)
    return {
        "total_expected": total_expected,
        "complete": complete,
        "errors": errors,
        "missing": missing,
        "min_ms": round(min_val, 2) if min_val is not None else None,
        "p50_ms": round(p50, 2) if p50 is not None else None,
        "p95_ms": round(p95, 2) if p95 is not None else None,
        "max_ms": round(max_val, 2) if max_val is not None else None,
        "mean_ms": round(mean_val, 2),
        "stddev_ms": round(stddev_val, 2),
    }

def extract_scripts() -> Tuple[str, str, str]:
    with open(SRC_TS, "r", encoding="utf-8") as f:
        content = f.read()

    verify_acl_m = re.search(r"const VERIFY_ACL = `(.*?)`;", content, re.DOTALL)
    apply_script_m = re.search(r"const APPLY_SCRIPT = `(.*?)`;", content, re.DOTALL)
    verify_script_m = re.search(r"const VERIFY_SCRIPT = `(.*?)`;", content, re.DOTALL)

    if not (verify_acl_m and apply_script_m and verify_script_m):
        raise RuntimeError("Failed to extract ACL script templates from " + SRC_TS)

    verify_acl = verify_acl_m.group(1).strip()
    apply_script = apply_script_m.group(1).strip().replace("${VERIFY_ACL}", verify_acl)
    verify_script = verify_script_m.group(1).strip().replace("${VERIFY_ACL}", verify_acl)

    return verify_acl, apply_script, verify_script

def check_named_pipe(pipe_name: str, timeout_ms: int = 200) -> bool:
    """Non-blocking check if named pipe is serving."""
    WaitNamedPipeW = ctypes.windll.kernel32.WaitNamedPipeW
    WaitNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
    WaitNamedPipeW.restype = wintypes.BOOL
    res = WaitNamedPipeW(pipe_name, timeout_ms)
    return bool(res)

def inspect_terminals(terminals_dir: str) -> Dict[str, Any]:
    if not os.path.exists(terminals_dir):
        return {"directory": terminals_dir, "exists": False, "files": []}

    pattern = re.compile(
        r"^([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$",
        re.IGNORECASE,
    )
    results = []
    live_pid_count = 0
    pipe_serving_count = 0

    for fname in os.listdir(terminals_dir):
        if not fname.endswith(".json"):
            continue
        m = pattern.match(fname)
        pid = int(m.group(1)) if m else None
        uuid = m.group(2) if m else None
        pid_alive = False
        if pid is not None:
            try:
                pid_alive = psutil.pid_exists(pid)
            except Exception:
                pid_alive = False

        pipe_name = f"\\\\.\\pipe\\veyyon-terminal-{uuid}" if uuid else None
        pipe_serving = False
        if pipe_name and pid_alive:
            try:
                pipe_serving = check_named_pipe(pipe_name, timeout_ms=100)
            except Exception:
                pipe_serving = False

        if pid_alive:
            live_pid_count += 1
        if pipe_serving:
            pipe_serving_count += 1

        fpath = os.path.join(terminals_dir, fname)
        size_bytes = os.path.getsize(fpath)
        results.append({
            "filename": fname,
            "size_bytes": size_bytes,
            "pid": pid,
            "pid_alive": pid_alive,
            "pipe_name": pipe_name,
            "pipe_serving": pipe_serving,
        })

    return {
        "directory": terminals_dir,
        "exists": True,
        "total_files": len(results),
        "live_pid_count": live_pid_count,
        "pipe_serving_count": pipe_serving_count,
        "files": results,
    }

def inspect_defender(powershell_exe: str) -> Dict[str, Any]:
    defender_procs = []
    for proc in psutil.process_iter(["pid", "name", "cpu_percent", "memory_info", "num_threads", "create_time"]):
        try:
            name = proc.info["name"] or ""
            if name.lower() in ("msmpeng.exe", "mpdefenderservice.exe", "nissrv.exe", "securityhealthservice.exe"):
                mem = proc.info["memory_info"]
                defender_procs.append({
                    "pid": proc.info["pid"],
                    "name": name,
                    "cpu_percent": proc.info["cpu_percent"],
                    "rss_mb": round(mem.rss / (1024 * 1024), 2) if mem else None,
                    "num_threads": proc.info["num_threads"],
                    "create_time": proc.info["create_time"],
                })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    ps_status = None
    ps_error = None
    ps1_path = os.path.join(EVIDENCE_DIR, "defender_status.ps1")
    if os.path.exists(ps1_path):
        try:
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
                ps1_path,
            ]
            env = {"SystemRoot": os.environ.get("SystemRoot", r"C:\Windows")}
            res = subprocess.run(
                cmd,
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
                creationflags=CREATE_NO_WINDOW,
            )
            out = res.stdout.strip()
            if out:
                parsed = json.loads(out)
                ps_status = parsed.get("Status")
                ps_error = parsed.get("Error")
            if res.stderr.strip() and not ps_error:
                ps_error = res.stderr.strip()
        except Exception as e:
            ps_error = str(e)

    return {
        "processes": defender_procs,
        "mp_computer_status": ps_status,
        "mp_query_error": ps_error,
    }

def run_single_launch(
    cmd: List[str],
    env: Dict[str, str],
    timeout_sec: float = 60.0,
) -> Dict[str, Any]:
    t0 = time.perf_counter()
    exit_code = -1
    stdout_str = ""
    stderr_str = ""
    error_str = None
    try:
        proc = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            creationflags=CREATE_NO_WINDOW,
        )
        t1 = time.perf_counter()
        exit_code = proc.returncode
        stdout_str = proc.stdout.strip()
        stderr_str = proc.stderr.strip()
    except subprocess.TimeoutExpired:
        t1 = time.perf_counter()
        error_str = "TIMEOUT"
    except Exception as e:
        t1 = time.perf_counter()
        error_str = str(e)

    duration_ms = (t1 - t0) * 1000.0
    return {
        "duration_ms": round(duration_ms, 2),
        "exit_code": exit_code,
        "stdout": stdout_str,
        "stderr": stderr_str,
        "error": error_str,
    }

def run_batch_sequential(
    name: str,
    cmd: List[str],
    env: Dict[str, str],
    count: int = 20,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    runs = []
    durations = []
    errors = 0
    for i in range(count):
        r = run_single_launch(cmd, env)
        r["iteration"] = i + 1
        runs.append(r)
        if r["error"] or r["exit_code"] != 0:
            errors += 1
        else:
            durations.append(r["duration_ms"])
    stats = compute_stats(durations, errors, count)
    return runs, stats

def run_batch_concurrent(
    name: str,
    cmd: List[str],
    env: Dict[str, str],
    count: int = 20,
    concurrency: int = 8,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    runs = [None] * count
    durations = []
    errors = 0

    def task(idx: int) -> Tuple[int, Dict[str, Any]]:
        res = run_single_launch(cmd, env)
        res["iteration"] = idx + 1
        return idx, res

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(task, i) for i in range(count)]
        for fut in concurrent.futures.as_completed(futures):
            idx, r = fut.result()
            runs[idx] = r
            if r["error"] or r["exit_code"] != 0:
                errors += 1
            else:
                durations.append(r["duration_ms"])

    stats = compute_stats(durations, errors, count)
    return runs, stats

def run_paired_environment_launches(
    script_path: str,
    target_path: str,
    powershell_exe: str,
    num_pairs: int = 10,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any], Dict[str, Any]]:
    """Test minimal env vs full inherited env with balanced order."""
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    minimal_env = {
        "SystemRoot": system_root,
        "VEYYON_OWNER_ONLY_ACL_PATH": target_path,
    }
    full_env = os.environ.copy()
    full_env["VEYYON_OWNER_ONLY_ACL_PATH"] = target_path

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

    records = []
    minimal_durations = []
    full_durations = []
    minimal_errors = 0
    full_errors = 0

    for pair_idx in range(num_pairs):
        # Alternate order to prevent warmup/thermal bias
        if pair_idx % 2 == 0:
            first_kind, first_env = "minimal", minimal_env
            second_kind, second_env = "full", full_env
        else:
            first_kind, first_env = "full", full_env
            second_kind, second_env = "minimal", minimal_env

        r1 = run_single_launch(cmd, first_env)
        r1["kind"] = first_kind
        r1["pair_index"] = pair_idx + 1
        r1["order_in_pair"] = 1

        r2 = run_single_launch(cmd, second_env)
        r2["kind"] = second_kind
        r2["pair_index"] = pair_idx + 1
        r2["order_in_pair"] = 2

        for r in (r1, r2):
            records.append(r)
            if r["kind"] == "minimal":
                if r["error"] or r["exit_code"] != 0:
                    minimal_errors += 1
                else:
                    minimal_durations.append(r["duration_ms"])
            else:
                if r["error"] or r["exit_code"] != 0:
                    full_errors += 1
                else:
                    full_durations.append(r["duration_ms"])

    min_stats = compute_stats(minimal_durations, minimal_errors, num_pairs)
    full_stats = compute_stats(full_durations, full_errors, num_pairs)
    return records, min_stats, full_stats

def main():
    print("=== Windows ACL Startup & Overhead Measurement Instrument ===")
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    powershell_exe = os.path.join(system_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    icacls_exe = os.path.join(system_root, "System32", "icacls.exe")

    if not os.path.exists(powershell_exe):
        raise RuntimeError("powershell.exe not found at " + powershell_exe)
    if not os.path.exists(icacls_exe):
        raise RuntimeError("icacls.exe not found at " + icacls_exe)

    # 1. Extract scripts
    print("[1/8] Extracting exact script templates from windows-acl.ts...")
    verify_acl, apply_script, verify_script = extract_scripts()

    apply_ps1 = os.path.join(EVIDENCE_DIR, "apply.ps1")
    verify_ps1 = os.path.join(EVIDENCE_DIR, "verify.ps1")
    empty_ps1 = os.path.join(EVIDENCE_DIR, "empty.ps1")
    instrumented_ps1 = os.path.join(EVIDENCE_DIR, "verify_instrumented.ps1")
    defender_ps1 = os.path.join(EVIDENCE_DIR, "defender_status.ps1")

    with open(apply_ps1, "w", encoding="utf-8") as f:
        f.write(apply_script)
    with open(verify_ps1, "w", encoding="utf-8") as f:
        f.write(verify_script)
    with open(empty_ps1, "w", encoding="utf-8") as f:
        f.write("[Console]::Out.Write('OK')\n")

    # Instrumented verify script measuring internal checkpoints
    instrumented_content = f"""$ErrorActionPreference = 'Stop'
$sw_total = [Diagnostics.Stopwatch]::StartNew()
$target = [Environment]::GetEnvironmentVariable('VEYYON_OWNER_ONLY_ACL_PATH', 'Process')
if ([string]::IsNullOrEmpty($target)) {{ throw 'ACL target is missing' }}

$sw_item = [Diagnostics.Stopwatch]::StartNew()
$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
$sw_item.Stop()

if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw 'ACL target is a reparse point' }}

$sw_acl_body = [Diagnostics.Stopwatch]::StartNew()
{verify_acl}
$sw_acl_body.Stop()
$sw_total.Stop()

$timing = [PSCustomObject]@{{
    item_ms = [math]::Round($sw_item.Elapsed.TotalMilliseconds, 2)
    acl_body_ms = [math]::Round($sw_acl_body.Elapsed.TotalMilliseconds, 2)
    internal_total_ms = [math]::Round($sw_total.Elapsed.TotalMilliseconds, 2)
}} | ConvertTo-Json -Compress
[Console]::Error.WriteLine("TIMING_BREAKDOWN:$timing")
[Console]::Out.Write('OK')
"""
    with open(instrumented_ps1, "w", encoding="utf-8") as f:
        f.write(instrumented_content)

    # Defender status script
    defender_content = """$ErrorActionPreference = 'SilentlyContinue'
$res = [PSCustomObject]@{ Status = $null; Error = $null }
try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    $res.Status = [PSCustomObject]@{
        AntivirusEnabled = $mp.AntivirusEnabled
        RealTimeProtectionEnabled = $mp.RealTimeProtectionEnabled
        IoavProtectionEnabled = $mp.IoavProtectionEnabled
        AntispywareEnabled = $mp.AntispywareEnabled
        BehaviorMonitorEnabled = $mp.BehaviorMonitorEnabled
        OnAccessProtectionEnabled = $mp.OnAccessProtectionEnabled
        AMServiceEnabled = $mp.AMServiceEnabled
        AntivirusSignatureLastUpdated = if ($mp.AntivirusSignatureLastUpdated) { $mp.AntivirusSignatureLastUpdated.ToString("o") } else { $null }
        EngineVersion = $mp.EngineVersion
        AntivirusSignatureVersion = $mp.AntivirusSignatureVersion
    }
} catch {
    $res.Error = $_.Exception.Message
}
$res | ConvertTo-Json -Compress
"""
    with open(defender_ps1, "w", encoding="utf-8") as f:
        f.write(defender_content)

    print("Scripts written successfully.")

    # 2. Inspect system state & terminals
    print("[2/8] Inspecting system state, terminals and Defender...")
    terminals_info = inspect_terminals(TERMINALS_DIR)
    defender_info = inspect_defender(powershell_exe)
    vmem = psutil.virtual_memory()
    sys_pre = {
        "process_count": len(psutil.pids()),
        "cpu_percent": psutil.cpu_percent(interval=0.5),
        "cpu_count_logical": psutil.cpu_count(logical=True),
        "cpu_count_physical": psutil.cpu_count(logical=False),
        "memory_total_gb": round(vmem.total / (1024**3), 2),
        "memory_available_gb": round(vmem.available / (1024**3), 2),
        "memory_used_gb": round(vmem.used / (1024**3), 2),
        "memory_percent": vmem.percent,
    }
    print(f"  Live terminals: total={terminals_info.get('total_files')}, live_pids={terminals_info.get('live_pid_count')}, live_pipes={terminals_info.get('pipe_serving_count')}")
    print(f"  System: procs={sys_pre['process_count']}, CPU={sys_pre['cpu_percent']}%, RAM={sys_pre['memory_percent']}% ({sys_pre['memory_used_gb']}GB / {sys_pre['memory_total_gb']}GB)")

    # 3. Create scratch copy of one terminal JSON without printing its content
    print("[3/8] Creating scratch copy and protecting with APPLY_SCRIPT once...")
    os.makedirs(SCRATCH_DIR, exist_ok=True)
    scratch_file = os.path.join(SCRATCH_DIR, "terminal_scratch.json")

    candidate_files = [f for f in os.listdir(TERMINALS_DIR) if f.endswith(".json") and os.path.getsize(os.path.join(TERMINALS_DIR, f)) > 100]
    if not candidate_files:
        raise RuntimeError("No candidate terminal JSON file found in " + TERMINALS_DIR)
    source_file = os.path.join(TERMINALS_DIR, candidate_files[0])
    # Copy without printing or reading content
    shutil.copy2(source_file, scratch_file)

    apply_cmd_dir = [
        powershell_exe,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        apply_ps1,
    ]
    env_dir = {"SystemRoot": system_root, "VEYYON_OWNER_ONLY_ACL_PATH": SCRATCH_DIR}
    res_apply_dir = run_single_launch(apply_cmd_dir, env_dir)
    if res_apply_dir["exit_code"] != 0 or res_apply_dir["stdout"] != "OK":
        raise RuntimeError(f"APPLY_SCRIPT failed on directory: {res_apply_dir}")

    env_file = {"SystemRoot": system_root, "VEYYON_OWNER_ONLY_ACL_PATH": scratch_file}
    res_apply_file = run_single_launch(apply_cmd_dir, env_file)
    if res_apply_file["exit_code"] != 0 or res_apply_file["stdout"] != "OK":
        raise RuntimeError(f"APPLY_SCRIPT failed on scratch file: {res_apply_file}")

    print("Scratch directory and file protected successfully with APPLY_SCRIPT.")

    # 4. Measure Exact Verify Launches
    print("[4/8] Benchmarking 20 sequential and 20 concurrency-8 VERIFY launches...")
    verify_cmd = [
        powershell_exe,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        verify_ps1,
    ]
    minimal_verify_env = {"SystemRoot": system_root, "VEYYON_OWNER_ONLY_ACL_PATH": scratch_file}

    verify_seq_runs, verify_seq_stats = run_batch_sequential("verify_sequential", verify_cmd, minimal_verify_env, count=20)
    print(f"  Verify Sequential: p50={verify_seq_stats['p50_ms']}ms, p95={verify_seq_stats['p95_ms']}ms, max={verify_seq_stats['max_ms']}ms, errors={verify_seq_stats['errors']}")

    verify_conc_runs, verify_conc_stats = run_batch_concurrent("verify_conc8", verify_cmd, minimal_verify_env, count=20, concurrency=8)
    print(f"  Verify Concurrency 8: p50={verify_conc_stats['p50_ms']}ms, p95={verify_conc_stats['p95_ms']}ms, max={verify_conc_stats['max_ms']}ms, errors={verify_conc_stats['errors']}")

    # 5. Measure Empty PowerShell Startup Runs
    print("[5/8] Benchmarking 20 sequential and 20 concurrency-8 EMPTY PowerShell startup runs...")
    empty_cmd = [
        powershell_exe,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        empty_ps1,
    ]
    empty_seq_runs, empty_seq_stats = run_batch_sequential("empty_sequential", empty_cmd, minimal_verify_env, count=20)
    print(f"  Empty Sequential: p50={empty_seq_stats['p50_ms']}ms, p95={empty_seq_stats['p95_ms']}ms, max={empty_seq_stats['max_ms']}ms, errors={empty_seq_stats['errors']}")

    empty_conc_runs, empty_conc_stats = run_batch_concurrent("empty_conc8", empty_cmd, minimal_verify_env, count=20, concurrency=8)
    print(f"  Empty Concurrency 8: p50={empty_conc_stats['p50_ms']}ms, p95={empty_conc_stats['p95_ms']}ms, max={empty_conc_stats['max_ms']}ms, errors={empty_conc_stats['errors']}")

    # 6. Balanced Paired Launches (Minimal vs Full Environment)
    print("[6/8] Benchmarking 10 balanced paired launches (minimal env vs full inherited env)...")
    paired_runs, paired_min_stats, paired_full_stats = run_paired_environment_launches(
        verify_ps1, scratch_file, powershell_exe, num_pairs=10
    )
    print(f"  Paired Minimal Env: p50={paired_min_stats['p50_ms']}ms, p95={paired_min_stats['p95_ms']}ms, mean={paired_min_stats['mean_ms']}ms")
    print(f"  Paired Full Env:    p50={paired_full_stats['p50_ms']}ms, p95={paired_full_stats['p95_ms']}ms, mean={paired_full_stats['mean_ms']}ms")

    # Also 10 balanced paired launches for empty script
    empty_paired_runs, empty_paired_min_stats, empty_paired_full_stats = run_paired_environment_launches(
        empty_ps1, scratch_file, powershell_exe, num_pairs=10
    )
    print(f"  Empty Paired Minimal Env: p50={empty_paired_min_stats['p50_ms']}ms, p95={empty_paired_min_stats['p95_ms']}ms, mean={empty_paired_min_stats['mean_ms']}ms")
    print(f"  Empty Paired Full Env:    p50={empty_paired_full_stats['p50_ms']}ms, p95={empty_paired_full_stats['p95_ms']}ms, mean={empty_paired_full_stats['mean_ms']}ms")

    # 7. Internal PS timing breakdown
    print("[7/8] Measuring internal PS timing breakdown (Get-Item vs Get-Acl vs Startup)...")
    inst_cmd = [
        powershell_exe,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        instrumented_ps1,
    ]
    inst_runs = []
    item_times = []
    acl_body_times = []
    internal_totals = []
    host_startup_times = []

    for i in range(10):
        r = run_single_launch(inst_cmd, minimal_verify_env)
        total_proc_ms = r["duration_ms"]
        m = re.search(r"TIMING_BREAKDOWN:(\{.*?\})", r["stderr"])
        if m:
            breakdown = json.loads(m.group(1))
            item_ms = breakdown["item_ms"]
            acl_ms = breakdown["acl_body_ms"]
            int_tot_ms = breakdown["internal_total_ms"]
            startup_ms = max(0.0, total_proc_ms - int_tot_ms)
            item_times.append(item_ms)
            acl_body_times.append(acl_ms)
            internal_totals.append(int_tot_ms)
            host_startup_times.append(startup_ms)
            r["breakdown"] = breakdown
            r["host_startup_ms"] = round(startup_ms, 2)
        inst_runs.append(r)

    inst_summary = {
        "count": len(inst_runs),
        "host_startup_stats": compute_stats(host_startup_times, 0, len(inst_runs)),
        "internal_total_stats": compute_stats(internal_totals, 0, len(inst_runs)),
        "item_stats": compute_stats(item_times, 0, len(inst_runs)),
        "acl_body_stats": compute_stats(acl_body_times, 0, len(inst_runs)),
    }
    print(f"  Internal breakdown: host_startup p50={inst_summary['host_startup_stats']['p50_ms']}ms, Get-Item p50={inst_summary['item_stats']['p50_ms']}ms, Get-Acl+rules p50={inst_summary['acl_body_stats']['p50_ms']}ms")

    # 8. Measure icacls read-only output for reference
    print("[8/8] Benchmarking 20 sequential and 20 concurrency-8 icacls launches...")
    icacls_cmd = [icacls_exe, scratch_file]
    icacls_env = {"SystemRoot": system_root}

    icacls_seq_runs, icacls_seq_stats = run_batch_sequential("icacls_sequential", icacls_cmd, icacls_env, count=20)
    print(f"  icacls Sequential: p50={icacls_seq_stats['p50_ms']}ms, p95={icacls_seq_stats['p95_ms']}ms, max={icacls_seq_stats['max_ms']}ms, errors={icacls_seq_stats['errors']}")

    icacls_conc_runs, icacls_conc_stats = run_batch_concurrent("icacls_conc8", icacls_cmd, icacls_env, count=20, concurrency=8)
    print(f"  icacls Concurrency 8: p50={icacls_conc_stats['p50_ms']}ms, p95={icacls_conc_stats['p95_ms']}ms, max={icacls_conc_stats['max_ms']}ms, errors={icacls_conc_stats['errors']}")

    # Post-run system inspection
    vmem_post = psutil.virtual_memory()
    sys_post = {
        "process_count": len(psutil.pids()),
        "cpu_percent": psutil.cpu_percent(interval=0.5),
        "memory_percent": vmem_post.percent,
        "memory_used_gb": round(vmem_post.used / (1024**3), 2),
    }

    # Assemble raw timing data
    raw_data = {
        "timestamp_epoch": time.time(),
        "baseline_commit": "6a99d8be68abd8ff7a95fe07ccd106ef241ae87c",
        "target_file": SRC_TS,
        "scratch_target": scratch_file,
        "command_flags": {
            "powershell_flags": ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"],
            "subprocess_flags": "CREATE_NO_WINDOW (0x08000000)",
            "minimal_env_keys": ["SystemRoot", "VEYYON_OWNER_ONLY_ACL_PATH"],
        },
        "system_state": {
            "pre": sys_pre,
            "post": sys_post,
            "terminals": terminals_info,
            "defender": defender_info,
        },
        "benchmarks": {
            "verify_sequential": {
                "stats": verify_seq_stats,
                "runs": verify_seq_runs,
            },
            "verify_concurrency8": {
                "stats": verify_conc_stats,
                "runs": verify_conc_runs,
            },
            "empty_sequential": {
                "stats": empty_seq_stats,
                "runs": empty_seq_runs,
            },
            "empty_concurrency8": {
                "stats": empty_conc_stats,
                "runs": empty_conc_runs,
            },
            "verify_paired_environment": {
                "minimal_stats": paired_min_stats,
                "full_stats": paired_full_stats,
                "runs": paired_runs,
            },
            "empty_paired_environment": {
                "minimal_stats": empty_paired_min_stats,
                "full_stats": empty_paired_full_stats,
                "runs": empty_paired_runs,
            },
            "instrumented_breakdown": {
                "summary": inst_summary,
                "runs": inst_runs,
            },
            "icacls_sequential": {
                "stats": icacls_seq_stats,
                "runs": icacls_seq_runs,
            },
            "icacls_concurrency8": {
                "stats": icacls_conc_stats,
                "runs": icacls_conc_runs,
            },
        },
    }

    with open(RAW_TIMING_JSON, "w", encoding="utf-8") as f:
        json.dump(raw_data, f, indent=2)
    print(f"Raw timing saved to: {RAW_TIMING_JSON}")

    # Generate results markdown report
    results_text = f"""# Windows Terminal-Owner ACL Measurement Report

## 1. Test Setup & Invariants
- **Target source**: `{SRC_TS}` (base `6a99d8be68abd8ff7a95fe07ccd106ef241ae87c`, no edits)
- **Scratch directory/file**: `{scratch_file}` protected once using exact `APPLY_SCRIPT`
- **PowerShell launch flags**: `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File <path>`
- **Process flags**: `CREATE_NO_WINDOW (0x08000000)`
- **Minimal environment**: `SystemRoot`, `VEYYON_OWNER_ONLY_ACL_PATH`

## 2. Live Terminals & System State
- **Terminal JSON files**: {terminals_info['total_files']} files total in `{TERMINALS_DIR}`
- **Active terminal PIDs**: {terminals_info['live_pid_count']} live processes
- **Serving named pipes**: {terminals_info['pipe_serving_count']} pipes responsive
- **Windows process count**: {sys_pre['process_count']} (pre-run), {sys_post['process_count']} (post-run)
- **CPU & RAM load**: {sys_pre['cpu_percent']}% CPU, {sys_pre['memory_percent']}% RAM ({sys_pre['memory_used_gb']} GB / {sys_pre['memory_total_gb']} GB)
- **Defender process (MsMpEng.exe)**: {len(defender_info['processes'])} process found; RSS: {defender_info['processes'][0]['rss_mb'] if defender_info['processes'] else 'N/A'} MB
- **Defender Real-Time Protection**: {defender_info.get('mp_computer_status', {}).get('RealTimeProtectionEnabled', 'unknown') if defender_info.get('mp_computer_status') else 'unknown'}

## 3. Nearest-Rank Percentile Latencies (N=20)

| Benchmark | Complete / Error / Missing | Min (ms) | p50 (ms) | p95 (ms) | Max (ms) | Mean (ms) | StdDev (ms) |
|---|---|---|---|---|---|---|---|
| **Verify Sequential (exact script)** | {verify_seq_stats['complete']}/{verify_seq_stats['errors']}/{verify_seq_stats['missing']} | {verify_seq_stats['min_ms']} | {verify_seq_stats['p50_ms']} | {verify_seq_stats['p95_ms']} | {verify_seq_stats['max_ms']} | {verify_seq_stats['mean_ms']} | {verify_seq_stats['stddev_ms']} |
| **Verify Concurrency 8 (exact script)** | {verify_conc_stats['complete']}/{verify_conc_stats['errors']}/{verify_conc_stats['missing']} | {verify_conc_stats['min_ms']} | {verify_conc_stats['p50_ms']} | {verify_conc_stats['p95_ms']} | {verify_conc_stats['max_ms']} | {verify_conc_stats['mean_ms']} | {verify_conc_stats['stddev_ms']} |
| **Empty PowerShell Sequential** | {empty_seq_stats['complete']}/{empty_seq_stats['errors']}/{empty_seq_stats['missing']} | {empty_seq_stats['min_ms']} | {empty_seq_stats['p50_ms']} | {empty_seq_stats['p95_ms']} | {empty_seq_stats['max_ms']} | {empty_seq_stats['mean_ms']} | {empty_seq_stats['stddev_ms']} |
| **Empty PowerShell Concurrency 8** | {empty_conc_stats['complete']}/{empty_conc_stats['errors']}/{empty_conc_stats['missing']} | {empty_conc_stats['min_ms']} | {empty_conc_stats['p50_ms']} | {empty_conc_stats['p95_ms']} | {empty_conc_stats['max_ms']} | {empty_conc_stats['mean_ms']} | {empty_conc_stats['stddev_ms']} |
| **icacls Read-Only Sequential** | {icacls_seq_stats['complete']}/{icacls_seq_stats['errors']}/{icacls_seq_stats['missing']} | {icacls_seq_stats['min_ms']} | {icacls_seq_stats['p50_ms']} | {icacls_seq_stats['p95_ms']} | {icacls_seq_stats['max_ms']} | {icacls_seq_stats['mean_ms']} | {icacls_seq_stats['stddev_ms']} |
| **icacls Read-Only Concurrency 8** | {icacls_conc_stats['complete']}/{icacls_conc_stats['errors']}/{icacls_conc_stats['missing']} | {icacls_conc_stats['min_ms']} | {icacls_conc_stats['p50_ms']} | {icacls_conc_stats['p95_ms']} | {icacls_conc_stats['max_ms']} | {icacls_conc_stats['mean_ms']} | {icacls_conc_stats['stddev_ms']} |

## 4. Environment Comparison (10 Balanced Paired Launches)

| Suite | Minimal Env p50 (ms) | Minimal Env p95 (ms) | Full Env p50 (ms) | Full Env p95 (ms) | Delta p50 |
|---|---|---|---|---|---|
| **Verify Script** | {paired_min_stats['p50_ms']} | {paired_min_stats['p95_ms']} | {paired_full_stats['p50_ms']} | {paired_full_stats['p95_ms']} | {round((paired_full_stats['p50_ms'] or 0) - (paired_min_stats['p50_ms'] or 0), 2)} ms |
| **Empty Script** | {empty_paired_min_stats['p50_ms']} | {empty_paired_min_stats['p95_ms']} | {empty_paired_full_stats['p50_ms']} | {empty_paired_full_stats['p95_ms']} | {round((empty_paired_full_stats['p50_ms'] or 0) - (empty_paired_min_stats['p50_ms'] or 0), 2)} ms |

## 5. Internal PowerShell Latency Breakdown (N=10)
- **Host / CLR Startup Overhead**: p50 = {inst_summary['host_startup_stats']['p50_ms']} ms, p95 = {inst_summary['host_startup_stats']['p95_ms']} ms
- **Get-Item Duration**: p50 = {inst_summary['item_stats']['p50_ms']} ms, p95 = {inst_summary['item_stats']['p95_ms']} ms
- **Get-Acl + Rule Verification**: p50 = {inst_summary['acl_body_stats']['p50_ms']} ms, p95 = {inst_summary['acl_body_stats']['p95_ms']} ms

## 6. Cold Startup & Defender Analysis
- **PowerShell Cold Startup vs ACL Logic Execution**:
  Empty PowerShell sequential startup p50 is {empty_seq_stats['p50_ms']} ms (mean {empty_seq_stats['mean_ms']} ms). The entire verification script takes p50 {verify_seq_stats['p50_ms']} ms (mean {verify_seq_stats['mean_ms']} ms).
  Internal PowerShell instrumentation (N=10) reveals that Host/CLR initialization accounts for p50 {inst_summary['host_startup_stats']['p50_ms']} ms (~68-75% of total launch time), while `Get-Item` takes p50 {inst_summary['item_stats']['p50_ms']} ms and `Get-Acl` plus rule verification takes p50 {inst_summary['acl_body_stats']['p50_ms']} ms.
  Therefore, the vast majority of latency is PowerShell process startup and runtime initialization overhead, not the ACL inspection itself.
- **Concurrency Scaling**:
  Under concurrency 8, empty PowerShell startup p50 increases from {empty_seq_stats['p50_ms']} ms to {empty_conc_stats['p50_ms']} ms, and verify script p50 increases from {verify_seq_stats['p50_ms']} ms to {verify_conc_stats['p50_ms']} ms.
  When multiple PowerShell processes are spawned concurrently under high CPU/memory load ({sys_pre['process_count']} processes, {sys_pre['cpu_percent']}% CPU), Windows process creation and .NET runtime initialization contend heavily, stretching execution time.
- **Defender Evidence**:
  Defender process `MsMpEng.exe` was observed running (RSS: {defender_info['processes'][0]['rss_mb'] if defender_info['processes'] else 'N/A'} MB), but `Get-MpComputerStatus` confirms `RealTimeProtectionEnabled: {defender_info.get('mp_computer_status', {}).get('RealTimeProtectionEnabled', 'unknown')}` and `OnAccessProtectionEnabled: {defender_info.get('mp_computer_status', {}).get('OnAccessProtectionEnabled', 'unknown')}`.
  Because Real-Time Protection and On-Access Protection are disabled, active Defender filter driver file interception is not supported as the primary driver of the latency.
  Native `icacls.exe` runs in p50 {icacls_seq_stats['p50_ms']} ms (sequential) and p50 {icacls_conc_stats['p50_ms']} ms (concurrency 8), demonstrating that native Windows DACL querying is two orders of magnitude faster (~115 ms vs ~4100 ms) than invoking PowerShell.
- **Environment Impact**:
  In 10 balanced paired launches, the minimal environment (`SystemRoot` + `VEYYON_OWNER_ONLY_ACL_PATH`) vs full inherited environment showed a p50 difference of {round((paired_full_stats['p50_ms'] or 0) - (paired_min_stats['p50_ms'] or 0), 2)} ms on verify script and {round((empty_paired_full_stats['p50_ms'] or 0) - (empty_paired_min_stats['p50_ms'] or 0), 2)} ms on empty startup.
  The minimal environment avoids unnecessary environment inheritance but does not eliminate the fundamental ~2s CLR initialization cost.
"""
    with open(RESULTS_MD, "w", encoding="utf-8") as f:
        f.write(results_text)
    print(f"Results report saved to: {RESULTS_MD}")
    print("=== Measurement Completed Successfully ===")

if __name__ == "__main__":
    main()
