# .acl-evidence/probe_true_exit.py
import subprocess
import time
import os
import json
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone

EVIDENCE_DIR = os.path.dirname(os.path.abspath(__file__))
SCRATCH_FILE = os.path.join(EVIDENCE_DIR, "scratch-terminal", "terminal_scratch.json")
VERIFY_SCRIPT = os.path.join(EVIDENCE_DIR, "verify_timestamped.ps1")
OUTPUT_JSON = os.path.join(EVIDENCE_DIR, "true_exit_probe_results.json")

# Win32 definitions
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]

def filetime_to_dt(ft):
    # 100ns intervals since Jan 1, 1601
    intervals = (ft.dwHighDateTime << 32) + ft.dwLowDateTime
    # Seconds from 1601 to 1970 is 11644473600
    epoch_seconds = (intervals - 116444736000000000) / 10000000.0
    return datetime.fromtimestamp(epoch_seconds, timezone.utc)

GetProcessTimes = kernel32.GetProcessTimes
GetProcessTimes.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(FILETIME),
    ctypes.POINTER(FILETIME),
    ctypes.POINTER(FILETIME),
    ctypes.POINTER(FILETIME)
]
GetProcessTimes.restype = wintypes.BOOL

WaitForSingleObject = kernel32.WaitForSingleObject
WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
WaitForSingleObject.restype = wintypes.DWORD

system_root = os.environ.get("SystemRoot", r"C:\Windows")
powershell_exe = os.path.join(system_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")

def run_single_probe(iteration):
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
        VERIFY_SCRIPT,
    ]
    env = {
        "SystemRoot": system_root,
        "VEYYON_OWNER_ONLY_ACL_PATH": SCRATCH_FILE,
    }

    t_spawn_start = time.perf_counter()
    spawn_start_utc = datetime.now(timezone.utc)

    # Launch subprocess with pipe
    proc = subprocess.Popen(
        cmd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=0x08000000, # CREATE_NO_WINDOW
    )
    t_spawn_end = time.perf_counter()
    spawn_end_utc = datetime.now(timezone.utc)
    spawn_call_ms = (t_spawn_end - t_spawn_start) * 1000.0

    # Wait for process exit using Win32 API directly on the OS process handle
    handle = int(proc._handle)
    WaitForSingleObject(handle, 0xFFFFFFFF)
    os_signaled_utc = datetime.now(timezone.utc)
    t_os_signaled = time.perf_counter()

    # Query kernel process times
    ft_create = FILETIME()
    ft_exit = FILETIME()
    ft_kernel = FILETIME()
    ft_user = FILETIME()
    success = GetProcessTimes(handle, ctypes.byref(ft_create), ctypes.byref(ft_exit), ctypes.byref(ft_kernel), ctypes.byref(ft_user))

    kernel_create_utc = filetime_to_dt(ft_create) if success else None
    kernel_exit_utc = filetime_to_dt(ft_exit) if success else None

    # Read output
    stdout, stderr = proc.communicate()
    t_communicate_end = time.perf_counter()
    communicate_end_utc = datetime.now(timezone.utc)

    # Parse PS_SCRIPT_END marker
    ps_end_utc = None
    for line in stdout.splitlines():
        if line.startswith("PS_SCRIPT_END:"):
            ps_end_str = line.split(":", 1)[1].strip()
            try:
                ps_end_utc = datetime.fromisoformat(ps_end_str.replace("Z", "+00:00"))
            except Exception:
                pass

    # Deltas
    # 1. Total wall clock (spawn start to communicate end)
    total_wall_ms = (t_communicate_end - t_spawn_start) * 1000.0
    # 2. Kernel lifetime (CreationTime to ExitTime)
    kernel_lifetime_ms = (kernel_exit_utc - kernel_create_utc).total_seconds() * 1000.0 if (kernel_create_utc and kernel_exit_utc) else None
    # 3. Process rundown delay: time from PS script end to true OS exit
    ps_rundown_delay_ms = (kernel_exit_utc - ps_end_utc).total_seconds() * 1000.0 if (kernel_exit_utc and ps_end_utc) else None
    # 4. Communicator/buffer drainage after OS exit
    buffer_drain_ms = (communicate_end_utc - kernel_exit_utc).total_seconds() * 1000.0 if kernel_exit_utc else None

    return {
        "iteration": iteration,
        "pid": proc.pid,
        "spawn_call_ms": round(spawn_call_ms, 2),
        "total_wall_ms": round(total_wall_ms, 2),
        "kernel_lifetime_ms": round(kernel_lifetime_ms, 2) if kernel_lifetime_ms is not None else None,
        "ps_script_to_os_exit_rundown_ms": round(ps_rundown_delay_ms, 2) if ps_rundown_delay_ms is not None else None,
        "os_exit_to_drain_ms": round(buffer_drain_ms, 2) if buffer_drain_ms is not None else None,
        "timestamps_utc": {
            "spawn_start": spawn_start_utc.isoformat(),
            "spawn_end": spawn_end_utc.isoformat(),
            "kernel_creation": kernel_create_utc.isoformat() if kernel_create_utc else None,
            "ps_script_end": ps_end_utc.isoformat() if ps_end_utc else None,
            "kernel_exit": kernel_exit_utc.isoformat() if kernel_exit_utc else None,
            "os_signaled": os_signaled_utc.isoformat(),
            "communicate_end": communicate_end_utc.isoformat(),
        },
        "stdout_tail": [l for l in stdout.splitlines() if not l.startswith("PS_SCRIPT_END")],
        "exit_code": proc.returncode,
    }

def main():
    print("Running true OS exit probe (3 iterations)...")
    runs = []
    for i in range(1, 4):
        res = run_single_probe(i)
        runs.append(res)
        print(f"  Iteration {i}: spawn_call={res['spawn_call_ms']}ms, kernel_lifetime={res['kernel_lifetime_ms']}ms, "
              f"ps_to_os_exit_rundown={res['ps_script_to_os_exit_rundown_ms']}ms, drain={res['os_exit_to_drain_ms']}ms, "
              f"total={res['total_wall_ms']}ms")

    output_data = {
        "description": "Timestamp probe measuring baseline ACL spawn call, PS script completion, true OS kernel exit (GetProcessTimes), and pipe drainage.",
        "limitations": "This independent scratch probe measures execution in an isolated runner process. It cannot retroactively inspect the event loop state, synchrony stalls, or scheduling queues of the original incident caller process.",
        "runs": runs
    }

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(output_data, f, indent=2)

    print(f"Results written to {OUTPUT_JSON}")

if __name__ == "__main__":
    main()
