#!/usr/bin/env python3
"""Cleanup artifact reservation markers (.artifact-id-<N>).

Implements guarded empty artifact-marker cleanup for issue #1057.
Safety invariants:
  1. Default dry-run mode (--dry-run or omitted --execute).
  2. Exact regex match: ^\.artifact-id-\d+$
  3. Only true empty directories (no files, no subdirectories).
  4. Never touch symlinks or reparse points (lstat checks).
  5. Under C:/Users/wkiri/.veyyon/profiles/*/agent/sessions/**.
  6. Skip entire session directories referenced by live Win32_Process command lines.
  7. Skip entire session directories held by active file locks (*.lock, *.lock.transition).
  8. Unreadable/uncertain process enumeration or directories fail closed (skip as live/uncertain).
  9. Enforce age threshold (>24 hours by default).
  10. Revalidate process liveness and locks immediately before each deletion (when executing).
  11. Only rmdir (os.rmdir) is used to delete empty directories; never recursive delete.
  12. Track and report: before, eligible, skipped-live, skipped-nonempty, skipped-young, errors, remaining.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import stat
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

if sys.platform == "win32":
    try:
        import ctypes
        from ctypes import wintypes

        _shlwapi = ctypes.WinDLL("shlwapi", use_last_error=True)
        _shlwapi.PathIsDirectoryEmptyW.argtypes = [wintypes.LPCWSTR]
        _shlwapi.PathIsDirectoryEmptyW.restype = wintypes.BOOL

        def _win_is_dir_empty(path_str: str) -> bool:
            try:
                return bool(_shlwapi.PathIsDirectoryEmptyW(path_str))
            except Exception:
                return False

        TH32CS_SNAPPROCESS = 0x00000002
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", wintypes.LONG),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260),
            ]

        _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        _kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        _kernel32.Process32FirstW.restype = wintypes.BOOL
        _kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
        _kernel32.Process32NextW.restype = wintypes.BOOL
        _kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
        _kernel32.CloseHandle.restype = wintypes.BOOL
        _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        _kernel32.OpenProcess.restype = wintypes.HANDLE
        _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        _kernel32.GetProcessTimes.restype = wintypes.BOOL
        _kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    except Exception:
        _win_is_dir_empty = None
        _kernel32 = None
else:
    _win_is_dir_empty = None
    _kernel32 = None
# Safety regexes: exact .artifact-id-<digits> and published output <id>.<tool>.log
MARKER_REGEX = re.compile(r"^\.artifact-id-(\d+)$")
OUTPUT_REGEX = re.compile(r"^(\d+)\..*\.log$")

# Windows file attribute constants
FILE_ATTRIBUTE_REPARSE_POINT = 0x0400


@dataclass
class CleanupMetrics:
    total_markers_seen: int = 0
    eligible_markers: int = 0
    skipped_live: int = 0
    skipped_locked: int = 0
    skipped_nonempty: int = 0
    skipped_young: int = 0
    skipped_reparse: int = 0
    skipped_tail: int = 0
    errors: int = 0
    deleted: int = 0
    remaining: int = 0
    sessions_scanned: int = 0
    sessions_skipped_live: int = 0
    error_details: list[str] = field(default_factory=list)


def is_reparse_point(path: str | Path) -> bool:
    """Return True if the path exists and is a reparse point or symbolic link."""
    try:
        st = os.lstat(path)
        if getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT:
            return True
        return os.path.islink(path)
    except FileNotFoundError:
        return False
    except Exception:
        # If error is not ENOENT (e.g. permission error), fail closed as unsafe
        return True


def is_directory_empty(path: str | Path) -> bool:
    """Return True if directory has zero entries and is not a reparse point."""
    str_path = str(path)
    if is_reparse_point(str_path):
        return False
    if _win_is_dir_empty is not None:
        return _win_is_dir_empty(str_path)
    try:
        with os.scandir(str_path) as it:
            for _ in it:
                return False
        return True
    except Exception:
        return False


def is_potential_veyyon_executable(proc_name: str | None) -> bool:
    """Return True if the executable name could host Veyyon (bun, node, veyyon)."""
    if not proc_name:
        return False
    name = proc_name.lower().strip()
    if name.endswith(".exe"):
        name = name[:-4]
    return (
        name in ("bun", "node", "veyyon")
        or "veyyon" in name
        or name.startswith("bun")
        or name.startswith("node")
    )

def get_native_process_identities() -> frozenset[tuple[int, int, str]] | None:
    """Cheaply enumerate native process identities (PID, creation time, lowercased executable name).

    Uses CreateToolhelp32Snapshot and GetProcessTimes on Windows.
    Returns None if enumeration fails or is unsupported.
    """
    if sys.platform != "win32" or _kernel32 is None:
        return None
    try:
        snap = _kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if not snap or snap == wintypes.HANDLE(-1).value:
            return None
        identities = set()
        times = [wintypes.FILETIME() for _ in range(4)]
        byref_times = [ctypes.byref(t) for t in times]
        try:
            pe = PROCESSENTRY32W()
            pe.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            if _kernel32.Process32FirstW(snap, ctypes.byref(pe)):
                while True:
                    pid = pe.th32ProcessID
                    name = pe.szExeFile
                    if is_potential_veyyon_executable(name):
                        h = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
                        if h:
                            try:
                                if _kernel32.GetProcessTimes(h, *byref_times):
                                    ctime = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
                                    identities.add((pid, ctime, name.lower()))
                                else:
                                    identities.add((pid, 0, name.lower()))
                            finally:
                                _kernel32.CloseHandle(h)
                        else:
                            # Process could not be opened with limited query rights.
                            # Retain with -1 creation time so presence is tracked.
                            identities.add((pid, -1, name.lower()))
                    if not _kernel32.Process32NextW(snap, ctypes.byref(pe)):
                        break
            return frozenset(identities)
        finally:
            _kernel32.CloseHandle(snap)
    except Exception:
        return None


class ProcessSnapshotCache:
    """Reusable live-process snapshot keyed by native Windows process-set fingerprint.

    Cheaply re-enumerates native process identities (PID + creation time) before deletion.
    If native enumeration is unavailable or the process identity set changes, it refreshes
    the Win32_Process commandline snapshot and re-evaluates liveness.
    """

    def __init__(self) -> None:
        self.fingerprint: frozenset[tuple[int, int, str]] | None = None
        self.command_lines: list[str] = []
        self.active_tokens: set[str] = set()
        self.is_valid: bool = False
        self.refresh_count: int = 0

    def refresh(self) -> bool:
        """Force refresh of Win32_Process command line snapshot."""
        success, cmdlines = get_live_process_command_lines()
        if not success:
            self.is_valid = False
            self.command_lines = []
            self.active_tokens = set()
            self.fingerprint = None
            return False
        self.command_lines = cmdlines
        self.active_tokens = extract_active_session_identifiers(cmdlines)
        self.fingerprint = get_native_process_identities()
        self.is_valid = True
        self.refresh_count += 1
        return True

    def ensure_current(self) -> bool:
        """Re-evaluate native process identity set. Refresh Win32 snapshot if set changed.

        Returns True if snapshot is valid and current, False if refresh failed.
        """
        if not self.is_valid:
            return self.refresh()

        current_fp = get_native_process_identities()
        # If native enumeration is unavailable or fingerprint changed, must refresh
        if current_fp is None or self.fingerprint is None or current_fp != self.fingerprint:
            return self.refresh()

        return True


def get_live_process_command_lines() -> tuple[bool, list[str]]:
    """Enumerate running process command lines via hidden PowerShell and Win32_Process.

    Returns (success, list_of_command_lines).
    If enumeration fails or is uncertain, success is False and caller MUST fail closed.
    Excludes the current cleanup process's own PID to avoid self-referential false positives.

    Fails closed globally if any potential Veyyon executable (bun, node, veyyon) has an
    unreadable or empty CommandLine. Ordinary system processes with null command lines
    (e.g. System, Registry, svchost.exe) do not block since they cannot host Veyyon.
    """
    current_pid = os.getpid()
    cmd = [
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
        "Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress",
    ]
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if res.returncode != 0:
            return False, []
        data = json.loads(res.stdout)
        if isinstance(data, dict):
            data = [data]
        elif not isinstance(data, list):
            return False, []

        cmdlines: list[str] = []
        for item in data:
            if isinstance(item, dict):
                proc_pid = item.get("ProcessId")
                if proc_pid == current_pid:
                    continue
                proc_name = item.get("Name")
                cmdline = item.get("CommandLine")
                if isinstance(cmdline, str) and cmdline.strip():
                    cmdlines.append(cmdline)
                else:
                    # CommandLine is missing, None, or empty.
                    # If this executable could host Veyyon (or Name is missing/unreadable), we MUST fail closed!
                    if not proc_name or is_potential_veyyon_executable(proc_name):
                        return False, []
                    # Otherwise ordinary system null command line does not block.
                    continue
        return True, cmdlines
    except Exception:
        return False, []


def extract_active_session_identifiers(command_lines: list[str]) -> set[str]:
    """Extract session paths and unique identifiers referenced in command lines.

    Normalizes paths to lower-case with forward slashes for robust matching.
    """
    active_tokens: set[str] = set()
    for cmd in command_lines:
        cmd_lower = cmd.lower().replace("\\", "/")
        # Match ULID/UUID/Snowflake patterns typical for session IDs:
        # e.g. 2026-11-06T13-11-46-763Z_01a1b0fc-994b-7563-88b1-82973b42b844
        # or 01a[0-9a-f]{20,}
        for token in re.findall(r"01a[0-9a-f]{20,}", cmd_lower):
            active_tokens.add(token)

        # Match paths containing /sessions/
        for m in re.finditer(r"([a-z]:/[^\"\s]+/sessions/[^\"\s]+)", cmd_lower):
            path_part = m.group(1).rstrip("/\\")
            active_tokens.add(path_part)
            # Add basename
            active_tokens.add(os.path.basename(path_part).replace(".jsonl", ""))

    return active_tokens


def is_session_directory_live(
    session_dir: Path,
    active_tokens: set[str],
    command_lines: list[str],
) -> bool:
    """Check if session directory is actively referenced by any running process."""
    dir_name_lower = session_dir.name.lower()
    dir_path_lower = str(session_dir.resolve()).lower().replace("\\", "/")

    # Check direct token match
    for token in active_tokens:
        if token in dir_name_lower or token in dir_path_lower:
            return True

    # Check if session directory path is present in any command line substring
    for cmd in command_lines:
        cmd_lower = cmd.lower().replace("\\", "/")
        if dir_name_lower in cmd_lower or dir_path_lower in cmd_lower:
            return True

    return False


def is_pid_alive(pid: int) -> bool:
    """Check if process with given PID is currently alive.

    On Windows, uses kernel32 OpenProcess with SYNCHRONIZE access.
    On POSIX, uses os.kill(pid, 0).
    Fails closed (returns True) on permission errors or uncertainty.
    """
    if not isinstance(pid, int) or pid <= 0:
        return False

    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel32.WaitForSingleObject.restype = wintypes.DWORD
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL

            SYNCHRONIZE = 0x00100000
            handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
            if not handle:
                err = ctypes.get_last_error()
                # 87 = ERROR_INVALID_PARAMETER (PID does not exist)
                if err == 87:
                    return False
                # Any other error (e.g. Access Denied 5): fail closed, process exists
                return True
            try:
                res = kernel32.WaitForSingleObject(handle, 0)
                # WAIT_TIMEOUT (258 != 0): process is running
                # WAIT_OBJECT_0 (0): process has terminated
                return res != 0
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return True

    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return True


def is_lock_active(lock_path: Path) -> bool:
    """Evaluate whether a lock path (file or directory) represents an active lock.

    Follows repository @veyyon/utils/file-lock protocol:
      - Valid lock directory holds an 'info' file containing JSON:
        {"version": 1, "pid": int, "token": str, ...}
      - If PID is alive, lock is active (held).
      - If lock exists but is unreadable, invalid, corrupted, or cannot be verified,
        it counts as LIVE (fail closed).
      - Reparse points count as LIVE (unsafe).
    """
    try:
        if is_reparse_point(lock_path):
            return True
        if not lock_path.exists():
            return False

        if lock_path.is_dir():
            info_file = lock_path / "info"
            if not info_file.exists():
                # Lock directory exists but info is missing (fresh candidate/creation or unreadable)
                # Existing locks unreadable count live.
                return True

            try:
                content = info_file.read_text(encoding="utf-8")
                data = json.loads(content)
                if not isinstance(data, dict):
                    return True
                version = data.get("version")
                pid = data.get("pid")
                token = data.get("token")
                if version != 1 or not isinstance(pid, int) or not isinstance(token, str):
                    # Invalid/unrecognized format: fail closed
                    return True

                # If the owner PID is alive, lock is active.
                if is_pid_alive(pid):
                    return True

                # Owner PID is proven dead.
                # Check if there is an active transition lock alongside it.
                trans = lock_path.with_name(f"{lock_path.name}.transition")
                if trans.exists() and is_lock_active(trans):
                    return True

                return False
            except Exception:
                # Existing locks unreadable count live.
                return True

        # Plain file lock: unreadable or generic file locks count live.
        return True
    except Exception:
        # Fail closed on any I/O or permission error
        return True


def is_session_directory_locked(session_dir: Path, check_internal: bool = True) -> bool:
    """Check if session directory or its parent holds any active file locks.

    Checks:
      - Sibling .lock directories/files in repository @veyyon/utils/file-lock format:
        <name>.lock, <name>.lock.transition, <name>.jsonl.lock, <name>.jsonl.lock.transition
      - Candidate locks matching .<name>*.candidate-* in parent directory
      - Direct known internal lock paths in session_dir:
        .lock, .lock.transition, artifacts.lock, session.lock
      - If check_internal is True, scans session_dir entries ending in .lock,
        .lock.transition, or containing .candidate-
      - Unreadable existing locks count as live (fail-closed).
    """
    try:
        parent = session_dir.parent
        name = session_dir.name

        # Sibling lock paths for session directory and transcript
        sibling_lock_candidates = [
            parent / f"{name}.lock",
            parent / f"{name}.lock.transition",
            parent / f"{name}.jsonl.lock",
            parent / f"{name}.jsonl.lock.transition",
        ]
        for lock_cand in sibling_lock_candidates:
            if lock_cand.exists() or is_reparse_point(lock_cand):
                if is_lock_active(lock_cand):
                    return True

        # Check candidate locks in parent directory
        if parent.exists() and not is_reparse_point(parent):
            try:
                for entry in parent.iterdir():
                    en_name = entry.name
                    if (en_name.startswith(f".{name}") or en_name.startswith(name)) and (
                        ".candidate-" in en_name or en_name.endswith(".lock") or en_name.endswith(".lock.transition")
                    ):
                        if is_lock_active(entry):
                            return True
            except Exception:
                return True

        # Direct internal lock candidates
        internal_candidates = [
            session_dir / ".lock",
            session_dir / ".lock.transition",
            session_dir / "artifacts.lock",
            session_dir / "session.lock",
        ]
        for lock_cand in internal_candidates:
            if lock_cand.exists() or is_reparse_point(lock_cand):
                if is_lock_active(lock_cand):
                    return True

        # If check_internal is True, scan entries inside session_dir
        if check_internal and session_dir.exists() and not is_reparse_point(session_dir):
            with os.scandir(session_dir) as it:
                for entry in it:
                    en_name = entry.name
                    if (
                        en_name.endswith(".lock")
                        or en_name.endswith(".lock.transition")
                        or ".candidate-" in en_name
                    ):
                        if is_lock_active(Path(entry.path)):
                            return True
    except Exception:
        # Failing closed on uncertainty
        return True

    return False

def has_active_direct_locks(session_dir: Path) -> bool:
    """Cheap non-recursive lock check for session directory.

    Checks direct candidate locks (siblings and direct known internal lock paths)
    without scanning directories or performing recursive searches.
    """
    return is_session_directory_locked(session_dir, check_internal=False)


def find_session_directories(profiles_root: Path) -> list[Path]:
    """Find all candidate session artifact directories under profiles/*/agent/sessions/**."""
    session_dirs: list[Path] = []
    if not profiles_root.exists() or is_reparse_point(profiles_root):
        return session_dirs

    try:
        profiles = [p for p in profiles_root.iterdir() if p.is_dir() and not is_reparse_point(p)]
    except Exception:
        return session_dirs

    for profile in profiles:
        sessions_root = profile / "agent" / "sessions"
        if not sessions_root.exists() or is_reparse_point(sessions_root):
            continue

        try:
            scope_dirs = [d for d in sessions_root.iterdir() if d.is_dir() and not is_reparse_point(d)]
        except Exception:
            continue

        for scope_dir in scope_dirs:
            try:
                for item in scope_dir.iterdir():
                    if item.is_dir() and not is_reparse_point(item):
                        # Artifact directories sit beside <id>.jsonl or have session ID format
                        session_dirs.append(item)
            except Exception:
                continue

    return session_dirs


def process_session_markers(
    session_dir: Path,
    metrics: CleanupMetrics,
    cutoff_time: float,
    active_tokens: set[str],
    command_lines: list[str],
    execute: bool,
    snapshot_cache: ProcessSnapshotCache | None = None,
    max_deletions: int | None = None,
) -> None:
    """Scan and safely process marker directories in a single session directory."""
    metrics.sessions_scanned += 1

    # 1. Check if session directory is live
    if is_session_directory_live(session_dir, active_tokens, command_lines):
        metrics.sessions_skipped_live += 1
        try:
            with os.scandir(session_dir) as it:
                for entry in it:
                    if entry.name.startswith(".artifact-id-") and MARKER_REGEX.match(entry.name):
                        metrics.total_markers_seen += 1
                        metrics.skipped_live += 1
                        metrics.remaining += 1
        except Exception as ex:
            metrics.errors += 1
            metrics.error_details.append(f"Scan error in live session {session_dir}: {ex}")
        return

    # 2. Check if session directory is locked via sibling and direct internal locks (cheap candidate check)
    if has_active_direct_locks(session_dir):
        metrics.sessions_skipped_live += 1
        try:
            with os.scandir(session_dir) as it:
                for entry in it:
                    if entry.name.startswith(".artifact-id-") and MARKER_REGEX.match(entry.name):
                        metrics.total_markers_seen += 1
                        metrics.skipped_locked += 1
                        metrics.remaining += 1
        except Exception as ex:
            metrics.errors += 1
            metrics.error_details.append(f"Scan error in locked session {session_dir}: {ex}")
        return

    # 3. Scan directory entries within this inactive, unlocked session.
    # Tracks max published artifact ID from N.*.log to preserve all tail markers (failed/crashed IDs).
    # Old allocator resumes from max published N.*.log only, so markers > max_published_id MUST remain.
    max_published_id = -1
    candidates: list[tuple[int, str]] = []

    try:
        with os.scandir(session_dir) as it:
            for entry in it:
                en_name = entry.name
                # Guard against any lock created inside session_dir
                if en_name.endswith(".lock") or en_name.endswith(".lock.transition") or ".candidate-" in en_name:
                    if is_lock_active(Path(entry.path)):
                        metrics.sessions_skipped_live += 1
                        total_pending = len(candidates)
                        metrics.skipped_locked += total_pending
                        metrics.remaining += total_pending
                        candidates.clear()
                        for rem_entry in it:
                            rem_name = rem_entry.name
                            if rem_name.startswith(".artifact-id-") and MARKER_REGEX.match(rem_name):
                                metrics.total_markers_seen += 1
                                metrics.skipped_locked += 1
                                metrics.remaining += 1
                        return

                # Track published artifact output log files
                out_match = OUTPUT_REGEX.match(en_name)
                if out_match:
                    pub_id = int(out_match.group(1))
                    if pub_id > max_published_id:
                        max_published_id = pub_id
                    continue

                if not en_name.startswith(".artifact-id-"):
                    continue

                marker_match = MARKER_REGEX.match(en_name)
                if not marker_match:
                    continue

                metrics.total_markers_seen += 1
                marker_id = int(marker_match.group(1))
                try:
                    st = entry.stat(follow_symlinks=False)
                except Exception as ex:
                    metrics.errors += 1
                    metrics.remaining += 1
                    metrics.error_details.append(f"stat error on {entry.path}: {ex}")
                    continue

                # Reparse point check
                if getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT:
                    metrics.skipped_reparse += 1
                    metrics.remaining += 1
                    continue

                if not stat.S_ISDIR(st.st_mode):
                    metrics.skipped_nonempty += 1
                    metrics.remaining += 1
                    continue

                # Age requirement (>24h default)
                if st.st_mtime >= cutoff_time:
                    metrics.skipped_young += 1
                    metrics.remaining += 1
                    continue

                candidates.append((marker_id, entry.path))
    except Exception as ex:
        metrics.errors += 1
        metrics.error_details.append(f"Failed scanning {session_dir}: {ex}")
        return

    # Step 4: Separate tail markers from eligible candidates.
    # Markers with ID > max_published_id MUST be preserved for old allocator rollback safety.
    eligible_candidates: list[tuple[int, str]] = []
    for marker_id, marker_path_str in candidates:
        if marker_id > max_published_id:
            metrics.skipped_tail += 1
            metrics.remaining += 1
        else:
            eligible_candidates.append((marker_id, marker_path_str))

    if not eligible_candidates:
        return

    # Step 5: Check emptiness and perform deletion for eligible non-tail markers.
    check_fn = _win_is_dir_empty if _win_is_dir_empty is not None else is_directory_empty
    for m_id, m_path_str in eligible_candidates:
        if not check_fn(m_path_str):
            metrics.skipped_nonempty += 1
            metrics.remaining += 1
            continue

        metrics.eligible_markers += 1

        if not execute:
            metrics.remaining += 1
            continue

        if max_deletions is not None and metrics.deleted >= max_deletions:
            metrics.remaining += 1
            continue

        marker_path = Path(m_path_str)
        if snapshot_cache is not None:
            if not snapshot_cache.ensure_current():
                metrics.errors += 1
                metrics.remaining += 1
                metrics.error_details.append(f"Aborting deletion for {marker_path}: process enumeration failed")
                continue
            fresh_cmdlines = snapshot_cache.command_lines
            fresh_tokens = snapshot_cache.active_tokens
        else:
            success, fresh_cmdlines = get_live_process_command_lines()
            if not success:
                metrics.errors += 1
                metrics.remaining += 1
                metrics.error_details.append(f"Aborting deletion for {marker_path}: process enumeration failed")
                continue
            fresh_tokens = extract_active_session_identifiers(fresh_cmdlines)

        if is_session_directory_live(session_dir, fresh_tokens, fresh_cmdlines) or has_active_direct_locks(session_dir):
            metrics.skipped_live += 1
            metrics.remaining += 1
            continue
        if not is_directory_empty(marker_path):
            metrics.skipped_nonempty += 1
            metrics.remaining += 1
            continue

        try:
            os.rmdir(marker_path)
            metrics.deleted += 1
        except Exception as ex:
            metrics.errors += 1
            metrics.remaining += 1
            metrics.error_details.append(f"Failed rmdir {marker_path}: {ex}")
def run_cleanup(
    profiles_root: Path,
    min_age_hours: float = 24.0,
    execute: bool = False,
    single_session: Path | None = None,
    max_deletions: int | None = None,
) -> CleanupMetrics:
    metrics = CleanupMetrics()

    # Step 1: Initialize reusable process snapshot cache
    snapshot_cache = ProcessSnapshotCache()
    if not snapshot_cache.refresh():
        metrics.errors += 1
        metrics.error_details.append("Process enumeration failed or uncertain. Failing closed without processing.")
        return metrics

    cmdlines = snapshot_cache.command_lines
    active_tokens = snapshot_cache.active_tokens
    now = time.time()
    cutoff_time = now - (min_age_hours * 3600.0)

    # Step 2: Determine session directories
    if single_session:
        session_dirs = [single_session]
    else:
        session_dirs = find_session_directories(profiles_root)

    # Step 3: Process markers per session
    total_dirs = len(session_dirs)
    for idx, session_dir in enumerate(session_dirs, 1):
        if idx % 5 == 0 or idx == 1 or idx == total_dirs:
            print(f"[Progress] ({idx}/{total_dirs}) {session_dir.parent.name}/{session_dir.name} (markers seen: {metrics.total_markers_seen})...", file=sys.stderr, flush=True)
        process_session_markers(
            session_dir,
            metrics,
            cutoff_time,
            active_tokens,
            cmdlines,
            execute,
            snapshot_cache=snapshot_cache,
            max_deletions=max_deletions,
        )
        if max_deletions is not None and metrics.deleted >= max_deletions:
            break

    return metrics


def main() -> int:
    parser = argparse.ArgumentParser(description="Guarded cleanup of empty .artifact-id-* markers.")
    parser.add_argument(
        "--profiles-root",
        type=Path,
        default=Path("C:/Users/wkiri/.veyyon/profiles"),
        help="Root profiles directory (default: C:/Users/wkiri/.veyyon/profiles)",
    )
    parser.add_argument(
        "--session-dir",
        type=Path,
        default=None,
        help="Target a single session directory instead of scanning all profiles.",
    )
    parser.add_argument(
        "--min-age-hours",
        type=float,
        default=24.0,
        help="Minimum age in hours to qualify for cleanup (default: 24.0)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Dry-run mode (default: True)",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        default=False,
        help="Perform real deletion with strict pre-deletion guards. Default is dry-run.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        default=False,
        help="Output metrics as JSON.",
    )
    parser.add_argument(
        "--max-deletions",
        type=int,
        default=None,
        help="Maximum number of directories to delete in this run (optional bounded chunks).",
    )

    args = parser.parse_args()
    execute_mode = args.execute

    metrics = run_cleanup(
        profiles_root=args.profiles_root,
        min_age_hours=args.min_age_hours,
        execute=execute_mode,
        single_session=args.session_dir,
        max_deletions=args.max_deletions,
    )
    if args.json:
        out = {
            "mode": "execute" if execute_mode else "dry-run",
            "min_age_hours": args.min_age_hours,
            "sessions_scanned": metrics.sessions_scanned,
            "sessions_skipped_live": metrics.sessions_skipped_live,
            "total_markers_seen": metrics.total_markers_seen,
            "eligible_markers": metrics.eligible_markers,
            "skipped_live": metrics.skipped_live,
            "skipped_locked": metrics.skipped_locked,
            "skipped_nonempty": metrics.skipped_nonempty,
            "skipped_young": metrics.skipped_young,
            "skipped_reparse": metrics.skipped_reparse,
            "skipped_tail": metrics.skipped_tail,
            "errors": metrics.errors,
            "deleted": metrics.deleted,
            "remaining": metrics.remaining,
            "error_details": metrics.error_details[:10],
        }
        print(json.dumps(out, indent=2))
    else:
        mode_str = "EXECUTE" if execute_mode else "DRY-RUN"
        print(f"=== Artifact Marker Cleanup ({mode_str}) ===")
        print(f"Min age threshold:       {args.min_age_hours} hours")
        print(f"Sessions scanned:        {metrics.sessions_scanned}")
        print(f"Sessions skipped (live): {metrics.sessions_skipped_live}")
        print(f"Total markers seen:      {metrics.total_markers_seen}")
        print(f"Eligible markers:        {metrics.eligible_markers}")
        print(f"Skipped live process:    {metrics.skipped_live}")
        print(f"Skipped locked:          {metrics.skipped_locked}")
        print(f"Skipped young (<{args.min_age_hours}h):  {metrics.skipped_young}")
        print(f"Skipped non-empty:       {metrics.skipped_nonempty}")
        print(f"Skipped reparse points:  {metrics.skipped_reparse}")
        print(f"Skipped tail markers:    {metrics.skipped_tail}")
        print(f"Errors:                  {metrics.errors}")
        print(f"Deleted:                 {metrics.deleted}")
        print(f"Remaining:               {metrics.remaining}")
        if metrics.error_details:
            print("\nErrors encountered:")
            for err in metrics.error_details[:10]:
                print(f"  - {err}")

    return 1 if metrics.errors > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
